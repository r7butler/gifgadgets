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

    def test_brand_accent_must_be_brand_suffix(self):
        env = {'SITE_BRAND': 'ExampleBrand', 'SITE_BRAND_ACCENT': 'Widgets'}
        with patch.dict(os.environ, env), self.assertRaises(ValueError):
            module.build()

if __name__ == '__main__':
    unittest.main()
