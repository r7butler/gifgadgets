# SEO implementation and operating checklist

This implements the first batch in the local SEOPLAN.md. No production deployment,
domain migration, new ad placements, or encoder replacement is included.

## Implemented

- `site.config.json` owns the public HTTPS origin. `build.py` feeds `site_url` into
  canonical links, Open Graph URLs, structured data, sitemap and robots templates.
  Python builds can override it with `SITE_URL`. Docker/deployment builds read the
  checked-in config. Defaults point at gifgadgets.com; `site_brand`,
  `site_brand_accent` and `site_watermark` carry the brand name.
- `src/templates/site/robots.txt` explicitly allows Mediapartners-Google and keeps
  generic crawler restrictions. Editor noindex metadata stays in place.
- Consent-gated task events cover the photo converters, GIF/image editors, resizer,
  cropper, maker and video converter. Tracking events use their own names.
- The tested WebKit build cannot encode WebP via canvas; WebP converters now
  report unsupported output there instead of downloading PNG with a WebP suffix.
- Converters and the image editor reject null blobs or unexpected output MIME types
  instead of labeling a fallback PNG as WebP/JPEG or reporting a successful export.
- Video conversion controls wait until frame-rate detection initializes the clip
  range. Detection now completes once, including short clips, blocked playback and
  missing frame callbacks; a 1.5-second fallback prevents indefinite waiting.
  A codec failure keeps controls disabled even after the fallback fires.
- The footer year follows the build year.
- Local workflow benchmarks generate deterministic animated GIF fixtures and save
  the resulting GIFs and timing JSON for review.

## Event contract

| Event | Meaning | Duration |
| --- | --- | --- |
| `file_accepted` | A file passed initial selection checks; maker uses the accepted batch | Approximately zero |
| `editor_ready` | Editing controls are ready; converters are ready to attempt conversion | Since file acceptance |
| `export_started` | Actual conversion/export began, not merely a download of cached output | Approximately zero |
| `export_completed` | Output blob is available | Since export start |
| `tool_failure` | An instrumented read/decode/encode/validation operation failed | Since load or export start |
| `tracking_started` | User initiated an AI tracking run | Approximately zero |
| `tracking_completed` | Tracking worker returned a result | Since tracking start |
| `tracking_failed` | Tracking worker failed or a run was superseded | Since tracking start |

Every event contains `tool_name`, `duration_ms`, `size_bucket`, and a query-free
`page_location`. Failures contain a fixed `failure_category`, never exception text.
Size buckets: `under_1mb`, `1_to_10mb`, `10_to_50mb`, `50mb_plus`, or `unknown`.
No filename, media, caption text, raw byte count or arbitrary event parameter is sent.
Export completion does not prove the browser saved the download or that the user
liked its quality. Benchmark downloads are measured separately.

Events are discarded unless the existing consent mechanism currently permits
analytics. They are not buffered/replayed after acceptance. Revocation suppresses
subsequent events, including a result from an already-running export. A mid-task
consent change can therefore produce a partial funnel. Consent and ad blockers mean
these counts are a sample, not all activity. Restored drafts can export with an
unknown size and without a fresh file-acceptance event. Browser crashes, tab closes,
and some unexpected library exceptions will appear as incomplete funnels rather
than categorized failures. Saving an individual GIF frame is not part of this initial
whole-output export funnel.

GA4 uses property `GifGadgets`, stream `https://gifgadgets.com`, measurement ID
`G-RF99W324GB`, declared once as `GA_ID` in `frontend/cookie-consent.js`. Register event-scoped dimensions `tool_name`,
`size_bucket`, `failure_category` and a `duration_ms` custom metric (milliseconds).
Use tool-specific funnels: maker accepts batches; photo converters initialize their
form before decoding. Do not combine their readiness times into one performance KPI.
Review GA4 enhanced measurement separately: automatic download/outbound-link events
can collect URL or filename parameters outside this fixed-schema instrumentation.
Turn off those automatic features if they would violate the intended data policy.

## Validation and benchmarks

Build and verify configuration:

```sh
python3 build.py
python3 -m unittest discover -s tests/build
npx playwright test --config=tests/e2e/playwright.config.js seo-funnel.spec.js
npm run benchmark -- --repeat-each=3
```

Python needs Jinja2; the existing Docker build remains supported. Browser tests need
the installed Playwright browsers. Existing GIF tools still load CDN dependencies.
The benchmark blocks Google Analytics requests and does not call tracking or sharing.

Each benchmark starts with file selection on an already-loaded tool page and ends
when Playwright saves the downloaded file. Page-load time is recorded separately.
Results include readiness time, export time, total task time, input/output sizes and
output dimensions. Artifacts are under `test-results/benchmarks/` (gitignored).
Do not run performance benchmarks concurrently with the regression suite.

The generated 320×180/24-frame and 640×360/60-frame animations exercise flat graphics,
not photographic palette quality. The existing 10×10 MP4 is a functional smoke
fixture, not a representative video workload. This establishes a reproducible local
baseline, not a win over ezgif, a large-file safety claim, or an encoder recommendation.
See [the recorded baseline](seo-benchmark-baseline.md) for median timings from 21
successful runs. The first run exposed a video initialization stall; the bounded readiness fix is the
first concrete export improvement. Keep encoder selection open.

For a competitor comparison, use the exact saved `input.gif` files on the matching
resize/crop/caption tools. Match dimensions, frame timing, loop setting, captions and
watermark settings. Start timing at file selection and stop after the actual download
finishes; record navigation/setup time separately, browser/device/network, settings,
three repetitions, output size and visual defects. Do not compare editing with a
bulk optimizer. Add consented, non-sensitive photographic/video samples and mobile
runs before judging quality, memory limits, or choosing an encoder. No user files
should be uploaded to a competitor without permission.

## What Robert needs to provide or do

1. **Search Console:** verify ownership of gifgadgets.com (or provide existing
   property access), submit `/sitemap.xml`, and export page/query performance and
   indexing reports. These determine the next tool cluster; no keyword demand or
   traffic forecast has been assumed.
2. **GA4:** confirm the existing property ID, provide access or create the custom
   definitions above, review enhanced measurement, then check live events after
   deployment. No analytics credentials belong in source control.
3. **AdSense:** confirm site approval, provide reporting access/exports and intended
   placement unit IDs for a separate ad experiment. Check crawler errors after
   deployment. Crawler access alone cannot generate ad revenue.
4. **AWS/Modal:** for deployment, use the existing AWS SSO/Modal access. For economics,
   provide billing/usage exports for the same date range as revenue. GPU cost per
   successful job must use server/provider success counts, including failed jobs,
   retries, cold starts and warmups in the cost numerator. Browser tracking duration
   is not billable GPU time and consented analytics is not the billing denominator.
5. **Rebrand:** select and acquire the domain when ready. Config centralization does
   not provision DNS/certificates/aliases, redirect the old site, or update the iOS
   app, brand copy and optional watermarks. Preserve old shared-media links.
6. **Representative media:** provide permission to use non-sensitive real-world
   samples for quality and competitor testing, or approve a licensed fixture set.

Read-only exports are sufficient to start analysis; never paste passwords, API
secrets, SSO tokens or private customer files into the repository.

## Still separate work

- Decoded-memory budgeting/downscaling across all GIF paths; workers alone do not
  bound RAM. No new safe maximum file size is claimed by this batch.
- Async backend tracking, operational success/cost reporting, and budget limits.
- Full converter qualification (HEIC, EXIF orientation, transparency and color fidelity).
- Demand-led new pages, connected editing workflows and a tracking demo/landing page.
- Actual AdSense placements, revenue/session experiments and production verification.
- Domain migration and distribution/launches.
