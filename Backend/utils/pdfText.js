import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PDF_PAGES = 25;
export const MAX_PDF_TEXT_CHARACTERS = 18000;

export class PdfProcessingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PdfProcessingError";
    this.statusCode = 400;
  }
}

// Extract only selectable text. Image-only scans need OCR, which this upload path does not provide.
export async function extractPdfText(buffer, maxCharacters = MAX_PDF_TEXT_CHARACTERS) {
  let loadingTask;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      verbosity: 0
    });
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new PdfProcessingError(`PDFs must have ${MAX_PDF_PAGES} pages or fewer.`);
    }

    const parts = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const { items } = await page.getTextContent();
      for (const item of items) {
        if (typeof item.str !== "string" || !item.str) continue;
        parts.push(item.str, item.hasEOL ? "\n" : " ");
        extractedCharacters += item.str.length + 1;
      }
      page.cleanup();
      if (extractedCharacters >= maxCharacters) break;
      parts.push("\n");
    }

    const text = parts.join("")
      .replace(/\u0000/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
      .slice(0, maxCharacters);
    if (!text) {
      throw new PdfProcessingError("This PDF has no selectable text. If it is a scan, upload a clear image of the page instead.");
    }
    return text;
  } catch (error) {
    if (error instanceof PdfProcessingError) throw error;
    throw new PdfProcessingError("Could not read this PDF. Please upload a valid text-based PDF.");
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => {});
  }
}
