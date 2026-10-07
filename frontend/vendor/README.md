# Vendored third-party libraries

Self-hosted rather than loaded from a CDN. Three reasons:

1. **Availability** — a CDN outage or an unpublished package silently breaks every
   GIF tool, and nothing in the smoke test would catch it.
2. **Supply chain** — these scripts run with full access to the user's file. The
   site's privacy claim depends on them being the code we think they are.
3. **Performance** — no extra DNS and TLS handshakes to three other origins.

`SHA256SUMS` pins what was fetched, in the same spirit as
`terraform/ffmpeg-layer.sha256`. Verify with:

    cd frontend/vendor && shasum -a 256 -c SHA256SUMS

| File | Upstream |
| --- | --- |
| `gif.js` | https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.js |
| `gif.worker.js` | https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js |
| `omggif.js` | https://unpkg.com/omggif@1.0.10/omggif.js |
| `heic2any.min.js` | https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js |

`gif.js` 0.2.0 is unmaintained upstream, so there is no update treadmill here.
If the encoder is ever replaced, replace these files and re-run the checksum.

**Note:** `heic2any.min.js` is 1.3 MB and is currently loaded synchronously on six
pages, though it is only needed when a HEIC file is selected. Loading it on demand
would remove that from the critical path.

Video tools additionally use the pinned single-thread FFmpeg core in `ffmpeg/`.
See `ffmpeg/README.md` for source, license, loading behavior and version details.

## Caption fonts

`fonts/` holds the web fonts in the caption font menus. Everything else in those menus
is a system font. `caption-fonts.js` registers these files and loads them before a
caption draws, so preview and export both use the real face.

| Files | Upstream | License |
| --- | --- | --- |
| `fonts/tiktok-sans-*.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/tiktok-sans@5.3.0/files/ | `fonts/OFL-TikTokSans.txt` |
| `fonts/montserrat-*.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/montserrat@5.3.0/files/ | `fonts/OFL-Montserrat.txt` |

Each family ships the `latin` and `latin-ext` subsets at weights 400 and 700, which
are the weights the Bold toggle switches between. The SIL Open Font License allows
self-hosting and redistribution as long as the license file travels with the fonts.

Montserrat stands in for Gotham, which is a commercial Hoefler&Co typeface that needs
a paid web license. If one is bought, add its files here and change the `FAMILIES`
entry in `caption-fonts.js` and the option in
`src/templates/partials/caption-font-options.html`.
