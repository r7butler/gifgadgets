"""Color tokens must keep text legible (WCAG AA, 4.5:1) in both themes."""
from pathlib import Path
import re
import unittest

CSS = (Path(__file__).resolve().parents[2] / 'frontend' / 'styles.css').read_text()
CATEGORIES = ['cat-gif', 'cat-image', 'cat-video', 'cat-photo-conv', 'cat-video-conv']
SURFACES = ['bg-base', 'bg-primary', 'bg-secondary']


def _tokens(selector):
    block = re.search(re.escape(selector) + r'\s*\{(.*?)\}', CSS, re.S).group(1)
    return dict(re.findall(r'--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;', block))


def _luminance(hex_color):
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    channels = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    r, g, b = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _ratio(a, b):
    hi, lo = sorted([_luminance(a), _luminance(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


class ContrastTests(unittest.TestCase):
    def _themes(self):
        light = _tokens(':root')
        return {'light': light, 'dark': {**light, **_tokens('[data-theme="dark"]')}}

    def test_body_text_is_legible_on_every_surface(self):
        for theme, t in self._themes().items():
            for text in ['text-primary', 'text-secondary', 'text-muted']:
                for surface in SURFACES:
                    with self.subTest(theme=theme, text=text, surface=surface):
                        self.assertGreaterEqual(_ratio(t[text], t[surface]), 4.5)

    def test_category_colors_work_as_text_and_as_button_fills(self):
        """Cards use them for "Open tool" links; landing pages fill CTAs with them."""
        for theme, t in self._themes().items():
            for cat in CATEGORIES:
                for surface in SURFACES:
                    with self.subTest(theme=theme, color=cat, surface=surface):
                        self.assertGreaterEqual(_ratio(t[cat], t[surface]), 4.5)
                with self.subTest(theme=theme, color=cat, label='on-cat'):
                    self.assertGreaterEqual(_ratio(t[cat], t['on-cat']), 4.5)


if __name__ == '__main__':
    unittest.main()
