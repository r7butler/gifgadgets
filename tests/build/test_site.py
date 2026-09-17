"""Build metadata checks without modifying deployed output."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.robotparser import RobotFileParser

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('site_build', ROOT / 'build.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SiteBuildTests(unittest.TestCase):
    def test_alternate_origin_and_crawler_rules(self):
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output), patch.dict(os.environ, {'SITE_URL': 'https://example.test/'}):
            module.build()
            root = Path(output)
            for file in root.rglob('*.html'):
                self.assertNotIn('https://gifwidgets.com', file.read_text())
            self.assertIn('https://example.test/gif-editor/', (root / 'sitemap.xml').read_text())
            robot = RobotFileParser()
            robot.parse((root / 'robots.txt').read_text().splitlines())
            self.assertTrue(robot.can_fetch('Mediapartners-Google', 'https://example.test/gif-editor/edit/'))
            self.assertFalse(robot.can_fetch('Googlebot', 'https://example.test/gif-editor/edit/'))
            self.assertTrue(robot.can_fetch('Googlebot', 'https://example.test/gif-editor/'))
            self.assertIn('content="noindex"', (root / 'gif-editor/edit/index.html').read_text())

    def test_invalid_origins(self):
        for origin in ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test', 'https://example.test/?x=1']:
            with self.subTest(origin=origin), patch.dict(os.environ, {'SITE_URL': origin}), self.assertRaises(ValueError):
                module.build()

    def test_animation_utilities_are_discoverable(self):
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output):
            module.build()
            root = Path(output)
            for slug in ['gif-speed', 'gif-loop', 'reverse-gif', 'rotate-gif', 'flip-gif', 'trim-gif']:
                self.assertIn('/' + slug + '/', (root / 'sitemap.xml').read_text())
                self.assertIn('/' + slug + '/', (root / 'index.html').read_text())
                page = (root / slug / 'index.html').read_text()
                self.assertIn('rel="canonical"', page)
                self.assertNotIn('noindex', page)
                self.assertIn('id="utility-file"', page)

    def test_bulk_image_utilities_are_discoverable(self):
        """A tool nobody can navigate to is not published, whatever the build says."""
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output):
            module.build()
            root = Path(output)
            sitemap = (root / 'sitemap.xml').read_text()
            home = (root / 'index.html').read_text()
            for slug in ['bulk-resize-images', 'bulk-compress-images',
                         'bulk-convert-images', 'image-contact-sheet']:
                self.assertIn('/' + slug + '/', sitemap)
                self.assertIn('/' + slug + '/', home)
                page = (root / slug / 'index.html').read_text()
                self.assertIn('rel="canonical"', page)
                self.assertNotIn('noindex', page)
                self.assertIn('id="utility-file"', page)
                self.assertIn('id="utility-apply"', page)
                self.assertIn('"FAQPage"', page)
            # The image section is the nav target, so the anchor has to exist.
            self.assertIn('id="image-tools"', home)
            self.assertIn('href="/#image-tools"', home)
            self.assertIn('>Image Tools<', home)

    def test_brand_is_templated(self):
        """No page may hardcode a brand name; the split logo must reassemble."""
        env = {'SITE_BRAND': 'ExampleBrand', 'SITE_BRAND_ACCENT': 'Brand',
               'SITE_WATERMARK': 'ExampleBrand.test'}
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output), patch.dict(os.environ, env):
            module.build()
            root = Path(output)
            for file in root.rglob('*.html'):
                text = file.read_text()
                self.assertNotIn('GifGadgets', text, f'hardcoded brand in {file.name}')
                self.assertNotIn('GifWidgets', text, f'stale brand in {file.name}')
            home = (root / 'index.html').read_text()
            self.assertIn('Example<span class="logo-accent">Brand</span>', home)
            self.assertIn('ExampleBrand.test', (root / 'gif-maker/edit/index.html').read_text())

    def test_faq_schema_matches_the_visible_faq(self):
        """Structured data and page text come from one list, so they cannot drift."""
        import json, re, html as html_mod
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output):
            module.build()
            root = Path(output)
            checked = 0
            for file in root.rglob('index.html'):
                text = file.read_text()
                faq = next((json.loads(b) for b in re.findall(
                    r'<script type="application/ld\+json">(.*?)</script>', text, re.S)
                    if '"FAQPage"' in b), None)
                if not faq:
                    continue
                questions = [q['name'] for q in faq['mainEntity']]
                # Every question in the schema must actually appear on the page.
                for question in questions:
                    self.assertIn(html_mod.escape(question, quote=False).replace('&#39;', "'"),
                                  text.replace('&#39;', "'"),
                                  f'{question!r} is in schema but not visible on {file}')
                    self.assertTrue(question.endswith('?'), f'not a question: {question!r}')
                self.assertEqual(len(questions), len(set(questions)), f'duplicate questions in {file}')
                checked += 1
            # Guard the guard: if the build stops emitting FAQs this must fail loudly.
            self.assertGreaterEqual(checked, 24, 'expected FAQ schema on far more pages')

    def test_gif_to_png_keeps_its_url_and_faq(self):
        """It became the frame extractor, but it is the one page already indexed."""
        with tempfile.TemporaryDirectory() as output, patch.object(module, 'OUTPUT_DIR', output):
            module.build()
            page = (Path(output) / 'photo-converter/gif-to-png/index.html').read_text()
            self.assertIn('canonical" href="https://gifgadgets.com/photo-converter/gif-to-png/"', page)
            self.assertIn('"FAQPage"', page)
            self.assertIn('Is GIF transparency preserved in the PNG?', page)

    def test_brand_accent_must_be_brand_suffix(self):
        env = {'SITE_BRAND': 'ExampleBrand', 'SITE_BRAND_ACCENT': 'Widgets'}
        with patch.dict(os.environ, env), self.assertRaises(ValueError):
            module.build()

if __name__ == '__main__':
    unittest.main()
