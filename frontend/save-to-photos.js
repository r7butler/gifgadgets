/* "Save to Photos" for finished exports. A download link saves to the Files app on
   iOS, and the share sheet is the only way a web page can reach the Photos library
   ("Save Image" / "Save Video"), so touch devices get both. Desktop browsers keep a
   single Download button: their share dialogs send files to apps, not to a library. */
(function () {
  'use strict';
  // Media the Photos apps accept. ZIPs and WebM never get the button.
  var PHOTO_TYPES = ['image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];

  function touchFirst() {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    // iPadOS reports a Mac user agent, and a fine pointer when a trackpad is attached.
    return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  }

  function supported(files) {
    if (!files.length || !touchFirst() || !navigator.canShare) return false;
    for (var i = 0; i < files.length; i++) {
      if (PHOTO_TYPES.indexOf(files[i].type) < 0) return false;
    }
    try { return navigator.canShare({ files: files }); } catch (_) { return false; }
  }

  function save(event) {
    var button = event.currentTarget, offer = button._gwSave;
    if (!offer || button._gwSharing) return;
    button._gwSharing = true;
    // Files only: on iOS, adding a title or text can drop "Save Image" from the sheet.
    navigator.share({ files: offer.files }).catch(function (error) {
      // Dismissing the sheet is a choice, not a failure.
      if (error && error.name !== 'AbortError' && offer.fallback) offer.fallback();
    }).then(function () { button._gwSharing = false; });
  }

  window.GWSave = {
    /** Show `button` for these files when this device can save them to Photos.
        `fallback` runs if the share sheet fails to open, and should download instead. */
    offer: function (button, files, fallback) {
      if (!button) return false;
      files = [].concat(files);
      button._gwSave = { files: files, fallback: fallback };
      if (!button._gwWired) { button._gwWired = true; button.addEventListener('click', save); }
      button.hidden = !supported(files);
      return !button.hidden;
    },
    /** A File for `blob`; the share sheet needs a name and a media type. */
    file: function (blob, name, type) {
      return new File([blob], name, { type: type || blob.type });
    },
  };
})();
