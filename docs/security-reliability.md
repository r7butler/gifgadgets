# Security and reliability changes

This batch preserves the editor UI, decoder, existing file limits, analytics,
error telemetry, and draft behavior. It does not add sharing quotas or a storage
budget. No production deployment is part of this batch.

## Sharing

- Preserve the PUT upload protocol used by web tools and the iOS client. The
  server generates a random 128-bit slug and records the title, type, and upload
  key. The unguessable slug authorizes initial publication; a separate client
  token is unnecessary because publication cannot change that recorded metadata.
- Uploads go to `pending-share/`, which the existing CDN bucket policy cannot
  read. They expire through a one-day lifecycle rule.
- Accept the existing six supported media types, inspect their signatures, and
  conditionally copy the inspected object version into `share/`. Validate only
  a small header, without buffering a large GIF or imposing a new size limit.
- Public media is never overwritten during finalization. Retries use the same
  objects and result. Generated pages escape HTML attributes and use conditional
  creation. CDN headers prevent script execution in media and generated pages,
  including previously published content.
- Keep media on the existing site URLs, preserving download behavior. No origin
  migration is included.
- Route the 4–6 MB browser sharing path through JSON metadata and direct upload,
  fixing emoji/non-Latin metadata failures. Resizer and cropper now use `/api`
  instead of bypassing CloudFront with a direct Lambda URL.

## Processing and infrastructure

- Atomically reserve the existing 20 compute requests/hour and 3 reports/hour
  in separate fixed hourly windows. Trust the last CloudFront-appended address,
  relying on the existing CloudFront-only Lambda access policy.
- Record and atomically claim issued, unexpired jobs. New job IDs use 128-bit
  randomness; existing 12-character issued IDs remain valid. Job IDs are bearer
  capabilities, so switching network/IP between upload and submission still works.
- Cache completed responses privately in S3. Duplicate submissions wait for
  that response instead of reexecuting work. Known conversion failures permit
  retries without another upload, counting against the existing compute quota.
  Ambiguous remote failures stay claimed to prevent duplicate GPU execution.
- Honor processing kill switches at submission and warmup. Coalesce warmups to
  at most one/minute globally, returning the same successful no-op response to
  other callers. This does not consume users' compute quotas.
- Require nonempty Modal credentials and authenticate converter warmup.
  Authentication still occurs inside the current Modal architecture; preventing
  unauthorized container allocation entirely requires a separate gateway design.
- Preserve `g/*` during frontend sync, enable site-bucket versioning, and set the
  CloudFront origin response timeout to 120 seconds for the existing synchronous
  processing calls. This is an interim measure, not asynchronous job processing.
- Initialize Terraform in deployment CI; allow scripts to use CI credentials
  without forcing the local SSO profile.

## Verification and deployment requirements

Backend tests use emulated S3/DynamoDB and actual FastAPI routes with GPU/Modal
dependencies stubbed. Browser tests cover Chromium, Firefox, and WebKit, including
39 MB direct sharing, Unicode metadata, and completing standalone sharing flows.
These are local tests, not live cloud or physical iOS validation.

Validation: 103 backend tests passed. All 201 browser cases passed across the
initial run and a corrected rerun of six new tests (those tests initially skipped
the resize/crop action required before sharing). Template build, syntax checks,
Terraform formatting, and provider validation also passed.

Apply and verify infrastructure before releasing the new backend. In particular:

- Lambda needs `s3:ListBucket` on the assets bucket so missing objects return 404
  rather than 403 during publication and result polling. See [AWS HeadObject
  permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html).
- Deploy CDN security headers and temporary-object expiration. Verify the
  applicable origin timeout quota; see [CloudFront origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html).
- Verify the same nonempty Modal key is configured in Lambda and both services.
- Old published URLs remain usable. An unfinished share grant from before this
  release cannot be securely finalized because it has no issued metadata record;
  that upload must restart. Existing clients receiving new grants need no upgrade.
- Review actual production state before deployment: the earlier, reverted batch
  was previously deployed, and resetting Git does not roll back infrastructure.

## Remaining limitations

- Direct PUTs retain their existing size behavior and remain reusable for five
  minutes, only against private temporary objects. Abuse-related storage and
  request costs still need a separately agreed quota/size policy.
- Validation checks file signatures, not complete media decoding.
- Pending media and saved share responses expire after one day; compute records
  expire after one hour. Retries after expiration need a new grant.
- If Lambda crashes or cannot persist a compute result, the job remains claimed;
  it is not automatically rerun. A durable asynchronous worker/status design
  would improve recovery from these uncommon infrastructure failures.
