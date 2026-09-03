/**
 * ============================================================
 *  PDF → ePub Converter  —  Google Apps Script Backend
 *  Engine: NMT Translation Pipeline (Google / Cloud / DeepL)
 * ============================================================
 */

/* ─── Web App Entry ─────────────────────────────────────── */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('PDF → ePub Translator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ─── Translation  ──────────────────────────────────────── */

/**
 * Translate a batch of paragraphs with retry / back-off.
 *
 * @param {string[]} paragraphs   Array of paragraph strings
 * @param {string}   sourceLang   BCP-47 source ('' = auto-detect)
 * @param {string}   targetLang   BCP-47 target
 * @param {string}   provider     'google_free' | 'google_cloud' | 'deepl'
 * @param {string}   apiKey       API key (ignored for google_free)
 * @return {{translated:string[], errors:string[]}}
 */
function translateBatch(paragraphs, sourceLang, targetLang, provider, apiKey) {
  var translated = [];
  var errors     = [];
  var MAX_RETRIES = 3;

  for (var i = 0; i < paragraphs.length; i++) {
    var text = paragraphs[i];

    // Skip empty / whitespace-only paragraphs
    if (!text || text.trim() === '') {
      translated.push('');
      continue;
    }

    var done = false;
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        var result = '';

        switch (provider) {
          case 'google_cloud':
            result = _translateGoogleCloud(text, sourceLang, targetLang, apiKey);
            break;
          case 'deepl':
            result = _translateDeepL(text, sourceLang, targetLang, apiKey);
            break;
          default:                         // google_free
            var src = (sourceLang === '' || sourceLang === 'auto') ? '' : sourceLang;
            result = LanguageApp.translate(text, src, targetLang);
            break;
        }

        translated.push(result);
        done = true;
        break;                             // success → next paragraph
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          Utilities.sleep(Math.pow(2, attempt) * 1000);   // exponential back-off
        }
      }
    }

    if (!done) {
      errors.push('¶' + (i + 1) + ' gagal diterjemahkan.');
      translated.push(text);               // fallback: teks asli
    }

    // Rate-limit guard: pause every 8 paragraphs
    if (i > 0 && i % 8 === 0) Utilities.sleep(600);
  }

  return { translated: translated, errors: errors };
}

/* ── Google Cloud Translation API v2 ─────────────────── */

function _translateGoogleCloud(text, src, tgt, key) {
  var url = 'https://translation.googleapis.com/language/translate/v2';
  var body = { q: text, target: tgt, format: 'text', key: key };
  if (src && src !== 'auto') body.source = src;

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error(json.error.message);
  return json.data.translations[0].translatedText;
}

/* ── DeepL Translation API ───────────────────────────── */

function _translateDeepL(text, src, tgt, key) {
  var url = 'https://api-free.deepl.com/v2/translate';
  var body = { text: [text], target_lang: tgt.toUpperCase() };
  if (src && src !== 'auto') body.source_lang = src.toUpperCase();

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'DeepL-Auth-Key ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) throw new Error('DeepL: ' + resp.getContentText());
  return JSON.parse(resp.getContentText()).translations[0].text;
}

/* ─── Drive Export ──────────────────────────────────────── */

/**
 * Persist the generated ePub to Google Drive.
 *
 * @param {string} base64   Base64-encoded .epub bytes
 * @param {string} name     Desired file name
 * @return {{fileId:string, downloadUrl:string, fileName:string}}
 */
function saveEpubToDrive(base64, name) {
  var decoded = Utilities.base64Decode(base64);
  var blob    = Utilities.newBlob(decoded, 'application/epub+zip', name);
  var file    = DriveApp.createFile(blob);

  return {
    fileId:      file.getId(),
    downloadUrl: file.getDownloadUrl(),
    fileName:    file.getName()
  };
}

/* ─── Language Catalogue ────────────────────────────────── */

function getSupportedLanguages() {
  return [
    { code: 'auto', name: 'Auto Detect' },
    { code: 'en',   name: 'English' },
    { code: 'id',   name: 'Bahasa Indonesia' },
    { code: 'ms',   name: 'Bahasa Melayu' },
    { code: 'ja',   name: '日本語 (Japanese)' },
    { code: 'ko',   name: '한국어 (Korean)' },
    { code: 'zh',   name: '中文 简体 (Chinese Simplified)' },
    { code: 'zh-TW',name: '中文 繁體 (Chinese Traditional)' },
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
    { code: 'fi',   name: 'Suomi (Finnish)' },
    { code: 'el',   name: 'Ελληνικά (Greek)' },
    { code: 'he',   name: 'עברית (Hebrew)' },
    { code: 'bn',   name: 'বাংলা (Bengali)' },
    { code: 'ta',   name: 'தமிழ் (Tamil)' }
  ];
}
