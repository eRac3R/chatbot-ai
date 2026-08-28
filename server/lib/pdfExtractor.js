const { PDFParse } = require("pdf-parse");

const MAX_CHARS = 12000;

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || "")
      .replace(/--\s*\d+\s*of\s*\d+\s*--/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
    if (!text) {
      throw new Error("Couldn't extract any text from that PDF (it may be scanned/image-only)");
    }
    return text.slice(0, MAX_CHARS);
  } finally {
    await parser.destroy();
  }
}

module.exports = { extractPdfText };
