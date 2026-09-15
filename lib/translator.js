/**
 * ============================================================
 *  Translation Pipeline v2
 *  ─ RESUME SUPPORT: mulai dari paragraf terakhir yang sudah selesai
 *  ─ Checkpoint callback setiap paragraf
 *  ─ Retry + exponential backoff per paragraf
 * ============================================================
 */

/**
 * Translate paragraphs with resume support.
 *
 * @param {string[]}  paragraphs     All original texts
 * @param {Object}    opts           { sourceLang, targetLang, provider, apiKey }
 * @param {Function}  onProgress     Callback(done, total, errorCount)
 * @param {number}    startFrom      Index to resume from (0 = start fresh)
 * @param {string[]}  existingResult Partially translated array (for resume)
 * @returns {string[]}               Fully translated array
 */
async function translateParagraphs(paragraphs, opts, onProgress, startFrom = 0, existingResult = null) {
  const { sourceLang, targetLang, provider, apiKey, onCheckpoint, mode = 'continue', existingStatuses = [] } = opts;

  // Use existing results or create new array
  const translated = existingResult
    ? [...existingResult]
    : new Array(paragraphs.length).fill('');

  const statuses = [...existingStatuses];
  while (statuses.length < paragraphs.length) statuses.push('pending');
  let errorCount = statuses.filter(status => status === 'failed').length;

  // Choose translation function
  let translateFn;
  switch (provider) {
    case 'none':
      translateFn = async text => text;
      break;
    case 'google_cloud':
      translateFn = googleCloudTranslate;
      break;
    case 'deepl':
      translateFn = deepLTranslate;
      break;
    default:
      translateFn = googleFreeTranslate;
      break;
  }

  if (startFrom > 0) {
    console.log(`♻ Resuming translation from paragraph ${startFrom + 1}/${paragraphs.length}`);
  }

  // Process only unfinished work, or explicitly failed entries.
  for (let i = startFrom; i < paragraphs.length; i++) {
    if (opts.isCancelled && opts.isCancelled()) break;
    const text = paragraphs[i];

    if (mode === 'retry-errors' && statuses[i] !== 'failed') continue;
    if (mode === 'continue' && statuses[i] === 'translated') continue;
    if (mode === 'continue' && statuses[i] === 'failed') continue;

    if (!text || text.trim().length === 0) {
      translated[i] = '';
      statuses[i] = 'translated';
      if (onCheckpoint) await onCheckpoint(translated, statuses, i + 1, errorCount);
      if (onProgress) onProgress(i + 1, paragraphs.length, errorCount);
      continue;
    }

    // Skip if already translated (shouldn't happen with startFrom, but safety check)
    if (translated[i] && translated[i].length > 0 && translated[i] !== text) {
      if (onProgress) onProgress(i + 1, paragraphs.length, errorCount);
      continue;
    }

    // Retry up to 3 times with exponential backoff
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        translated[i] = await translateFn(text, sourceLang, targetLang, apiKey);
        statuses[i] = 'translated';
        if (errorCount > 0 && existingStatuses[i] === 'failed') errorCount--;
        success = true;
        break;
      } catch (err) {
        const errMsg = err.message || String(err);
        console.error(`Translation error ¶${i + 1} attempt ${attempt + 1}: ${errMsg}`);

        if (attempt < 2) {
          // Exponential backoff: 2s, 4s
          const waitMs = Math.pow(2, attempt + 1) * 1000;
          console.log(`   Retrying in ${waitMs / 1000}s...`);
          await sleep(waitMs);
        }
      }
    }

    if (!success) {
      translated[i] = text; // fallback: keep original
      statuses[i] = 'failed';
      errorCount++;
    }

    if (onCheckpoint) await onCheckpoint(translated, statuses, i + 1, errorCount);
    if (onProgress) onProgress(i + 1, paragraphs.length, errorCount);

    // Rate limiter between requests
    const delay = provider === 'google_free' ? 300 : 80;
    if (i < paragraphs.length - 1) {
      await sleep(delay);
      if (opts.isCancelled && opts.isCancelled()) break;
    }
  }

  return translated;
}

/* ═══════════════════════════════════════════════════════
 *  PROVIDER IMPLEMENTATIONS
 * ═══════════════════════════════════════════════════════ */

/** Google Translate — free, no API key. */
async function googleFreeTranslate(text, sourceLang, targetLang, _apiKey) {
  const translate = require('google-translate-api-x');
  const src = (!sourceLang || sourceLang === 'auto') ? 'auto' : sourceLang;
  const res = await withTimeout(translate(text, { from: src, to: targetLang }), 30000);
  return res.text;
}

/** Google Cloud Translation API v2. */
async function googleCloudTranslate(text, sourceLang, targetLang, apiKey) {
  if (!apiKey) throw new Error('Google Cloud API key required');
  const url = 'https://translation.googleapis.com/language/translate/v2';
  const body = { q: text, target: targetLang, format: 'text', key: apiKey };
  if (sourceLang && sourceLang !== 'auto') body.source = sourceLang;

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json.data.translations[0].translatedText;
}

/** DeepL API. */
async function deepLTranslate(text, sourceLang, targetLang, apiKey) {
  if (!apiKey) throw new Error('DeepL API key required');
  const url = 'https://api-free.deepl.com/v2/translate';
  const body = { text: [text], target_lang: targetLang.toUpperCase() };
  if (sourceLang && sourceLang !== 'auto') body.source_lang = sourceLang.toUpperCase();

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'DeepL-Auth-Key ' + apiKey
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('DeepL: ' + await resp.text());
  const json = await resp.json();
  return json.translations[0].text;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Translation request timed out after ${ms / 1000}s`)), ms))
  ]);
}

function fetchWithTimeout(url, options, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

module.exports = { translateParagraphs };
