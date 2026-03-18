/* ==========================================================
   GifCaption – Backend API Helpers

   Thin wrappers around fetch() for talking to the Lambda
   backend.  Used by the editor modules (gif-export.js uses
   shareGif) and by legacy pages (create.html, gif.html).

   NOTE:  fetchGif() calls the removed /gif/:id endpoint —
   it is dead code kept only for gif.html compatibility.
   ========================================================== */

// Base URL for the API — update this after deploying Terraform.
// Use the Lambda Function URL output from `terraform output lambda_function_url`.
const API_BASE_URL = "/api";

/**
 * Fetch wrapper that computes SHA-256 of the request body and includes it
 * as x-amz-content-sha256. Required for CloudFront OAC + Lambda Function URL
 * signing on POST/PUT requests.
 */
async function apiFetch(url, options) {
  if (options && options.body) {
    var raw = typeof options.body === "string"
      ? new TextEncoder().encode(options.body)
      : options.body instanceof Blob
        ? new Uint8Array(await options.body.arrayBuffer())
        : options.body;
    var hashBuf = await crypto.subtle.digest("SHA-256", raw);
    var hashHex = Array.from(new Uint8Array(hashBuf))
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
    options.headers = options.headers || {};
    options.headers["x-amz-content-sha256"] = hashHex;
  }
  return fetch(url, options);
}

/**
 * Upload a GIF file to the backend.
 * Reads the file as base64 and POSTs it to /upload.
 * Returns { id } on success.
 */
async function uploadGif(file) {
  const base64 = await fileToBase64(file);

  const response = await apiFetch(API_BASE_URL + "/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: base64, filename: file.name }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Upload failed");
  }

  return response.json();
}

/**
 * Fetch GIF metadata by ID.
 * Returns { id, gif_url, created_at }.
 */
async function fetchGif(id) {
  const response = await apiFetch(API_BASE_URL + "/gif/" + encodeURIComponent(id));

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to fetch GIF");
  }

  return response.json();
}

/**
 * Convert a File object to a base64 string (data portion only).
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Strip the data URL prefix, e.g. "data:image/gif;base64,"
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Share a captioned GIF — upload the blob and get back a public share URL.
 * Uses base64 via Lambda for small GIFs, presigned S3 URL for large ones.
 * @param {Blob} blob  GIF blob from the encoder
 * @param {string} title  Caption/title text for the share page
 * @param {string} [filename]  Original filename for slug generation
 * @returns {{ slug, share_url, gif_url }}
 */
async function shareGif(blob, title, filename, contentType) {
  // Lambda function URLs have a 6MB payload limit.
  // Base64+JSON uses ~33% more, so: <4MB → JSON, 4-6MB → binary, >6MB → presigned S3.
  // Non-GIF content types always use presigned S3 (binary/base64 endpoints validate GIF magic bytes).
  if (contentType && contentType !== "image/gif") {
    return _shareViaPresign(blob, title, filename, contentType);
  }
  if (blob.size > 6 * 1024 * 1024) {
    return _shareViaPresign(blob, title, filename, contentType);
  }
  if (blob.size > 4 * 1024 * 1024) {
    return _shareViaBinary(blob, title, filename);
  }

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  const body = { file: base64, title };
  if (filename) body.filename = filename;

  const response = await apiFetch(API_BASE_URL + "/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Share failed");
  }

  return response.json();
}

async function _shareViaBinary(blob, title, filename) {
  var headers = { "Content-Type": "image/gif", "X-Title": title || "" };
  if (filename) headers["X-Filename"] = filename;

  const response = await apiFetch(API_BASE_URL + "/share/upload", {
    method: "POST",
    headers: headers,
    body: blob,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Upload failed");
  }
  return response.json();
}

async function _shareViaPresign(blob, title, filename, contentType) {
  var ct = contentType || "image/gif";
  const presignRes = await apiFetch(API_BASE_URL + "/share/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, filename: filename || null, content_type: ct }),
  });
  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({}));
    throw new Error(err.error || "Presign failed");
  }
  const presign = await presignRes.json();

  const uploadRes = await fetch(presign.upload_url, {
    method: "PUT",
    headers: { "Content-Type": ct },
    body: blob,
  });
  if (!uploadRes.ok) throw new Error("Upload failed");

  const finalRes = await apiFetch(API_BASE_URL + "/share/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: presign.slug, title: presign.title, content_type: ct }),
  });
  if (!finalRes.ok) {
    const err = await finalRes.json().catch(() => ({}));
    throw new Error(err.error || "Finalize failed");
  }
  return finalRes.json();
}
