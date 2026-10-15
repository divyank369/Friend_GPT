import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPdfText, PdfProcessingError } from "../utils/pdfText.js";
import { detectUploadType, isAllowedUploadMime } from "../utils/uploadTypes.js";

function makePdf(contentStream) {
  const stream = Buffer.from(contentStream, "ascii");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream.toString("ascii")}\nendstream`
  ];
  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
  chunks.push(Buffer.from(`${xref.join("\n")}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`, "ascii"));
  return Buffer.concat(chunks);
}

test("detects PDF signatures even when a browser reports a generic MIME type", () => {
  const pdf = makePdf("BT /F1 16 Tf 36 350 Td (Resume Candidate) Tj ET");
  assert.equal(detectUploadType(pdf), "application/pdf");
  assert.equal(isAllowedUploadMime("application/octet-stream", "resume.pdf"), true);
  assert.equal(detectUploadType(Buffer.from("not a PDF")), null);
});

test("extracts selectable PDF text for resume analysis", async () => {
  const pdf = makePdf("BT /F1 16 Tf 36 350 Td (Resume Candidate) Tj ET");
  assert.match(await extractPdfText(pdf), /Resume Candidate/);
});

test("returns a clear message for scanned PDFs without selectable text", async () => {
  const pdf = makePdf("q Q");
  await assert.rejects(extractPdfText(pdf), (error) =>
    error instanceof PdfProcessingError && /no selectable text/i.test(error.message)
  );
});
