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
const API_BASE_URL = "https://nl62cwaytuqakre5u72tcav7ny0mdlaz.lambda-url.us-east-1.on.aws";

/**
 * Upload a GIF file to the backend.
 * Reads the file as base64 and POSTs it to /upload.
 * Returns { id } on success.
 */
async function uploadGif(file) {
  const base64 = await fileToBase64(file);

  const response = await fetch(API_BASE_URL + "/upload", {
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
  const response = await fetch(API_BASE_URL + "/gif/" + encodeURIComponent(id));

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
async function shareGif(blob, title, filename) {
  // Lambda function URLs have a 6MB payload limit; base64 adds ~33% overhead
  if (blob.size > 4 * 1024 * 1024) {
    return _shareViaPresign(blob, title, filename);
  }

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  const body = { file: base64, title };
  if (filename) body.filename = filename;

  const response = await fetch(API_BASE_URL + "/share", {
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

async function _shareViaPresign(blob, title, filename) {
  const presignRes = await fetch(API_BASE_URL + "/share/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, filename: filename || null }),
  });
  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({}));
    throw new Error(err.error || "Presign failed");
  }
  const presign = await presignRes.json();

  const uploadRes = await fetch(presign.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/gif" },
    body: blob,
  });
  if (!uploadRes.ok) throw new Error("Upload failed");

  const finalRes = await fetch(API_BASE_URL + "/share/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: presign.slug, title: presign.title }),
  });
  if (!finalRes.ok) {
    const err = await finalRes.json().catch(() => ({}));
    throw new Error(err.error || "Finalize failed");
  }
  return finalRes.json();
}
