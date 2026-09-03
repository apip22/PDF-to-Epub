/**
 * ============================================================
 *  ePub Builder  —  OEBPS Structure Generator
 *  Assembles translated text into IDPF-valid ePub 3.0
 *  Uses JSZip for archive creation.
 * ============================================================
 */

const JSZip = require('jszip');
const fs    = require('fs');
const path  = require('path');

/**
 * Build an ePub file from translated paragraphs.
 *
 * @param {string[]}  paragraphs   Translated paragraph texts
 * @param {Object}    meta         { title, author, language, coverBase64 }
 * @param {string}    jobId        Unique job identifier
 * @returns {string}               Absolute path to generated .epub file
 */
async function buildEpub(paragraphs, meta, jobId) {
  const zip    = new JSZip();
  const title  = meta.title  || 'Translated Book';
  const author = meta.author || 'Unknown';
  const lang   = meta.language || 'en';
  const uid    = 'urn:uuid:' + jobId;
  const now    = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  /* ── mimetype ─────────────────────────────────────── */
  // Must be first entry, stored uncompressed for IDPF validation
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  /* ── META-INF/container.xml ───────────────────────── */
  zip.file('META-INF/container.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  /* ── Cover image ──────────────────────────────────── */
  const hasCover = !!(meta.coverBase64 && meta.coverBase64.length > 100);
  if (hasCover) {
    const coverBuf = Buffer.from(meta.coverBase64, 'base64');
    zip.file('OEBPS/images/cover.jpg', coverBuf);
  }

  /* ── Stylesheet ───────────────────────────────────── */
  zip.file('OEBPS/Styles/style.css',
`@charset "UTF-8";
body {
  font-family: Georgia, 'Times New Roman', 'Noto Serif', serif;
  margin: 1.2em;
  line-height: 1.75;
  color: #1a1a1a;
  background: #fefefe;
}
h1, h2, h3 {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  margin: 1.4em 0 0.6em;
  line-height: 1.3;
}
h1 { font-size: 1.6em; text-align: center; margin-top: 2em; }
h2 { font-size: 1.3em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
p  { margin: 0 0 0.85em; text-align: justify; text-indent: 1.5em; }
p.first { text-indent: 0; }
p.no-indent { text-indent: 0; }
.cover-wrap { text-align: center; margin: 0; padding: 0; height: 100%; }
.cover-wrap img { max-width: 100%; max-height: 100%; }
`);

  /* ── Cover page XHTML ─────────────────────────────── */
  if (hasCover) {
    zip.file('OEBPS/Text/cover.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>Cover</title>
<link rel="stylesheet" type="text/css" href="../Styles/style.css"/></head>
<body>
  <div class="cover-wrap"><img src="../images/cover.jpg" alt="Cover"/></div>
</body>
</html>`);
  }

  /* ── Title page XHTML ─────────────────────────────── */
  zip.file('OEBPS/Text/titlepage.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>${escXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../Styles/style.css"/></head>
<body>
  <h1>${escXml(title)}</h1>
  <p class="no-indent" style="text-align:center;margin-top:2em;color:#666;">
    ${escXml(author)}
  </p>
</body>
</html>`);

  /* ── Chapters ─────────────────────────────────────── */
  // ~25 paragraphs per chapter
  const PARAS_PER_CH = 25;
  const chapters = [];
  for (let i = 0; i < paragraphs.length; i += PARAS_PER_CH) {
    chapters.push(paragraphs.slice(i, i + PARAS_PER_CH));
  }

  chapters.forEach((ch, idx) => {
    const num  = String(idx + 1).padStart(3, '0');
    const body = ch.map((p, pi) => {
      const cls = pi === 0 ? ' class="first"' : '';
      return `  <p${cls}>${escXml(p)}</p>`;
    }).join('\n');

    zip.file(`OEBPS/Text/chapter_${num}.xhtml`,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head>
  <title>Chapter ${idx + 1}</title>
  <link rel="stylesheet" type="text/css" href="../Styles/style.css"/>
</head>
<body>
  <h2>Chapter ${idx + 1}</h2>
${body}
</body>
</html>`);
  });

  /* ── content.opf (OPF manifest) ───────────────────── */
  let manifest = '';
  let spine    = '';
  let guide    = '';

  manifest += `    <item id="style" href="Styles/style.css" media-type="text/css"/>\n`;
  manifest += `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n`;

  if (hasCover) {
    manifest += `    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>\n`;
    manifest += `    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>\n`;
    spine    += `    <itemref idref="cover" linear="no"/>\n`;
    guide    += `    <reference type="cover" title="Cover" href="Text/cover.xhtml"/>\n`;
  }

  manifest += `    <item id="titlepage" href="Text/titlepage.xhtml" media-type="application/xhtml+xml"/>\n`;
  spine    += `    <itemref idref="titlepage"/>\n`;

  chapters.forEach((_, idx) => {
    const num = String(idx + 1).padStart(3, '0');
    manifest += `    <item id="ch${num}" href="Text/chapter_${num}.xhtml" media-type="application/xhtml+xml"/>\n`;
    spine    += `    <itemref idref="ch${num}"/>\n`;
  });

  zip.file('OEBPS/content.opf',
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookID">${uid}</dc:identifier>
    <dc:title>${escXml(title)}</dc:title>
    <dc:creator opf:role="aut">${escXml(author)}</dc:creator>
    <dc:language>${lang}</dc:language>
    <dc:date>${now}</dc:date>
    <dc:publisher>PDF-to-ePub Translator</dc:publisher>
    <meta property="dcterms:modified">${now}</meta>
${hasCover ? '    <meta name="cover" content="cover-image"/>\n' : ''}  </metadata>
  <manifest>
${manifest}  </manifest>
  <spine toc="ncx">
${spine}  </spine>
  <guide>
${guide}  </guide>
</package>`);

  /* ── toc.ncx (NCX navigation) ─────────────────────── */
  let navPoints = '';
  let playOrder = 1;

  if (hasCover) {
    navPoints += `    <navPoint id="np-cover" playOrder="${playOrder++}">\n`;
    navPoints += `      <navLabel><text>Cover</text></navLabel>\n`;
    navPoints += `      <content src="Text/cover.xhtml"/>\n`;
    navPoints += `    </navPoint>\n`;
  }

  navPoints += `    <navPoint id="np-title" playOrder="${playOrder++}">\n`;
  navPoints += `      <navLabel><text>${escXml(title)}</text></navLabel>\n`;
  navPoints += `      <content src="Text/titlepage.xhtml"/>\n`;
  navPoints += `    </navPoint>\n`;

  chapters.forEach((_, idx) => {
    const num = String(idx + 1).padStart(3, '0');
    navPoints += `    <navPoint id="np-${num}" playOrder="${playOrder++}">\n`;
    navPoints += `      <navLabel><text>Chapter ${idx + 1}</text></navLabel>\n`;
    navPoints += `      <content src="Text/chapter_${num}.xhtml"/>\n`;
    navPoints += `    </navPoint>\n`;
  });

  zip.file('OEBPS/toc.ncx',
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escXml(title)}</text></docTitle>
  <docAuthor><text>${escXml(author)}</text></docAuthor>
  <navMap>
${navPoints}  </navMap>
</ncx>`);

  /* ── Generate ZIP & save to disk ──────────────────── */
  const epubBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, jobId + '.epub');
  fs.writeFileSync(outputPath, epubBuffer);

  return outputPath;
}

/* ── Helpers ──────────────────────────────────────────── */

function escXml(s) {
  if (!s) return '';
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

module.exports = { buildEpub };
