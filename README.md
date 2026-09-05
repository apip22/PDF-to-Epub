# PDF → ePub Translator

Konverter PDF ke ePub dengan Neural Machine Translation (NMT).

## Fitur

- 📄 **PDF Parser** — Y-axis coordinate mapping untuk presisi paragraf
- 🖼️ **Cover Extraction** — Halaman 1 PDF → JPEG cover ePub
- 🌐 **Multi-Provider NMT** — Google Translate (free), Google Cloud, DeepL
- 📦 **ePub Builder** — Struktur OEBPS murni (OPF, NCX, XHTML)
- ⚡ **Real-time Progress** — SSE streaming untuk monitoring langsung
- 🔄 **Retry & Backoff** — Error handling otomatis dengan rate-limit guard
- 🎨 **Layout-aware EPUB** — page break, ukuran font, indentasi, alignment, dan cover halaman pertama dipertahankan semaksimal mungkin
- 📱 **Cross-platform Web App** — dapat dibuka dari Android, Windows, macOS, dan Linux melalui browser

## Quick Start (Lokal)

```bash
npm install
npm start
# → http://localhost:3000
```

## Jalankan Lokal

Persyaratan: Node.js 18 atau lebih baru.

```bash
npm install
npm start
# buka http://localhost:3000
```

Untuk Android, PC, atau MacBook dalam jaringan yang sama, buka `http://IP-KOMPUTER:3000`. Pastikan firewall mengizinkan port 3000.

## Deploy Online dari GitHub

GitHub menyimpan source code; GitHub Pages tidak dapat menjalankan server Node.js ini. Gunakan Render atau Railway yang terhubung ke repository GitHub.

### Render.com

1. Push repo ini ke GitHub
2. Buka [render.com](https://render.com) → **New** → **Web Service**
3. Connect ke GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
   - Health check path: `/health`
5. Klik **Deploy**

### Railway

1. Push ke GitHub
2. Buka [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Pilih repo → otomatis deploy

## Catatan kesetiaan PDF

ePub secara alami bersifat reflowable, sehingga hasil tidak dapat identik 100% dengan PDF pada semua ukuran layar. Converter mempertahankan page break, ukuran font dasar, indentasi, alignment, urutan teks, dan halaman pertama sebagai cover. PDF hasil scan yang hanya berisi gambar memerlukan OCR dan belum dapat diterjemahkan dari teks tanpa lapisan OCR.

## Struktur File

```
├── server.js              # Express server + API routes
├── lib/
│   ├── pdfParser.js       # PDF.js Y-axis text extraction
│   ├── translator.js      # Multi-provider NMT pipeline
│   └── epubBuilder.js     # OEBPS ePub 3.0 assembler
├── public/
│   └── index.html         # Frontend UI (dark glassmorphism)
├── package.json
└── .gitignore
```

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `POST` | `/api/upload` | Upload PDF + settings |
| `GET`  | `/api/process/:jobId` | SSE stream progress |
| `GET`  | `/api/download/:jobId` | Download ePub |
| `GET`  | `/api/languages` | Daftar bahasa |

## Translation Engines

| Engine | API Key | Limit |
|--------|---------|-------|
| Google Translate (Free) | ❌ Tidak perlu | Unlimited* |
| Google Cloud Translation | ✅ Perlu | Sesuai quota |
| DeepL API | ✅ Perlu | 500K chars/bulan (free) |

*\*Google Free dapat di-throttle jika terlalu banyak request.*
