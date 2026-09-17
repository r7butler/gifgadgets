import http from "k6/http";
import { check, sleep } from "k6";
import crypto from "k6/crypto";

/**
 * Load test for the share presign + finalize flow.
 *
 * This mirrors the real browser flow:
 *   1. POST /api/share/presign  — get a presigned S3 URL + slug
 *   2. PUT  to S3 presigned URL — upload the GIF directly to S3
 *   3. POST /api/share/finalize — create the share page
 *
 * We test steps 1 and 3 (the Lambda endpoints). Step 2 goes directly to S3
 * and is not rate-limited by our backend.
 *
 * IMPORTANT: All POST requests must include an x-amz-content-sha256 header
 * with the SHA-256 hex digest of the body. CloudFront OAC needs this to
 * correctly sign requests to the Lambda Function URL.
 *
 * Usage:
 *   k6 run tests/load/share-api.js
 *   k6 run -e BASE_URL=https://gifgadgets.com tests/load/share-api.js
 */

export const options = {
  stages: [
    { duration: "30s", target: 10 }, // ramp up to 10 VUs
    { duration: "2m", target: 10 },  // hold at 10 VUs
    { duration: "30s", target: 0 },  // ramp down
  ],
  thresholds: {
    "http_req_duration{step:presign}": ["p(95)<3000"],
    "http_req_duration{step:finalize}": ["p(95)<3000"],
    http_req_failed: ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://gifgadgets.com";

/** Build headers with the x-amz-content-sha256 body hash required by CloudFront OAC. */
function signedHeaders(body) {
  return {
    "Content-Type": "application/json",
    "x-amz-content-sha256": crypto.sha256(body, "hex"),
  };
}

export default function () {
  // Step 1: Presign — get a presigned S3 upload URL and slug
  const presignPayload = JSON.stringify({
    filename: "loadtest.gif",
    title: `Load test ${Date.now()}`,
  });

  const presignRes = http.post(
    `${BASE_URL}/api/share/presign`,
    presignPayload,
    { headers: signedHeaders(presignPayload), tags: { step: "presign" } },
  );

  const presignOk = check(presignRes, {
    "presign status 200": (r) => r.status === 200,
    "presign has slug": (r) => {
      try { return JSON.parse(r.body).slug !== undefined; }
      catch { return false; }
    },
  });

  if (presignRes.status !== 200 && __ITER === 0) {
    console.log(`Presign failed — Status: ${presignRes.status}, Body: ${presignRes.body}`);
  }

  if (!presignOk) {
    sleep(1);
    return;
  }

  const presign = JSON.parse(presignRes.body);

  // Step 2: S3 upload is skipped in load test — we go straight to finalize.
  // In prod the browser PUTs the GIF to the presigned S3 URL here.

  // Step 3: Finalize — create the share HTML page
  const finalizePayload = JSON.stringify({
    slug: presign.slug,
    title: presign.title,
  });

  const finalizeRes = http.post(
    `${BASE_URL}/api/share/finalize`,
    finalizePayload,
    { headers: signedHeaders(finalizePayload), tags: { step: "finalize" } },
  );

  check(finalizeRes, {
    "finalize status 200": (r) => r.status === 200,
    "finalize has share_url": (r) => {
      try { return JSON.parse(r.body).share_url !== undefined; }
      catch { return false; }
    },
  });

  if (finalizeRes.status !== 200 && __ITER === 0) {
    console.log(`Finalize failed — Status: ${finalizeRes.status}, Body: ${finalizeRes.body}`);
  }

  sleep(1);
}
