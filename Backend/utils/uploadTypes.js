const imageTypes = new Map([
  ["image/png", (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
  ["image/jpeg", (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff],
  ["image/webp", (buffer) => buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"]
]);

export const supportedUploadTypes = new Set([...imageTypes.keys(), "application/pdf"]);

export function detectUploadType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const [contentType, matches] of imageTypes) {
    if (matches(buffer)) return contentType;
  }
  // PDF headers may follow a short leading comment, so inspect the first 1 KB.
  if (/%PDF-\d\.\d/.test(buffer.toString("latin1", 0, 1024))) return "application/pdf";
  return null;
}

export function isAllowedUploadMime(mimetype, filename = "") {
  return supportedUploadTypes.has(mimetype) || /\.pdf$/i.test(filename);
}
