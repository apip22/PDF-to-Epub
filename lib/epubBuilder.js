const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

async function buildEpub(paragraphs, meta, jobId) {
  const zip = new JSZip();
  const title = meta.title || 'Translated Book';
  const author = meta.author || 'Unknown';
  const lang = meta.language || 'en';
  const uid = `urn:uuid:${jobId}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const layout = meta.layout || [];
  const hasCover = !!(meta.coverBase64 && meta.coverBase64.length > 100);
  const pages = [];

  paragraphs.forEach((text, index) => {
    const pageNumber = layout[index]?.page || Math.floor(index / 25) + 1;
    let page = pages.find(item => item.number === pageNumber);
    if (!page) { page = { number: pageNumber, items: [] }; pages.push(page); }
    page.items.push({ text, style: layout[index] || {} });
  });

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  if (hasCover) zip.file('OEBPS/images/cover.jpg', Buffer.from(meta.coverBase64, 'base64'));
  zip.file('OEBPS/Styles/style.css', `@charset "UTF-8"; body { font-family: Georgia, 'Times New Roman', serif; margin: 1.2em; line-height: 1.55; color: #1a1a1a; background: #fff; } .pdf-page { break-after: page; page-break-after: always; min-height: 90vh; } .pdf-page:last-child { break-after: auto; page-break-after: auto; } .pdf-text { margin: 0 0 .85em; white-space: pre-wrap; } .cover-wrap { text-align: center; margin: 0; padding: 0; height: 100%; } .cover-wrap img { display: block; max-width: 100%; max-height: 100vh; margin: auto; }`);

  if (hasCover) zip.file('OEBPS/Text/cover.xhtml', pageXhtml('Cover', '<div class="cover-wrap"><img src="../images/cover.jpg" alt="Cover"/></div>', lang));
  zip.file('OEBPS/Text/titlepage.xhtml', pageXhtml(title, `<h1>${escXml(title)}</h1><p style="text-align:center">${escXml(author)}</p>`, lang));

  pages.forEach((page, index) => {
    const number = String(index + 1).padStart(3, '0');
    const body = page.items.map(item => {
      const style = item.style;
      const css = [`font-size:${style.fontSize || 12}px`, `margin-left:${Math.min(25, (style.indent || 0) / 36)}em`, `text-align:${style.align || 'left'}`, style.bold ? 'font-weight:700' : '', style.italic ? 'font-style:italic' : ''].filter(Boolean).join(';');
      return `<p class="pdf-text" style="${css}">${style.italic ? '<em>' : ''}${escXml(item.text)}${style.italic ? '</em>' : ''}</p>`;
    }).join('\n');
    zip.file(`OEBPS/Text/page_${number}.xhtml`, pageXhtml(`Page ${page.number}`, `<main class="pdf-page">${body}</main>`, lang));
  });

  let manifest = '    <item id="style" href="Styles/style.css" media-type="text/css"/>\n';
  let spine = '';
  let navPoints = '';
  let order = 1;
  if (hasCover) {
    manifest += '    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n';
    manifest += '    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>\n';
    spine += '    <itemref idref="cover" linear="no"/>\n';
    navPoints += navPoint('cover', 'Cover', 'Text/cover.xhtml', order++);
  }
  manifest += '    <item id="titlepage" href="Text/titlepage.xhtml" media-type="application/xhtml+xml"/>\n';
  spine += '    <itemref idref="titlepage"/>\n';
  navPoints += navPoint('title', title, 'Text/titlepage.xhtml', order++);
  pages.forEach((page, index) => {
    const number = String(index + 1).padStart(3, '0');
    manifest += `    <item id="pg${number}" href="Text/page_${number}.xhtml" media-type="application/xhtml+xml"/>\n`;
    spine += `    <itemref idref="pg${number}"/>\n`;
    navPoints += navPoint(number, `Page ${page.number}`, `Text/page_${number}.xhtml`, order++);
  });

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="BookID">${uid}</dc:identifier><dc:title>${escXml(title)}</dc:title><dc:creator>${escXml(author)}</dc:creator><dc:language>${escXml(lang)}</dc:language><dc:date>${now}</dc:date>${hasCover ? '<meta name="cover" content="cover-image"/>' : ''}</metadata><manifest>${manifest}    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${spine}</spine></package>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${escXml(title)}</text></docTitle><navMap>${navPoints}</navMap></ncx>`);

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${jobId}.epub`);
  fs.writeFileSync(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return outputPath;
}

function pageXhtml(title, body, lang) { return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escXml(lang)}"><head><title>${escXml(title)}</title><link rel="stylesheet" href="../Styles/style.css"/></head><body>${body}</body></html>`; }
function navPoint(id, label, href, order) { return `<navPoint id="np-${id}" playOrder="${order}"><navLabel><text>${escXml(label)}</text></navLabel><content src="${href}"/></navPoint>`; }
function escXml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

module.exports = { buildEpub };
