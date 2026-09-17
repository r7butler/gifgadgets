# Utility page conventions — read before adding a tool

Written 2026-09-17 while finishing batch two. These are the conventions a new
utility page must follow, and the mistakes that were actually made so they are
not repeated.

## A page is not done until it is discoverable and wired

Batch two shipped with correct worker logic and correct page templates, and
every one of its five tools was still broken in a browser, because
`frontend/gif-utilities.js` had not been updated. It collected only the
batch-one controls:

```js
for (const key of ['rate','angle','axis','start','end'])
```

so `selection`, `extract`, `duration`, `compression`, `colors`, `width`,
`height`, `fit` and `background` were never sent to the worker. The pages
loaded and then reported "Use comma-separated frame numbers or ranges".

**A new tool is only finished when all five of these are done:**

1. `src/pages/<slug>/index.html` — extends `gif-utility.html`, sets
   `utility_slug`, `utility_title`, `utility_description`, `utility_help`,
   `utility_faq` (and `utility_path` if the URL differs from the slug).
2. Controls in `src/templates/gif-utility.html`.
3. Transform logic in `gif-utilities-worker.js`, or `gif-utilities-batch.js`
   with the slug added to `BATCH_TOOLS`.
4. **Option collection and result handling in `frontend/gif-utilities.js`.**
   This is the step that was missed. Any control the template renders must be
   read here and put on the options object.
5. **Sitemap entry in `src/templates/site/sitemap.xml` and a card in
   `src/templates/partials/gif-utility-cards.html`.** Batch two had neither,
   which for an indexing-driven batch defeats the point.

## Every utility page needs a FAQ

`gif-utility.html` supports `utility_faq`, a list of `{"q": ..., "a": ...}`.
One list produces both the visible FAQ and the `FAQPage` JSON-LD, so they
cannot drift. `tests/build/test_site.py` fails if a question appears in schema
but not on the page, if a question does not end in `?`, or if fewer than 20
pages carry FAQ schema.

Write answers as plain text, no HTML — Google wants plain text and the same
string goes into the schema. Aim for 4–6 genuinely useful questions grounded in
what the tool actually does, including its limits. Do not pad.

## Do not strip SEO content when converting a page to the shared template

Rewriting `/photo-converter/gif-to-png/` into the utility template cut it from
1069 words to 507, removed all 6 FAQ entries and dropped its `FAQPage` schema —
on the one page in the batch that was already indexed. It has been restored to
876 words and 6 questions. **Before converting an existing page, record its word
count, heading count, FAQ count and schema blocks, and do not ship a regression
on any of them.**

Its URL was deliberately kept. It is in Search Console, and splitting "gif to
png" and "extract gif frames" across two URLs would compete with itself. The
page sets `utility_path` so the canonical stays on the original address while
`utility_slug` (`extract-frames`) drives the controls.

## Testing

- `tests/gif-utilities.test.cjs` runs the worker under `node:vm`. Assert decoded
  output — frame counts, delays, dimensions, loop counts — not that a function
  returned. Arrays crossing the `vm` boundary need `Array.from` before a strict
  deep compare or the realm mismatch fails the assertion.
- `tests/e2e/gif-utilities.spec.js` must download the result and decode it.
  Checking that a button became visible does not prove the output is valid; the
  batch-two bug produced a visible UI and no working tool.
- Run all three browser projects. WebKit has caught real encoder differences
  before.
- Converting a page between UI patterns breaks the old spec. Move its coverage
  rather than deleting it.

## Brand and domain

Never hardcode the brand. `site.config.json` holds `site_brand`,
`site_brand_accent` and `site_watermark`; `build.py` exposes them and a build
test fails on any hardcoded name. AWS/Modal resource names, S3 buckets,
`project_slug` and the IndexedDB database names deliberately keep the old
`gifwidgets` prefix — they are invisible to users and search engines.
