/**
 * ============================================================
 *  PDF Parser — Y-Axis Coordinate Mapping
 *  Extracts text with paragraph-level structure preservation
 *  using PDF.js text item transform matrices.
 * ============================================================
 */

const fs = require('fs');

// pdf.js for Node.js (legacy CommonJS build)
let pdfjsLib;

async function initPdfJs() {
  if (pdfjsLib) return;
  // Dynamic import for pdfjs-dist (handles both CJS and ESM)
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    pdfjsLib = require('pdfjs-dist');
  }
}

/**
 * Parse a PDF file and extract paragraphs using Y-axis coordinate analysis.
 *
 * @param {string} filePath       Absolute path to PDF file
 * @param {Function} onProgress   Callback(currentPage, totalPages)
 * @returns {string[]}            Array of paragraph texts
 */
async function parsePDF(filePath, onProgress) {
  await initPdfJs();

  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc  = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;

  const totalPages   = doc.numPages;
  const allParagraphs = [];

  for (let p = 1; p <= totalPages; p++) {
    const page  = await doc.getPage(p);
    const paras = await extractPageParagraphs(page);
    allParagraphs.push(...paras);

    if (onProgress) onProgress(p, totalPages);
  }

  doc.destroy();

  // Filter out very short fragments (likely page numbers, headers)
  return allParagraphs.filter(t => t.trim().length > 3);
}

/**
 * Extract paragraphs from a single PDF page using Y-axis analysis.
 *
 * Algorithm:
 *  1. Get all text items with transform coordinates
 *  2. Sort by Y descending (top of page → bottom)
 *  3. Cluster items into lines based on Y proximity
 *  4. Sort each line's items by X (left → right)
 *  5. Detect paragraph boundaries via Y-gap analysis
 *     (gap > 1.5× normal line spacing = new paragraph)
 *
 * @param {Object} page  pdf.js page proxy
 * @returns {string[]}   paragraphs
 */
async function extractPageParagraphs(page) {
  const content = await page.getTextContent();
  const items   = content.items.filter(it => it.str && it.str.trim().length > 0);

  if (items.length === 0) return [];

  // Extract positioned items
  // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
  //   transform[4] = X position
  //   transform[5] = Y position
  //   abs(transform[0]) ≈ font size
  const positioned = items.map(it => ({
    str:      it.str,
    x:        it.transform[4],
    y:        it.transform[5],
    fontSize: Math.abs(it.transform[0]) || 12,
    width:    it.width || 0
  }));

  // ── Step 1: Sort top → bottom (higher Y = higher on page) ──
  positioned.sort((a, b) => b.y - a.y);

  // ── Step 2: Cluster into lines by Y proximity ──
  const lines = [];
  let lineItems = [positioned[0]];
  let lineY     = positioned[0].y;

  for (let i = 1; i < positioned.length; i++) {
    const it = positioned[i];
    // Threshold = 45% of average font size in current line cluster
    const avgFS     = lineItems.reduce((s, c) => s + c.fontSize, 0) / lineItems.length;
    const threshold = avgFS * 0.45;

    if (Math.abs(it.y - lineY) <= threshold) {
      lineItems.push(it);
    } else {
      // Flush line
      lineItems.sort((a, b) => a.x - b.x); // left → right
      const avgFontSize = lineItems.reduce((s, c) => s + c.fontSize, 0) / lineItems.length;
      lines.push({
        text:     joinLineItems(lineItems),
        y:        lineY,
        fontSize: avgFontSize
      });
      lineItems = [it];
      lineY     = it.y;
    }
  }

  // Flush last line
  if (lineItems.length > 0) {
    lineItems.sort((a, b) => a.x - b.x);
    const avgFontSize = lineItems.reduce((s, c) => s + c.fontSize, 0) / lineItems.length;
    lines.push({
      text:     joinLineItems(lineItems),
      y:        lineY,
      fontSize: avgFontSize
    });
  }

  if (lines.length === 0) return [];

  // ── Step 3: Detect paragraph boundaries via Y-gap ──
  // Normal line spacing ≈ 1.2–1.4 × font size
  // Paragraph gap ≈ > 1.5 × normal spacing OR font-size change
  const paragraphs = [];
  let paraLines    = [lines[0].text];

  for (let i = 1; i < lines.length; i++) {
    const gap            = Math.abs(lines[i - 1].y - lines[i].y);
    const refFS          = lines[i - 1].fontSize;
    const normalSpacing  = refFS * 1.35;
    const isBigGap       = gap > normalSpacing * 1.5;
    const isFontChange   = Math.abs(lines[i].fontSize - lines[i - 1].fontSize) > 2;

    if (isBigGap || isFontChange) {
      paragraphs.push(paraLines.join(' ').trim());
      paraLines = [lines[i].text];
    } else {
      paraLines.push(lines[i].text);
    }
  }

  if (paraLines.length > 0) {
    paragraphs.push(paraLines.join(' ').trim());
  }

  return paragraphs.filter(p => p.length > 0);
}

/**
 * Join text items within a single line, inserting spaces where needed.
 */
function joinLineItems(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0].str;

  let result = items[0].str;
  for (let i = 1; i < items.length; i++) {
    const prev    = items[i - 1];
    const curr    = items[i];
    // Estimate gap between previous item end and current item start
    const prevEnd = prev.x + prev.width;
    const gap     = curr.x - prevEnd;
    const spaceW  = prev.fontSize * 0.25; // approximate space width

    if (gap > spaceW) {
      result += ' ' + curr.str;
    } else {
      result += curr.str;
    }
  }

  return result.replace(/\s+/g, ' ').trim();
}

module.exports = { parsePDF };
