const fs = require('fs');

let pdfjsLib;

async function initPdfJs() {
  if (pdfjsLib) return;
  try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); }
  catch { pdfjsLib = require('pdfjs-dist'); }
}

async function parsePDF(filePath, onProgress) {
  await initPdfJs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
  const texts = [];
  const layout = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const blocks = await extractPageParagraphs(page, viewport.width);
    blocks.forEach((block, index) => {
      texts.push(block.text);
      layout.push({ ...block, page: pageNumber, pageWidth: viewport.width, pageHeight: viewport.height, pageStart: index === 0 });
    });
    if (onProgress) onProgress(pageNumber, doc.numPages);
  }

  doc.destroy();
  const filtered = texts.map((text, index) => ({ text, style: layout[index] }))
    .filter(item => item.text.trim().length > 3);
  const result = filtered.map(item => item.text);
  result.layout = filtered.map(item => item.style);
  return result;
}

async function extractPageParagraphs(page, pageWidth) {
  const content = await page.getTextContent();
  const items = content.items.filter(item => item.str && item.str.trim().length > 0);
  if (!items.length) return [];

  const positioned = items.map(item => ({
    str: item.str,
    x: item.transform[4],
    y: item.transform[5],
    fontSize: Math.abs(item.transform[0]) || 12,
    width: item.width || 0,
    fontName: item.fontName || ''
  })).sort((a, b) => b.y - a.y);

  const lines = [];
  let lineItems = [positioned[0]];
  let lineY = positioned[0].y;
  const pushLine = () => {
    lineItems.sort((a, b) => a.x - b.x);
    lines.push({
      text: joinLineItems(lineItems),
      y: lineY,
      fontSize: lineItems.reduce((sum, item) => sum + item.fontSize, 0) / lineItems.length,
      x: lineItems[0].x,
      width: lineItems.reduce((right, item) => Math.max(right, item.x + item.width), 0) - lineItems[0].x,
      bold: lineItems.some(item => /bold|black|heavy/i.test(item.fontName)),
      italic: lineItems.some(item => /italic|oblique/i.test(item.fontName))
    });
  };

  for (let index = 1; index < positioned.length; index++) {
    const item = positioned[index];
    const averageFontSize = lineItems.reduce((sum, current) => sum + current.fontSize, 0) / lineItems.length;
    if (Math.abs(item.y - lineY) <= averageFontSize * 0.45) lineItems.push(item);
    else { pushLine(); lineItems = [item]; lineY = item.y; }
  }
  pushLine();

  const paragraphs = [];
  let paragraphLines = [lines[0]];
  const pushParagraph = () => {
    const first = paragraphLines[0];
    const last = paragraphLines[paragraphLines.length - 1];
    const right = last.x + last.width;
    const center = pageWidth / 2;
    let align = 'left';
    if (Math.abs(first.x + first.width / 2 - center) < pageWidth * 0.08) align = 'center';
    else if (right > pageWidth * 0.82) align = 'right';
    paragraphs.push({
      text: paragraphLines.map(line => line.text).join(' ').trim(),
      fontSize: Math.max(8, Math.min(36, first.fontSize)),
      indent: Math.max(0, first.x),
      align,
      bold: paragraphLines.some(line => line.bold),
      italic: paragraphLines.some(line => line.italic)
    });
  };

  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1];
    const current = lines[index];
    const gap = Math.abs(previous.y - current.y);
    const isParagraphBreak = gap > previous.fontSize * 1.35 * 1.5 || Math.abs(current.fontSize - previous.fontSize) > 2;
    if (isParagraphBreak) { pushParagraph(); paragraphLines = [current]; }
    else paragraphLines.push(current);
  }
  pushParagraph();
  return paragraphs.filter(paragraph => paragraph.text.length > 0);
}

function joinLineItems(items) {
  let result = items[0].str;
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1];
    const current = items[index];
    result += current.x - (previous.x + previous.width) > previous.fontSize * 0.25 ? ` ${current.str}` : current.str;
  }
  return result.replace(/\s+/g, ' ').trim();
}

module.exports = { parsePDF };
