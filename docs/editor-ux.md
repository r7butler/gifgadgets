# Editor UX changes

## Behavior

- Shared dialogs move focus inside on opening, keep Tab inside, and restore focus
  on closing. Escape closes dismissible dialogs without triggering download or
  discard actions. Editor shortcuts respect buttons, inputs, editable content,
  and open dialogs.
- GIF decoding runs in a worker and transfers completed pixel buffers to the
  editor. A yielding main-thread fallback handles unavailable workers. Progress
  shows decoded/total frames. Disposal, transparency, dimensions and timing are
  preserved. Temporary pixel buffers are reused and redundant copies removed.
- The GIF and image editors save recoverable drafts in local IndexedDB after
  edits. Frame data is written incrementally and only rewritten when frames
  change; caption, tracking, crop, adjustment, and export settings save separately.
  Reload offers Restore/Discard. Explicit new-file handoffs take precedence.
- Starting New and discarding a draft finish deletion before dismissing the
  relevant UI. A pending save is cancelled between frames when superseded. Failed
  media saves clean up partial data and back off instead of repeatedly filling
  storage. Navigation warnings apply only to edits not yet saved in the draft.
- Analytics starts only after Accept, remembers Accept/Reject, and can be changed
  through Analytics choices in the navigation/footer or editor menu. Storage
  restrictions do not prevent making a choice for the current page. The old
  ambiguous "Got it" value is not treated as acceptance.

## Scope and limits

There is no new GIF size or decoded-memory cutoff, no automatic downscaling, and
no tracker upload confirmation. The existing file/video limits remain unchanged.
The editor still retains full decoded frames, so extremely large animations can
exhaust available memory. Workers improve responsiveness, not available RAM.

Recovery covers one draft per shared editor URL, not the standalone resizer,
cropper, maker, or video converter. Draft saving is best effort: browser storage
limits, eviction, or a crash before saving completes can still lose work. Multiple
tabs using the same editor URL share that draft slot.

## Validation

Browser coverage includes keyboard operation, worker/fallback compositing and
disposal, a 1024×1024/34-frame animation (~136 MiB decoded), incremental draft
storage with no media rewrite for a caption edit, restoration of pixel edits and
tracking metadata, storage denial, New/Discard, image export controls, analytics
choices, and mobile layout. Existing browser regression coverage also passes.

The local Playwright WebKit build reports `UnknownError` when storing Blob/File
objects in IndexedDB in the pre-existing landing-page handoff. Its precedence test
stubs that handoff I/O and exercises real editor initialization and decoding.
Chromium and Firefox test the full IndexedDB file handoff. All three browsers test
the new draft storage and restoration directly, using ImageData rather than Files.

No backend changes, commit, or production deployment are part of this batch.
