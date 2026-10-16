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
3. **Returns are costly and inconvenient:** Processing a single fine jewelry return costs retailers **$30–$45** on average, and recipients often feel guilty returning gifts, leaving them unworn in drawers.

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
- **Multi-Factor Fit Engine (`lib/fit/score.ts`):** Combines recipient hearts (60%), skin undertone harmony (10%), face shape silhouette compatibility (15%), and budget/occasion fit (15%).
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

---

## 🏗 System Architecture

```
giftfit/
├── app/                           # Next.js 15 App Router
│   ├── (store)/                   # Aurum Jewelry demo e-commerce store
│   ├── (gift)/                    # Giver (/g/[token]) & Recipient (/r/[token]) flows
│   ├── (retailer)/                # Retailer Console (/retailer) & embed panel
│   └── api/                       # API route handlers (fit, recipient, retailer, demo)
├── components/                    # UI Components
│   ├── gift/                      # Giver panel, recipient carousel, camera capture, report
│   ├── store/                     # Product cards, catalog views, shopping bag
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
└── tests/                         # E2E test suites (Playwright) & leak guards
```

---

## 🛠 Getting Started

### Prerequisites
- Node.js 22+ & npm
- Python 3 (`py` on Windows) for optional YouCam skill verification

### 1. Installation
```bash
# Clone the repository
git clone https://github.com/agrhub/GiftFit.git
cd GiftFit

# Install dependencies
npm ci
```

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
Open [http://localhost:3000](http://localhost:3000) to explore the **Aurum Jewelry** storefront.

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

1. **Undertone is an Estimate:** Single-point skin color hex readings from cameras can fluctuate based on lighting. GiftFit calibrates CIELAB hue angles relative to skin depth across **Fitzpatrick I–VI**, openly labels results as *"AI estimate"*, and gives recipients a direct, friendly 1-tap override.
2. **Short-TTL Storage:** Selfies and hand photos are held in short-lived memory/storage for a maximum of 1 hour solely to process swatches.
3. **Signed HMAC URLs:** Try-on images use tamper-proof HMAC SHA-256 tokens valid for $\le 15$ minutes and bound to the recipient's secure cookie session.

---

## 🎨 Image Provenance & Licenses

All product and model imagery in GiftFit is strictly synthetic and rights-cleared:
- **Catalog Products (`public/catalog/aurum/`):** 161 jewelry items created by the team for the fictional *Aurum Jewelry* store (code-generated SVG/PNGs under CC0, plus AI-generated product photos via Google Flow). No real brand trademarks are used.
- **Demo Models (`fixtures/youcam/ai-demo/`):** All people displayed in demo fixtures and screenshots are **fictional, AI-generated models** created by the team. No real individuals' biometrics or likenesses exist in this repository.
- Full provenance log: [data/LICENSES.md](data/LICENSES.md) and [fixtures/youcam/ai-demo/README.md](fixtures/youcam/ai-demo/README.md).

---

## 👥 Authors & Acknowledgments

- Built by **the GiftFit Team** for the **YouCam API Skin AI & eCommerce VTO Hackathon (2026)**.
- Powered by [Perfect Corp. YouCam API](https://www.perfectcorp.com/business/products/youcam-api) and [Anthropic Claude](https://anthropic.com/).

---

## 📄 License

GiftFit is free and open-source software, licensed under the [MIT License](LICENSE).
