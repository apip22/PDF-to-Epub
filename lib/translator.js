/**
 * ============================================================
 *  Translation Pipeline
 *  Multi-provider NMT with chunking, retry & rate-limit guard
 * ============================================================
 */

/**
 * Translate an array of paragraphs using the specified provider.
 *
 * @param {string[]}  paragraphs   Array of original texts
 * @param {Object}    opts         { sourceLang, targetLang, provider, apiKey }
 * @param {Function}  onProgress   Callback(done, total, errorCount)
 * @returns {string[]}             Translated texts (same order & length)
 */
async function translateParagraphs(paragraphs, opts, onProgress) {
  const { sourceLang, targetLang, provider, apiKey } = opts;
  const translated = new Array(paragraphs.length).fill('');
  let errorCount = 0;

  // Choose translation function
  let translateFn;
  switch (provider) {
    case 'google_cloud':
      translateFn = googleCloudTranslate;
      break;
    case 'deepl':
      translateFn = deepLTranslate;
      break;
    default: // google_free
      translateFn = googleFreeTranslate;
      break;
  }

  // A small worker pool keeps the free provider fast without flooding it.
  const concurrency = provider === 'google_free' ? 5 : 8;
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= paragraphs.length) return;

      const text = paragraphs[i];
      if (!text || text.trim().length === 0) {
        translated[i] = '';
      } else {
        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            translated[i] = await translateFn(text, sourceLang, targetLang, apiKey);
            success = true;
            break;
          } catch (err) {
            console.error(`Translation error ¶${i + 1} attempt ${attempt + 1}:`, err.message);
            if (attempt < 2) await sleep(Math.pow(2, attempt) * 1500);
          }
        }

        if (!success) {
          translated[i] = text;
          errorCount++;
        }
      }

      completed++;
      if (onProgress) onProgress(completed, paragraphs.length, errorCount);
      if (provider === 'google_free') await sleep(150);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, paragraphs.length) }, worker));

  return translated;
}

/* ═══════════════════════════════════════════════════════
 *  PROVIDER IMPLEMENTATIONS
 * ═══════════════════════════════════════════════════════ */

/**
 * Google Translate — free, no API key required.
 * Uses google-translate-api-x (maintained community package).
 */
async function googleFreeTranslate(text, sourceLang, targetLang, _apiKey) {
  // Lazy-load the module (it's ESM-compatible)
  const translate = require('google-translate-api-x');

  const src = (!sourceLang || sourceLang === 'auto') ? 'auto' : sourceLang;
  const res = await translate(text, { from: src, to: targetLang });
  return res.text;
}

/**
 * Google Cloud Translation API v2 — requires API key.
 */
async function googleCloudTranslate(text, sourceLang, targetLang, apiKey) {
  if (!apiKey) throw new Error('Google Cloud API key required');

  const url = 'https://translation.googleapis.com/language/translate/v2';
  const body = { q: text, target: targetLang, format: 'text', key: apiKey };
  if (sourceLang && sourceLang !== 'auto') body.source = sourceLang;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  return json.data.translations[0].translatedText;
}

/**
 * DeepL API — requires API key. Uses free tier endpoint.
 */
async function deepLTranslate(text, sourceLang, targetLang, apiKey) {
  if (!apiKey) throw new Error('DeepL API key required');

  const url = 'https://api-free.deepl.com/v2/translate';
  const body = { text: [text], target_lang: targetLang.toUpperCase() };
  if (sourceLang && sourceLang !== 'auto') body.source_lang = sourceLang.toUpperCase();

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'DeepL-Auth-Key ' + apiKey
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('DeepL error: ' + errText);
  }

  const json = await resp.json();
  return json.translations[0].text;
}

/* ── Utility ──────────────────────────────────────────── */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { translateParagraphs };
