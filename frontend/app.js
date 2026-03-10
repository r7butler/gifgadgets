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
const API_BASE_URL = "https://zzdzs3cdwds3h2jczap4das4ky0bxccn.lambda-url.us-east-1.on.aws";

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
 * @param {Blob} blob  GIF blob from the encoder
 * @param {string} title  Caption/title text for the share page
 * @returns {{ slug, share_url, gif_url }}
 */
async function shareGif(blob, title, filename) {
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
