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
- [Getting Started](#-getting-started)
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
- **Reserve Floor:** Enforces a minimum $\ge 300$ unit reserve strictly locked for judge evaluations through November 2026.
- **Run Caps & Rate Limits:** Guard prevents runs exceeding 40 units/call or 150 units/day.
- **SHA-256 Result Cache:** Identical image/parameter combinations are never charged twice.

### Running costs (measured estimates)
Our own figures, not industry averages. Dates are when they were measured; prices change.
- **YouCam units per recipient with a try-on:** Facial Color Tones 20 + Face Attributes 10 + about 6 jewelry try-ons × 1 + up to 4 extra metal previews × 1 ≈ **36–40 units** (prices from `GET /s2s/v2.0/credit/feature-cost`, 2026-10-15). The judge demo and store-URL previews use **0 units**.
- **Claude (gift assistant chat):** about **$0.014–$0.021 per conversation** with prompt caching (measured 2026-10-17 on 6 recorded calls); every call counts against a daily cap (default $3, `ANTHROPIC_DAILY_USD_CAP`).
- **Google Speech-to-Text (voice input):** $0.016 per minute at list price, billed per second; clips are at most 15 s. **Text-to-Speech** for spoken replies stayed within the monthly free tier in our tests. Both have daily caps.
- **Hosting (Cloud Run with min 0 instances, Firestore, Cloud Storage):** estimated **$0–3 per month** at hackathon judging traffic (2026-10-17).

---

## 🏗 System Architecture

```
giftfit/
├── app/                           # Next.js 15 App Router
│   ├── (site)/                    # GiftFit home (/), /merchants, judge demo (/demo); old store paths 308 to the demo store
│   ├── (widget)/                  # Gift assistant frame (/w) opened by giftfit.js
│   ├── (gift)/                    # Giver (/g/[token]) & Recipient (/r/[token]) flows
│   ├── (retailer)/                # Retailer Console (/retailer) & embed panel
│   └── api/                       # API route handlers (fit, recipient, retailer, demo)
├── components/                    # UI Components
│   ├── gift/                      # Giver panel, recipient carousel, camera capture, report
│   ├── store/                     # Aurum catalog view model and formatting helpers
│   ├── widget/                    # Gift assistant: chat, character, voice, e-card and sharing
│   └── trust/                     # Privacy cards, transparency disclaimers, purge buttons
├── lib/                           # Core Business Logic
│   ├── contracts/                 # Strict TypeScript schemas & vocabulary
│   ├── fit/                       # Fit scoring, decoy algorithms, Claude explainers
│   ├── privacy/                   # HMAC tokens, photo store, leak scanner, fairness
│   ├── verticals/                 # CIELAB undertone rules & jewelry styling heuristics
│   └── youcam/                    # Typed YouCam API client, mock engine & cost guard
├── db/                            # Drizzle ORM schema, migrations & seed scripts
├── fixtures/                      # Mock images & synthetic AI demo profiles
├── packages/plugin/               # Embeddable giftfit.js script tag
├── demo-store/                    # The demo store (separate origin): static pages for every Aurum design
└── tests/                         # E2E test suites (Playwright) & leak guards
```

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

## 🧪 Testing & Quality Gates

GiftFit enforces strict quality, privacy, and performance gates:

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
