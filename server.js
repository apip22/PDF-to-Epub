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
['uploads', 'output', path.join('output', 'jobs')].forEach(d => {
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

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'pdf-to-epub-translator' }));

// ── In-memory job store ────────────────────────────────
const jobs = {};
const jobManifestDir = path.join(__dirname, 'output', 'jobs');

function persistJob(jobId, job) {
  const target = path.join(jobManifestDir, `${jobId}.json`);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), 'utf8');
  fs.renameSync(temp, target);
}

for (const file of fs.readdirSync(jobManifestDir)) {
  if (!file.endsWith('.json')) continue;
  try {
    const job = JSON.parse(fs.readFileSync(path.join(jobManifestDir, file), 'utf8'));
    if (job.filePath && fs.existsSync(job.filePath)) {
      if (job.status === 'processing') {
        job.status = 'error';
        job.progress = { ...job.progress, phase: 'error', message: 'Server restarted while this job was processing.' };
      }
      jobs[path.basename(file, '.json')] = job;
    }
  } catch (error) { console.warn('Could not restore job manifest:', file, error.message); }
}

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
    progress:    { phase: 'uploaded', current: 0, total: 0, errors: 0 },
    errors:      [],
    statuses:    [],
    failedIndices: []
  };
  persistJob(jobId, jobs[jobId]);

  res.json({ jobId, message: 'Upload successful' });
});

/**
 * GET /api/status/:jobId
 * Return the latest job state so a disconnected browser can recover.
 */
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, errors: job.errors,
    failedIndices: job.failedIndices || [],
    currentIndex: job.progress.current, totalParagraphs: job.progress.total,
    partial: (job.failedIndices || []).length > 0,
    downloadUrl: job.epubPath ? `/api/download/${req.params.jobId}` : null });
});

// Reconnectable SSE stream. Processing continues independently of this connection.
app.get('/api/events/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let last = '';
  const emit = () => {
    const state = JSON.stringify({
      phase: job.progress.phase,
      current: job.progress.current,
      total: job.progress.total,
      errors: job.progress.errors,
      message: job.progress.message,
      downloadUrl: job.epubPath ? `/api/download/${req.params.jobId}` : null
    });
    if (state !== last) {
      res.write(`data: ${state}\n\n`);
      last = state;
    }
    if (job.status === 'done' || job.status === 'error') {
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(emit, 1000);
  req.on('close', () => clearInterval(timer));
  emit();
});

/**
 * GET /api/process/:jobId
 * Start processing and stream progress via SSE.
 */
app.get('/api/process/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'processing') return res.status(409).json({ error: 'Already processing' });
  const mode = req.query.mode === 'retry-errors' ? 'retry-errors' : 'continue';

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  job.status = 'processing';
  persistJob(req.params.jobId, job);

  try {
    // ── Phase 1: Parse PDF ──────────────────────────────
    send({ phase: 'parsing', message: 'Memulai parsing PDF…' });

    const paragraphs = job.paragraphs || await parsePDF(job.filePath, (current, total) => {
      job.progress = { phase: 'parsing', current, total, errors: 0 };
      persistJob(req.params.jobId, job);
      send({ phase: 'parsing', current, total, message: `Parsing halaman ${current}/${total}` });
    });

    send({
      phase: 'parsed',
      total: paragraphs.length,
      message: `Berhasil mengekstrak ${paragraphs.length} paragraf`
    });
    job.progress = { phase: 'parsed', current: paragraphs.length, total: paragraphs.length, errors: 0 };
    job.paragraphs = paragraphs;
    job.layout = paragraphs.layout || job.layout || [];
    job.translated = job.translated || new Array(paragraphs.length).fill('');
    job.statuses = job.statuses || new Array(paragraphs.length).fill('pending');
    job.failedIndices = job.failedIndices || [];
    persistJob(req.params.jobId, job);

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

    const existingResult = job.translated || null;
    const resumeFrom = mode === 'retry-errors'
      ? Math.min(...(job.failedIndices.length ? job.failedIndices : [paragraphs.length]))
      : 0;

    const translated = await translateParagraphs(
      paragraphs,
      {
        sourceLang: job.sourceLang,
        targetLang: job.targetLang,
        provider:   job.provider,
        apiKey:     job.apiKey,
        mode,
        existingStatuses: job.statuses,
        onCheckpoint: async (result, statuses, current, errors) => {
          job.translated = [...result];
          job.statuses = [...statuses];
          job.failedIndices = statuses.map((status, index) => status === 'failed' ? index : -1).filter(index => index >= 0);
          job.progress = { phase: 'translating', current, total: paragraphs.length, errors };
          job.errors = job.failedIndices.map(index => ({ index, message: 'Translation failed' }));
          persistJob(req.params.jobId, job);
        }
      },
      (current, total, errorCount) => {
        job.progress = { phase: 'translating', current, total, errors: errorCount };
        send({
          phase: 'translating',
          current,
          total,
          errors: errorCount,
          message: `Menerjemahkan paragraf ${current}/${total}`
        });
      },
      resumeFrom,
      existingResult
    );
    translated.layout = paragraphs.layout || [];
    job.layout = translated.layout;
    persistJob(req.params.jobId, job);
      job.progress = { phase: 'building', current: paragraphs.length, total: paragraphs.length, errors: job.failedIndices.length };

    // ── Phase 3: Build ePub ─────────────────────────────
    send({ phase: 'building', message: 'Merakit file ePub…' });

    const epubPath = await buildEpub(translated, {
      title:       job.title,
      author:      job.author,
      language:    job.targetLang,
      coverBase64: job.coverBase64,
      layout:      job.layout || paragraphs.layout || []
    }, req.params.jobId);

    job.epubPath = epubPath;
    job.status = 'done';
    job.progress = { phase: 'done', current: paragraphs.length, total: paragraphs.length, errors: job.failedIndices.length };
    persistJob(req.params.jobId, job);

    const stats = fs.statSync(epubPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    send({
      phase: 'done',
      message: `ePub siap! (${sizeMB} MB)`,
      downloadUrl: `/api/download/${req.params.jobId}`,
      sizeMB,
      errors: job.failedIndices || [],
      partial: (job.failedIndices || []).length > 0
    });

  } catch (err) {
    console.error('Processing error:', err);
    send({ phase: 'error', message: 'Error: ' + err.message });
    job.status = 'error';
    job.progress = { phase: 'error', current: job.progress.current || 0, total: job.progress.total || 0, errors: job.failedIndices?.length || 1, message: err.message };
    persistJob(req.params.jobId, job);
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
