/**
 * ============================================================
 *  PDF → ePub Translator  ·  Express.js Server
 *  Server-Side NMT Pipeline + SSE Progress Streaming
 * ============================================================
 */

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const { parsePDF }            = require('./lib/pdfParser');
const { translateParagraphs } = require('./lib/translator');
const { buildEpub }           = require('./lib/epubBuilder');

// ── Ensure directories exist ───────────────────────────
['uploads', 'output'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '120mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer config ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── In-memory job store ────────────────────────────────
const jobs = {};

// Cleanup old jobs every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of Object.entries(jobs)) {
    if (now - job.created > 60 * 60 * 1000) { // 1 hour
      try {
        if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
        if (job.epubPath && fs.existsSync(job.epubPath)) fs.unlinkSync(job.epubPath);
      } catch (_) {}
      delete jobs[id];
    }
  }
}, 30 * 60 * 1000);

/* ═══════════════════════════════════════════════════════
 *  API ROUTES
 * ═══════════════════════════════════════════════════════ */

/**
 * POST /api/upload
 * Upload PDF file + translation settings.
 * Body (multipart): pdf (file), sourceLang, targetLang, provider, apiKey, title, author, coverBase64
 */
app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });

  const jobId = uuidv4();
  jobs[jobId] = {
    created:     Date.now(),
    status:      'uploaded',
    filePath:    req.file.path,
    sourceLang:  req.body.sourceLang  || 'auto',
    targetLang:  req.body.targetLang  || 'id',
    provider:    req.body.provider    || 'google_free',
    apiKey:      req.body.apiKey      || '',
    title:       req.body.title       || 'Translated Book',
    author:      req.body.author      || 'Unknown',
    coverBase64: req.body.coverBase64 || '',
    epubPath:    null,
    progress:    null,
    errors:      []
  };

  res.json({ jobId, message: 'Upload successful' });
});

/**
 * GET /api/process/:jobId
 * Start processing and stream progress via SSE.
 */
app.get('/api/process/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing') return res.status(409).json({ error: 'Already processing' });

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  job.status = 'processing';

  try {
    // ── Phase 1: Parse PDF ──────────────────────────────
    send({ phase: 'parsing', message: 'Memulai parsing PDF…' });

    const paragraphs = await parsePDF(job.filePath, (current, total) => {
      send({ phase: 'parsing', current, total, message: `Parsing halaman ${current}/${total}` });
    });

    send({
      phase: 'parsed',
      total: paragraphs.length,
      message: `Berhasil mengekstrak ${paragraphs.length} paragraf`
    });

    if (paragraphs.length === 0) {
      send({ phase: 'error', message: 'Tidak ada teks yang ditemukan di PDF.' });
      res.end();
      return;
    }

    // ── Phase 2: Translate ──────────────────────────────
    send({
      phase: 'translating',
      current: 0,
      total: paragraphs.length,
      message: 'Memulai terjemahan…'
    });

    const translated = await translateParagraphs(
      paragraphs,
      {
        sourceLang: job.sourceLang,
        targetLang: job.targetLang,
        provider:   job.provider,
        apiKey:     job.apiKey
      },
      (current, total, errorCount) => {
        send({
          phase: 'translating',
          current,
          total,
          errors: errorCount,
          message: `Menerjemahkan paragraf ${current}/${total}`
        });
      }
    );

    // ── Phase 3: Build ePub ─────────────────────────────
    send({ phase: 'building', message: 'Merakit file ePub…' });

    const epubPath = await buildEpub(translated, {
      title:       job.title,
      author:      job.author,
      language:    job.targetLang,
      coverBase64: job.coverBase64
    }, req.params.jobId);

    job.epubPath = epubPath;
    job.status = 'done';

    const stats = fs.statSync(epubPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    send({
      phase: 'done',
      message: `ePub siap! (${sizeMB} MB)`,
      downloadUrl: `/api/download/${req.params.jobId}`,
      sizeMB
    });

  } catch (err) {
    console.error('Processing error:', err);
    send({ phase: 'error', message: 'Error: ' + err.message });
    job.status = 'error';
  }

  res.end();
});

/**
 * GET /api/download/:jobId
 */
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.epubPath || !fs.existsSync(job.epubPath)) {
    return res.status(404).json({ error: 'File not found or not ready yet' });
  }
  const filename = job.title.replace(/[^a-zA-Z0-9_\-\s]/g, '') + '.epub';
  res.download(job.epubPath, filename);
});

/**
 * GET /api/languages
 */
app.get('/api/languages', (_, res) => {
  res.json([
    { code: 'auto', name: 'Auto Detect' },
    { code: 'en',   name: 'English' },
    { code: 'id',   name: 'Bahasa Indonesia' },
    { code: 'ms',   name: 'Bahasa Melayu' },
    { code: 'ja',   name: '日本語 (Japanese)' },
    { code: 'ko',   name: '한국어 (Korean)' },
    { code: 'zh-CN',name: '中文简体 (Chinese Simplified)' },
    { code: 'zh-TW',name: '中文繁體 (Chinese Traditional)' },
    { code: 'ar',   name: 'العربية (Arabic)' },
    { code: 'de',   name: 'Deutsch (German)' },
    { code: 'es',   name: 'Español (Spanish)' },
    { code: 'fr',   name: 'Français (French)' },
    { code: 'hi',   name: 'हिन्दी (Hindi)' },
    { code: 'it',   name: 'Italiano (Italian)' },
    { code: 'nl',   name: 'Nederlands (Dutch)' },
    { code: 'pt',   name: 'Português (Portuguese)' },
    { code: 'ru',   name: 'Русский (Russian)' },
    { code: 'th',   name: 'ไทย (Thai)' },
    { code: 'tr',   name: 'Türkçe (Turkish)' },
    { code: 'vi',   name: 'Tiếng Việt (Vietnamese)' },
    { code: 'pl',   name: 'Polski (Polish)' },
    { code: 'uk',   name: 'Українська (Ukrainian)' },
    { code: 'sv',   name: 'Svenska (Swedish)' },
    { code: 'da',   name: 'Dansk (Danish)' },
    { code: 'fi',   name: 'Suomi (Finnish)' }
  ]);
});

// ── Catch-all: serve index.html ────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 PDF→ePub Translator running at http://localhost:${PORT}\n`);
});
