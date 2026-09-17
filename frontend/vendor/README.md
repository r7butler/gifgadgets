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
