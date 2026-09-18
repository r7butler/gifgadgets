# Background tools debugging — September 18, 2026

User reports Find objects does not segment the clicked objects as expected.
Resolved the observed live failure: older Lambda code and missing configuration.
Validated browser clicks → API → SAM2 → returned mask → downloaded exports.
Asked asynchronously for the tested URL and exact observed result/error.

## Confirmed deployment and tests
- Deployed `backend/tracker/modal_app.py` to Modal workspace `r7butler` on Sep 18.
- App: https://modal.com/apps/r7butler/main/deployed/gifwidgets-tracker
- Functions: `segment_media` (L4 GPU), `segment_api` (CPU HTTP broker), existing `fastapi_app` (tracking).
- Broker: https://r7butler--gifwidgets-tracker-segment-api.modal.run
- All three unauthenticated broker routes correctly return 401.
- Real GPU smoke test using deployed image/segmentation code succeeded for synthetic
  PNG and three-frame GIF. Masks had 2732 selected pixels for PNG and
  [2732,2729,2729] for GIF at 128x96. This does not establish real-photo quality.
- Smoke run: https://modal.com/apps/r7butler/main/ap-SMTv1Nz73GDCFyFenkjwSz
- Temporary reproducible smoke script: `/tmp/gifwidgets-segmentation-smoke.py`.
- SAM2 emitted a warning that optional `_C` hole-filling extension is unavailable;
  inference otherwise worked.
- AWS `gifwidgets` SSO expired on earlier attempt. Default AWS profile is wrong
  for this project. No AWS/backend/frontend deployment has been performed by this agent.
- 20 targeted backend tests and 39 background-tool Playwright cases passed.
  Browser tests mock inference and do not prove the live AWS path works.

## Local review fixes since previous handoff
- Ignore obsolete worker messages/errors after termination.
- Ignore late polling responses after cancellation/file replacement.
- Added browser regression test for late status overwriting a new selection.
- These frontend fixes are local, not published.

## Next work
1. Inspect live page/API availability and request response statuses without logging signed URLs/secrets.
2. Reproduce with actual browser clicks (existing tests mostly use coordinate inputs).
3. Check model prompt coordinate mapping, multiple-object behavior, and output against real images.
4. Fix observed issues and test end to end; update this memory as work proceeds.

All prior implementation changes are uncommitted in the shared workspace; preserve them.

## Root cause found and repair underway
- Live `https://gifgadgets.com/remove-image-background/` exists, but POST
  `/api/segment/presign` returned 404 `{"error":"Not found"}`.
- AWS access recovered using `AWS_PROFILE=gifwidgets` (account 425750453898).
- Inspected `gifwidgets-api`: old LastModified Sep 17 00:58 UTC, no
  `MODAL_SEGMENTER_URL`. Existing Modal API key is configured. No disabled features.
- Re-ran all backend tests: 122 passed.
- Deployed updated Lambda code with `scripts/deploy-backend.sh`. Updated that script
  to print only deployment summary fields, avoiding disclosure of environment secrets.
- Setting only `MODAL_SEGMENTER_URL` via SDK with revision guard, preserving other
  environment variables. Terraform source already declares this same setting.
- Live browser PNG and GIF tests prepared at `/tmp/gifwidgets-live-background.cjs`:
  real mouse clicks on two objects, real API/upload/GPU/masks, downloaded alpha checks
  for both subjects and removed background; GIF frame/loop checks. No mocked inference.
- Pending exec session 56873 updates the setting then runs those browser tests.
- First live test after deployment failed with 502. CloudWatch identified missing
  `IP_HASH_SALT` (required by existing quota helper, not a SAM2 error).
- The salt exists in ignored `terraform/secrets.auto.tfvars`; applying that exact
  value to Lambda using SDK, preserving all other variables. Never print its value.
- Current exec session 36324 applies the salt and reruns the real browser tests.

## Completed live repair and validation
- Lambda code deployment and both environment settings completed successfully.
- Real production browser PNG and GIF tests passed. Mouse clicks selected two
  separate objects. PNG alpha at [subject 1, subject 2, background] = [255,255,0].
  GIF had that same alpha result on every frame, with 3 frames and loop count 2.
- Artifacts: `/tmp/remove-image-background-live.png` (UI screenshot),
  `/tmp/remove-image-background-live-result.png`, and corresponding
  `remove-gif-background-live` screenshot/result GIF.
- Updated `scripts/smoke-test.sh` to check all four pages and API routes without
  starting compute. Full live smoke run completed: 39 passed, 0 failed. Shell syntax and git diff checks also passed.
- Latest local cancellation/worker-event race fixes remain unpublished frontend
  changes. The production server failure is fixed independently of those changes.
- If user still reports incorrect cutouts on particular media, request that media
  and exact selected points: simple-fixture success does not guarantee model quality.
- No frame cap was introduced. All changes remain uncommitted for user review.
