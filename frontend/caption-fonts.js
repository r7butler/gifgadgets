/* ==========================================================
   GifCaption – Caption Fonts

   Self-hosted web fonts offered in the caption font menus next
   to the system fonts. A canvas paints with whatever font has
   loaded at the moment it draws and never repaints, so these
   fonts are loaded before captions use them: the preview redraws
   when they arrive, and exports wait for them.

   Files, sources and licenses: vendor/fonts, vendor/README.md.

   Depends on: editor-state.js (GC namespace, state)
   ========================================================== */

(function () {
  'use strict';

  var state = GC.state;

  // Menu name → file prefix in vendor/fonts.
  var FAMILIES = {
    'TikTok Sans': 'tiktok-sans',
    'Montserrat': 'montserrat',
  };

  // The two weights the Bold toggle switches between.
  var WEIGHTS = [400, 700];

  // Google's latin / latin-ext split, as published by Fontsource.
  var SUBSETS = [
    { name: 'latin', range: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
    { name: 'latin-ext', range: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ];

  // 'Family|weight' → its FontFaces. Registering only declares the face;
  // nothing downloads until a caption uses it.
  var faces = {};
  if (typeof FontFace !== 'undefined' && document.fonts) {
    Object.keys(FAMILIES).forEach(function (family) {
      WEIGHTS.forEach(function (weight) {
        faces[family + '|' + weight] = SUBSETS.map(function (subset) {
          var face = new FontFace(family,
            'url(/vendor/fonts/' + FAMILIES[family] + '-' + subset.name + '-' + weight + '-normal.woff2) format("woff2")',
            { weight: String(weight), unicodeRange: subset.range });
          document.fonts.add(face);
          return face;
        });
      });
    });
  }

  /** Web-font faces that the captions and box bars currently draw with. */
  function facesInUse() {
    var styled = state.captions.concat([state.boxCaptionTop, state.boxCaptionBottom]);
    var used = [];
    styled.forEach(function (s) {
      if (!s) return;
      var weight = (s.fontWeight || 700) >= 700 ? 700 : 400;
      used = used.concat(faces[s.fontFamily + '|' + weight] || []);
    });
    return used;
  }

  /**
   * Start loading the caption fonts in use. Returns a promise that resolves
   * once they have all loaded, or null when none is outstanding. A face that
   * failed to load counts as done, and the canvas falls back to a system font.
   */
  GC.loadCaptionFonts = function () {
    var pending = facesInUse().filter(function (face) {
      return face.status === 'unloaded' || face.status === 'loading';
    });
    if (pending.length === 0) return null;
    return Promise.all(pending.map(function (face) {
      return face.load().catch(function () {});
    }));
  };

  var redrawQueued = false;

  /**
   * Called by the preview before it draws. If a caption font is still on its
   * way, that frame draws in a fallback font, so redraw once when it lands.
   */
  GC.redrawWhenCaptionFontsLoad = function () {
    var loading = GC.loadCaptionFonts();
    if (!loading || redrawQueued) return;
    redrawQueued = true;
    loading.then(function () {
      redrawQueued = false;
      GC.renderCurrentFrame();
    });
  };

})();
