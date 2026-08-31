const pdfParse = require("pdf-parse");

const MAX_CHARS = 12000;

async function extractPdfText(buffer) {
  const result = await pdfParse(buffer);
  const text = (result.text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  if (!text) {
    throw new Error("Couldn't extract any text from that PDF (it may be scanned/image-only)");
  }
  return text.slice(0, MAX_CHARS);
}

module.exports = { extractPdfText };
