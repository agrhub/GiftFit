# GiftFit 🎁

> **"Try it on for someone else. The surprise stays a surprise."**  
> *The giver never sees their face. The recipient never knows which one was picked.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15.5-black)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19.1-blue)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8)](https://tailwindcss.com/)
[![YouCam API](https://img.shields.io/badge/YouCam%20API-Perfect%20Corp-ff2d55)](https://www.perfectcorp.com/business/products/youcam-api)
[![Anthropic Claude](https://img.shields.io/badge/Claude%20AI-SDK-d97706)](https://anthropic.com/)

**GiftFit** is an AI-powered, privacy-first gifting platform built for the **YouCam API Skin AI & eCommerce VTO Hackathon (2026)** by Perfect Corp.

Traditional Virtual Try-On (VTO) is built for people shopping for themselves. GiftFit pivots VTO to **gift recipients**: givers can discover what truly fits and delights their loved one, while **biometric privacy** and **the surprise of the gift** remain completely protected.

---

## 📖 Table of Contents

- [The Problem](#-the-problem)
- [How GiftFit Works](#-how-giftfit-works)
- [Key Features](#-key-features)
- [YouCam AI APIs Integration](#-youcam-ai-apis-integration)
- [System Architecture](#-system-architecture)
- [Live Deployment](#-live-deployment)
- [Getting Started](#-getting-started)
- [Deploying to Google Cloud Run](#-deploying-to-google-cloud-run)
- [Testing & Quality Gates](#-testing--quality-gates)
- [Privacy & Fairness by Design](#-privacy--fairness-by-design)
- [Image Provenance & Licenses](#-image-provenance--licenses)
- [Authors & Acknowledgments](#-authors--acknowledgments)

---

## 💡 The Problem

1. **Givers are guessing in the dark:** Jewelry is one of the top holiday gift categories, but givers struggle to know which metal suits the recipient's skin undertone, which earring or necklace silhouette complements their face shape, or what style they actually desire.
2. **Asking ruins the surprise:** Direct questions eliminate the emotional magic of receiving a gift.
3. **Returns are costly and inconvenient:** a gift that doesn't suit the recipient comes back to the store or ends up unworn in a drawer.

---

## 🚀 How GiftFit Works

```
[ GIVER ]                              [ RECIPIENT ]                            [ GIVER ]
1. Shortlists 1-4 designs       3. Opens link on phone           5. Receives Fit Report
   Sets max budget & metal         Takes guided selfie & hand       Scores, style reasons,
2. Sends Fit Request Link   ->  4. Sees 6 items in Try-On     ->    hearted items & metals
   (Shareable link / QR)           (Shortlist + Decoys mixed)       (ZERO photos or face data)
                                   Taps swatches & hearts
                                   Taps Done -> Photos deleted
```

1. **Giver Creates a Fit Request:**  
   On any product page or store, the giver selects 1–4 candidate designs, specifies an optional maximum budget, and can optionally lock preferred metals (e.g., gold only). They share the generated link or QR code.
2. **Recipient Tries On Privately (Mobile Web):**  
   The recipient opens the link on their smartphone (no app installation required). After granting consent, they take a quick guided selfie (and an optional back-of-hand photo for rings, bracelets, or watches).
3. **The Decoy Engine Preserves the Surprise:**  
   The recipient is presented with a **6-item Try-On Carousel**. The giver's shortlist is seamlessly blended with algorithmically matched **decoy items** of similar category, style, and price band. The recipient cannot guess what the giver chose.
4. **Metal Swatches & Region-Focused View:**  
   Recipients can switch metal variants (yellow gold, white gold, rose gold, silver) and heart their favorites. The camera view automatically focuses on relevant features (earlobes for earrings, neckline for necklaces, wrist for watches).
5. **Giver Receives the Fit Report:**  
   The giver gets a comprehensive **Fit Report** with overall Fit Scores, recipient's hearted items, metal preferences, and AI-explained styling rationale.
   **Crucial Rule:** *The giver NEVER sees the recipient's photos, face crops, skin hex codes, or facial biometric attributes.*
6. **Immediate Image Deletion:**  
   Recipient photos are kept in short-lived storage ($\le 1\text{ hour}$) solely to render real-time swatches, and are **permanently purged** when the recipient taps **Done** or hits the persistent **"Delete my photo now"** button.

---

## ✨ Key Features

- **Decoy Mixing Engine (`lib/fit/decoys.ts`):** Statistically leveled to keep recipient guess probability at random chance ($\approx 0.171$, matching the ideal $1/6 \approx 0.167$).
- **Multi-Factor Fit Engine (`lib/fit/score.ts`):** With a try-on, combines recipient hearts (60%), metal and undertone harmony (10%), style and face-shape compatibility (15%), and budget/occasion fit (15%). Without a try-on (store-URL previews, or a recipient who skips the photo), undertone and face shape are not used at all: hearts (80%) and budget/occasion (20%). The undertone is an estimate from one photo, which the recipient can correct. Formula: `lib/fit/WEIGHTS.md`.
- **AI Gift Concierge (Anthropic Claude):** Natural language gift consultation (`@anthropic-ai/sdk`) that generates grounded shortlist recommendations from catalog inventory.
- **Retailer Console (`/retailer`):** E-commerce dashboard showing completion funnels, hearted-to-purchased conversion rates, undertone catalog coverage, and estimated return-risk reduction.
- **Universal Drop-In Plugin (`packages/plugin/giftfit.js`):** A lightweight 1-line script tag injecting an accessible shadow-DOM "Gift it right" trigger into any e-commerce PDP.

### Languages

- **Language follows the shopper, in any language.** Every message whose language is clear (any language: scripts, Vietnamese letters, common words) sets the conversation's language; very short or language-neutral messages ("ok", "$150", an emoji, a product name) keep the language so far, or the page/browser language at the start.
- **Widget UI:** English and Vietnamese (reviewed), plus Japanese, Korean, Simplified Chinese, Thai, Indonesian, Spanish, French and German (machine-translated, not yet reviewed by native speakers). Stores choose with `data-langs` (e.g. `data-langs="en,ja,de"`; default all) and `data-lang` (fallback); the widget starts in the page's or browser's language within that list and follows each shopper message: one of the ten when it is one, English for any other language (never a missing locale). The GiftFit site and its language switcher stay English/Vietnamese.
- **Chat:** the Concierge always replies in the language of the shopper's latest message, whatever it is. Its fixed lines (closing line, refusal, store-preview lines) and the deterministic fallback answer exist in the ten widget languages and are English for any other.
- **Voice:** Speech-to-Text uses Google chirp_3 with automatic language identification (`languageCodes: ["auto"]`; `VOICE_STT_LANGUAGE=fixed` goes back to the widget's language) and reports the language it heard. Spoken replies use the reply's own language and come from Google Cloud Text-to-Speech only (ADR-059): Chirp 3 HD where Google has it, else Neural2, else Standard (static table in `lib/voice/voices.ts`, checked against Google's voice list). If the server voice is unavailable or capped, the widget uses the browser's own voice; languages without a Google voice are shown as text only.
- **Gift flow:** the e-card, its language picker (all ten), share text and e-mails start in the giver's conversation language (English for any other). The recipient page and the Fit Report use the recipient's browser language when it is one of the ten, else the giver's conversation language, else English; the shared header is in the page's language from the first paint, and a refused selfie gets a specific hint ("hold the phone at eye level, chin slightly up") in that language. Translations other than English and Vietnamese are machine-translated, not yet reviewed by native speakers.

---

## 🔮 YouCam AI APIs Integration

GiftFit deeply integrates **7 Perfect Corp / YouCam AI APIs**:

| YouCam API Endpoint | GiftFit Implementation | Cost / Details |
|---|---|---|
| **Facial Color Tones** (`skin-tone-analysis`) | Extracts skin color hex codes to estimate skin undertones (warm, cool, neutral) | 20 units |
| **Face Attributes & Ratio** (`face-attr-analysis`) | Detects `faceShape` (Oval, Round, Heart, Square, etc.) to evaluate jewelry silhouette compatibility | 10 units ($\le 5$ features) |
| **Earrings 2D VTO** | Renders studs, drops, and chandeliers with natural drape on recipient earlobes | 1 unit / render |
| **Necklace 2D VTO** | Accurately drapes pendants, collars, chokers, and chains on the collarbone | 1 unit / render |
| **Ring 2D VTO** | Simulates rings onto recipient hand photos | 1 unit / render |
| **Bracelet 2D VTO** | Simulates bangles and chain bracelets on the wrist | 1 unit / render |
| **Watch 2D VTO** | Renders dress watches and chronographs upright on the wrist | 1 unit / render |

### Safety & Cost Guard (`lib/youcam/cost-guard.ts`)
- **Default Mock Mode (`YOUCAM_MOCK=1`):** Complete local development and test runs cost **0 units**.
- **The public site spends 0 units:** visitors get the judge demo (pre-recorded try-ons of an AI-generated model) and hearts-only gifts from the product photos; no selfie goes to YouCam. There is no judges' reserve: judges watch the demo video.
- **Real try-on only in the owner's recording session:** `YOUCAM_RECORDING=on` plus an owner cookie minted from a secret token (`/owner/recording`); off by default. `GET /api/health` reports `youcamPaid: false` whenever no paid call is possible.
- **Caps (durable, fail closed):** 150 units/day, 300 units total and 40 units per server process (all configurable).
- **SHA-256 Result Cache:** Identical image/parameter combinations are never charged twice.

### Running costs (measured estimates)
Our own figures, not industry averages. Dates are when they were measured; prices change.
- **YouCam units per recipient with a try-on:** Facial Color Tones 20 + Face Attributes 10 + about 6 jewelry try-ons × 1 + up to 4 extra metal previews × 1 ≈ **36–40 units** (prices from `GET /s2s/v2.0/credit/feature-cost`, 2026-10-15). Only the owner's recording session spends units; the public site, the judge demo and store-URL previews use **0 units**.
- **Claude (gift assistant chat):** about **$0.014–$0.021 per conversation** with prompt caching (measured 2026-10-17 on 6 recorded calls); every call counts against a daily cap (default $3, `ANTHROPIC_DAILY_USD_CAP`).
- **Google Speech-to-Text (voice input):** $0.016 per minute at list price, billed per second; clips are at most 15 s. **Text-to-Speech** for spoken replies stayed within the monthly free tier in our tests. Both have daily caps.
- **Hosting (Cloud Run with min 0 instances, Firestore, Cloud Storage):** estimated **$0–3 per month** at hackathon judging traffic (2026-10-17).

---

## 🏗 System Architecture

```mermaid
flowchart LR
  subgraph Browsers
    S["Store page<br/>(any origin, one script tag)"]
    W["Giver: Mark-kun widget<br/>(iframe on GiftFit's origin)"]
    R["Recipient: phone<br/>consent, selfie, try-ons, hearts"]
    F["Giver: Fit Report<br/>scores only, 0 photos"]
    M["Merchant: store-URL preview<br/>(sandboxed snapshot, 24 h)"]
  end
  subgraph CR["GiftFit app on Cloud Run (Next.js 15)"]
    C["Gift Concierge"]
    P["Capture & privacy guard<br/>face crop, 15-min image links"]
    E["Fit Engine + decoys"]
    G["Giver response filter<br/>no image link, color or face field"]
    K["Cost guard<br/>SHA-256 cache, unit caps"]
    V["Store preview fetcher<br/>SSRF guards, sanitized HTML, CSP"]
  end
  subgraph Services
    A["Claude (Anthropic)<br/>catalog + brief text, never photos"]
    Y["YouCam APIs<br/>Color Tones 20 · Face Attributes 10 · Jewelry VTO 1"]
    T["Google Speech-to-Text / TTS"]
    D[("Firestore (TTL) +<br/>private Cloud Storage")]
  end
  S -. embeds .-> W
  W <-->|chat, brief| C
  R <-->|selfie, try-ons| P
  G -->|scores, hearts, prices| F
  M <--> V
  C <--> A
  P <-->|face crop / photo| Y
  P --> K
  W <-->|audio| T
  CR <--> D
  V -->|read-only fetch| X["Public store sites<br/>JSON-LD, Shopify, WooCommerce"]
```

The giver's side only ever receives scores, reasons, hearts and prices. Photos and face data stay on the recipient's side and in YouCam, and are deleted on schedule (photo ≤ 1 h, gift link 72 h, preview 24 h). The fictional demo store runs as a second Cloud Run service on its own origin, so the one-script-tag integration and the iframe boundary are tested exactly as a real store would use them.

```
giftfit/
├── app/                           # Next.js 15 App Router
│   ├── (site)/                    # GiftFit home (/), /merchants, judge demo (/demo); old store paths 308 to the demo store
│   ├── (widget)/                  # Gift assistant frame (/w) opened by giftfit.js
│   ├── (gift)/                    # Giver (/g/[token]) & Recipient (/r/[token]) flows
│   ├── (preview)/                 # Store-URL previews (/s/[key]): sanitized snapshot + the assistant
│   ├── (retailer)/                # Retailer Console (/retailer) & embed panel
│   ├── owner/                     # Owner-only recording switch (/owner/recording)
│   └── api/                       # API route handlers (fit, recipient, preview, voice, widget, demo, health)
├── components/                    # UI Components
│   ├── gift/                      # Giver panel, recipient carousel, camera capture, report
│   ├── store/                     # Aurum catalog view model and formatting helpers
│   ├── widget/                    # Gift assistant: chat, character, voice, e-card and sharing
│   └── trust/                     # Privacy cards, transparency disclaimers, purge buttons
├── lib/                           # Core Business Logic
│   ├── anthropic/                 # Claude client and the daily spend cap
│   ├── concierge/                 # Gift Concierge: tool use over the catalog, recorded mock
│   ├── contracts/                 # Strict TypeScript schemas & vocabulary
│   ├── email/                     # Gift-card and "Fit Report ready" emails (off unless enabled)
│   ├── fit/                       # Fit scoring, decoy algorithms, Claude explainers
│   ├── i18n/                      # The ten widget languages and language detection
│   ├── preview/                   # Store-URL preview: fetcher, SSRF guards, snapshot sanitizer, caps
│   ├── privacy/                   # HMAC tokens, photo store, capture face crop, leak scanner, fairness
│   ├── store/                     # Memory or Firestore repositories, GCS photo store
│   ├── verticals/                 # CIELAB undertone rules & jewelry styling heuristics
│   ├── voice/                     # Google Speech-to-Text / Text-to-Speech, voices, caps
│   └── youcam/                    # Typed YouCam API client, mock engine, cost guard, recording switch
├── db/                            # Drizzle ORM schema, migrations & seed scripts
├── fixtures/                      # Mock images & synthetic AI demo profiles
├── packages/plugin/               # Embeddable giftfit.js script tag
├── demo-store/                    # The demo store (separate origin): static pages for every Aurum design
├── deploy/                        # Cloud Run deployment guide
└── tests/                         # E2E test suites (Playwright) & leak guards
```

---

## 🌐 Live Deployment

| | URL |
|---|---|
| GiftFit (home, widget, API) | https://giftfit-469920173665.us-central1.run.app |
| Judge demo, no selfie | https://giftfit-469920173665.us-central1.run.app/demo |
| Demo store (fictional, separate origin) | https://giftfit-demo-store-469920173665.us-central1.run.app |

Paid YouCam calls are switched off on the public deployment (`GET /api/health` shows `"youcamPaid": false`), so a live selfie try-on is not available there. The demo video shows a real run end to end; the judge demo replays pre-recorded YouCam try-ons of AI-generated models at 0 units.

---

## 🛠 Getting Started

### Prerequisites
- Node.js 22+ & npm
- Python 3 (`py` on Windows) for optional YouCam skill verification

### 1. Installation
```bash
# Clone the repository (with the Live2D Cubism Web Framework submodule)
git clone --recurse-submodules https://github.com/agrhub/GiftFit.git
cd GiftFit

# Install dependencies
npm ci
```

#### Optional: the Live2D widget character
The gift-assistant widget shows a Live2D character, with an SVG mascot as the fallback. Live2D files are not in this repository:
1. Download the **Cubism SDK for Web 5-r.5** from Live2D (you accept Live2D's licence there) and copy `Core/live2dcubismcore.min.js`, unmodified, to `public/live2d/core/`.
2. Run `npm run live2d:fetch` to download the "Mark-kun" sample model (sha256-verified) and the Framework shaders into `public/live2d/` (git-ignored).

Without these files the widget uses the SVG mascot.

### 2. Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```
> **Note:** By default, all variables are optional for local development. As copied, the application runs entirely in **MOCK MODE** (0 YouCam units spent, in-memory DB and photo storage).

Turn on real services one at a time. Every variable, with its default, is documented in [`.env.example`](.env.example).

| To use | Set in `.env.local` |
|---|---|
| Claude (Gift Concierge, Fit Report reasons) | `ANTHROPIC_API_KEY`; optional `ANTHROPIC_DAILY_USD_CAP` (default 3 USD/day) |
| Real YouCam calls (spends units) | `YOUCAM_API_KEY`, `YOUCAM_MOCK=0`, `YOUCAM_ALLOW_PAID=1`; keep the caps `YOUCAM_MAX_UNITS_PER_RUN`, `YOUCAM_DAILY_UNIT_CAP`, `YOUCAM_TOTAL_UNIT_CAP` |
| Voice (Google STT / TTS) | Application Default Credentials (`gcloud auth application-default login`) on a project with `speech.googleapis.com` and `texttospeech.googleapis.com` enabled; optional `GOOGLE_CLOUD_PROJECT` |
| Firestore + Cloud Storage instead of memory | `STORE=firestore`, `FIRESTORE_DATABASE_ID`, `GCS_PHOTO_BUCKET`, `GOOGLE_CLOUD_PROJECT` (ADC as above) |
| Production secrets | `GIFTFIT_URL_SIGNING_SECRET`, `FIT_DECOY_SECRET`, `CRON_SECRET` (random, ≥ 32 characters) |
| Email (off by default) | `EMAIL_PROVIDER`, `SMTP_*` or `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`, and `EMAIL_SEND_ENABLED=1` |

Never commit `.env.local`.

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) for the GiftFit home. The storefront is the separate demo store (one page per Aurum design, each with the one-line snippet):

```bash
GIFTFIT_ORIGIN=http://localhost:3000 PORT=4320 node demo-store/server.mjs   # http://localhost:4320
```

Set `GIFTFIT_DEMO_STORE_URL=http://localhost:4320` in `.env.local` so the home page's "Open the demo store" button and the old `/p/…`, `/c/…`, `/cart` paths (308) point there.

### 4. Judge Instant Demo Mode
To test the complete recipient journey immediately without spending YouCam credits or uploading a selfie:
- Visit `/demo` or call `POST /api/demo/seed` to generate a fresh, pre-seeded showcase Fit Request with 6 fully rendered photo-real try-ons.

---

## ☁️ Deploying to Google Cloud Run

The full, step-by-step guide is [deploy/README.md](deploy/README.md). In short:

1. **Project setup:** enable Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Scheduler, Firestore, Cloud Storage, Speech-to-Text and Text-to-Speech; create the `giftfit-run` service account with `roles/datastore.user` and `roles/speech.client`.
2. **State:** a named Firestore database with TTL on `expiresAt`, and a private photo bucket (uniform access, public access prevented, 1-day lifecycle delete, no soft delete) where the service account has `roles/storage.objectAdmin`.
3. **Secrets:** `YOUCAM_API_KEY`, `ANTHROPIC_API_KEY`, `GIFTFIT_URL_SIGNING_SECRET`, `FIT_DECOY_SECRET` and `CRON_SECRET` in Secret Manager, readable only by the service account.
4. **Deploy** with `gcloud run deploy giftfit --source .` as a **no-traffic candidate** (`--no-traffic --tag candidate`): 1 vCPU, 1 GiB, min 0 / max 1 instances, `STORE=firestore`, `YOUCAM_ALLOW_PAID=0`, `APP_BASE_URL` set to the service URL. Check `/api/health` on the candidate's tag URL, then shift traffic with `gcloud run services update-traffic`.
5. **Demo store:** `gcloud run deploy giftfit-demo-store --source demo-store` with `GIFTFIT_ORIGIN` set to the app's URL, and add the store's URL to the app's `GIFTFIT_WIDGET_ORIGINS`.
6. **Purge:** a Cloud Scheduler job calls `GET /api/recipient/purge-expired` hourly with the cron secret.

---

## 🧪 Testing & Quality Gates

GiftFit enforces strict quality, privacy, and performance gates (about 2,330 Vitest tests, plus Playwright end-to-end suites for the API, the UI and the cross-origin plugin):

```bash
# Run full quality gate (Lint + Typecheck + Unit Tests + Gate Build)
npm run gate

# Run Playwright E2E tests (including independent privacy leak checks)
npm run e2e

# Run the undertone fairness audit across Fitzpatrick I-VI fixtures
npx tsx lib/privacy/fairness/run.ts
```

### Verified Guarantees:
- **Zero Giver Leaks:** Automated test suite probes all giver endpoints to ensure no recipient image URLs, color hex values, or face metrics ever leak to the giver.
- **Decoy Parity:** Automated Monte Carlo tests ensure shortlist items and decoys share identical category distributions and swatch counts.
- **Instant Purge:** Verified that signed URLs and cached assets return `404` immediately upon invoking `"Delete my photo now"`.

---

## ⚖️ Privacy & Fairness by Design

1. **Undertone is a weak estimate, and we say so:** YouCam returns a skin color, not an undertone; GiftFit estimates warm/neutral/cool from its CIELAB hue angle with thresholds of our own. On our synthetic Monk/Fitzpatrick I–VI harness it still misclassifies about 27% overall, and on the real API five AI-generated portraits spanned only 57.9–64.3° of hue (4 of 5 at confidence ≤ 0.20), so one photo carries little undertone signal. That is why it is low-weight (10% at most, shrunk further at low confidence), labelled an *estimate*, correctable by the recipient in one tap, never says a metal should be avoided, and is not used at all when no photo is taken. Details and re-run command: `lib/privacy/fairness/`.
2. **Short-TTL Storage:** Selfies and hand photos sit in a private Google Cloud Storage bucket (us-central1) for at most 1 hour, only to try other metals; Done or "Delete my photo now" deletes them at once, and a 1-day lifecycle rule is the backstop. Everything else lives in Firestore with 72-hour expiry (store previews 24–72 hours).
3. **Signed HMAC URLs:** Try-on images use tamper-proof HMAC SHA-256 tokens valid for $\le 15$ minutes and bound to the recipient's secure cookie session.

---

## 🎨 Image Provenance & Licenses

All product and model imagery in GiftFit is strictly synthetic and rights-cleared:
- **Catalog Products (`public/catalog/aurum/`):** 161 jewelry items for the fictional *Aurum Jewelry* store: SVG/PNG drawn in code (CC0), plus AI-generated product photos via Google Flow. No real brand trademarks are used.
- **Demo Models (`fixtures/youcam/ai-demo/`):** All people displayed in demo fixtures and screenshots are **fictional, AI-generated models** created by the team. No real individuals' biometrics or likenesses exist in this repository.
- Full provenance log: [data/LICENSES.md](data/LICENSES.md) and [fixtures/youcam/ai-demo/README.md](fixtures/youcam/ai-demo/README.md).
- **Widget character (Live2D):** This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author's sole discretion. Live2D Cubism Core (Live2D Proprietary Software License) and the Cubism Web Framework (Live2D Open Software License, git submodule) are not covered by this repository's MIT licence; none of these files are committed. Live2D and Cubism are trademarks of Live2D Inc.; GiftFit is not made or endorsed by Live2D Inc. Details: [data/LICENSES.md](data/LICENSES.md).

---

## 👥 Authors & Acknowledgments

- Built by **the GiftFit Team** for the **YouCam API Skin AI & eCommerce VTO Hackathon (2026)**.
- Powered by [Perfect Corp. YouCam API](https://www.perfectcorp.com/business/products/youcam-api) and [Anthropic Claude](https://anthropic.com/).

---

## 📄 License

GiftFit is free and open-source software, licensed under the [MIT License](LICENSE).
