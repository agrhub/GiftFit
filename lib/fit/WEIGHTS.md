# Fit Score: published weights and formula (`fit-v1.1`)

Source of truth in code: `lib/fit/weights.ts` (`FIT_WEIGHTS`, `FIT_PARAMS`, `FIT_FORMULA`), served at `GET /api/fit/weights`.
Changing any number means bumping `FIT_WEIGHTS_VERSION` and updating the golden tests (`lib/fit/__tests__/golden.test.ts`).

**fit-v1.1 (ADR-031, ADR-032)**: a product is a design and each metal is a variant. Scores are per variant; hearts attach to a variant; the camera-based undertone factor drops from 20 to 10 because on real faces it reads "neutral, low confidence" (ADR-031); hearts rise from 50 to 60. fit-v1.0 numbers are superseded.

## Weights

| Factor | Points | Input | Notes |
|---|---|---|---|
| **Hearts** | **60** | the recipient's own hearts, per variant | The dominant weight: more than the other three combined (40) |
| Metal ↔ undertone | 10 | `rules.metalFit(variant metal, undertone)` (jewelry_rules.md Table 1) | Low weight, shrunk by undertone confidence |
| Style ↔ face shape | 15 | `rules.styleFit(attributes, faceShape)` (Tables 2a and 2b) | No rule gives the midpoint |
| Budget + occasion | 15 | the giver's request | 60% budget, 40% occasion |

## Which variants are scored

- **Eligible** (`eligibleVariants`): priced ≤ `budgetMax`, in the request currency, inside the optional `metalLock`. Only these ever reach the recipient, so any choice is affordable. `budgetMin` is optional (a soft floor only).
- **Visible** (`visibleVariants`): eligible variants, leveled to the request's swatch cap (see Decoys, swatch leveling).
- `fitScore` scores the design once per visible variant (every variant if none is eligible, for legacy callers) and reports **the hearted variant** (best-scoring among hearted ones), else **the best-scoring variant**; ties keep the giver's listing order. `FitResult` carries `variantId`, `metal`, `price` and `wishOtherMetal`.
- **Default swatch** (`defaultVariant`): the visible variant whose metal tone matches the undertone (their override, else the estimate even at low confidence); else the giver's listed variant (`variants[0]`) if visible; else the first visible one.

## Formula

```
score = round(hearts + metal + style + budgetOccasion), clamped to 0..100

hearts = 60 × h
  h = 1                         a hearted variant (or a hearted design with no variant recorded)
  h = 0.6                       another metal of a design with a hearted variant
  h = 0.5                       "love the style, wish it came in another metal" (no variant hearted)
  h = 0.4 × sim                 else, if their most similar hearted piece in the same category has sim ≥ 0.5
  h = 0                         otherwise
  sim = 0.5 × Jaccard(style words + shape token) + 0.5 × [same metal]   (hearted pieces compared in the hearted metal)

metal = 10 × (0.5 + c × (m − 0.5))
  m = (w + 1) / 2, w = rule weight for the variant's metal, clamped to [−1, 1] (recommended 1.0, acceptable 0.4, avoid −1.0)
  undertone used = undertoneOverride ?? undertoneEstimate
  c = 1 if they set the undertone themselves, else undertoneConfidence clamped to [0, 1]

style = 15 × (w + 1) / 2
  Unknown face shape, rings, bracelets and watches have no rule: w = 0, style = 7.5

budgetOccasion = 15 × (0.6 × b + 0.4 × o)
  b = 1 at or under the cap (and at or above budgetMin when given); outside, 1 − d / 0.25 (floor 0); 0 if the currency differs
  o = 1 if the SKU is tagged for the occasion, else 0.4
```

Breakdown values returned to the giver are the points per factor, rounded to one decimal; the score is the rounded sum of the unrounded points.

### How low confidence shrinks the metal factor
The metal factor is pulled toward its midpoint (5 points) in proportion to `1 − c`. At `c = 1` a recommended metal earns 10 and an acceptable one 7; at the real-world `c = 0.2` (ADR-031) they earn 6 and 5.4, so metals differ by 0.6 points and a heart (60) always decides. When `c < 0.5` the giver sees the caution "Their undertone estimate is low confidence, so treat the metal advice lightly." The recipient's own override counts as `c = 1`.

### Worked example (MASTER_PLAN §3.3 step 6)
"Halo Drop", hearted in white gold ($265), neutral estimate at 0.2 (white gold recommended for neutral), oval face with teardrop earrings, cap $300, tagged anniversary:
60 + 10 × (0.5 + 0.2 × 0.5) + 15 + 15 = 60 + 6 + 15 + 15 = **96**, reported as "Halo Drop in white gold, $265".


## What the giver sees
`FitResult` only: `skuId`, `variantId`, `metal`, `price`, `wishOtherMetal`, `score`, `breakdown` (the four point values), two reasons and one caution of at most 20 words each; the report adds `heartedShortlistIds`, `otherMetalWishes` (shortlist designs only) and label strings. Labels are words, never measurements: "Warm undertone estimate suits yellow gold.", "Oval face shape suits teardrop earrings.". No hex, CIELAB, confidence numbers, face measurements or images (MASTER_PLAN v2 rule 1). Hearts and wishes on decoys are never revealed. Every response passes `giverJson` (lib/privacy).

## Decoys (G5)

`selectDecoys(shortlist, catalog, { seed })`, seed = HMAC(server secret, Fit Request id):

1. Decoys needed = max(2, 6 − shortlist size).
2. Slots are dealt round-robin, most isolated shortlist item first (so no shortlist item is the only one of its kind), ties in seeded order.
3. Tiers (each relaxation adds a reason code): tier 0 same category, same metal tone, style Jaccard ≥ 0.3, price ±20% of the shadowed item → 1 `STYLE_RELAXED` → 2 `METAL_RELAXED` → 3 `PRICE_BAND_WIDENED` (±35%) → 4 `CATEGORY_RELAXED`; still short → `INSUFFICIENT_CATALOG`, `ok: false`. Always: same currency, try-on ready (`vto_spec_ok` and `vto_image`), never in the shortlist, no duplicates.
4. Anti-centroid: a seeded price rank r for the shadowed item (uniform over what the catalog allows; the pool may widen to tier 2 only if that makes every rank possible), then for groups of 2+ decoys a seeded search keeps the set whose price rank, price-spread rank and visible-centrality rank for the shortlist item match seeded targets. Narrowed rank ranges report the soft code `PRICE_SPREAD_SKEWED`.
5. Carousel order = seeded Fisher-Yates shuffle (input order is normalised first).
6. **Metal variants** (ADR-032), when the request is given: every design is compared as its default eligible variant; designs with no eligible variant are never decoys, so decoy swatches obey the same cap and lock. Inside tiers 0–2 (same category, ±20%): **parity mode** applies when the pool can give all k decoys of a multi-metal item its swatch count. Then the count gap ranks first (then the default metal), every decoy gets the same count, and the pool may reach into tier 2. Otherwise the swatches will be leveled anyway, so the **default metal** ranks first (then the count gap). In both modes at least one decoy shares the item's default metal whenever tiers 0–2 offer one, because recipients see metals but never prices.
7. **Swatch leveling** (`swatchCap`): the most swatches any design shows is the largest c with S_c/|S| ≤ D_c/|D| (share of shortlist designs with ≥ c eligible swatches no larger than the share of decoys), so "the design with the most metals" is never more likely to be a pick. Designs above the cap show their first c eligible variants in listing order. Cost: a multi-metal pick may show fewer metals when no comparable multi-metal decoy exists (batch 2: the demo shortlist Halo Drop + Reverie + Chime Bell keeps all 3 metals; a single multi-metal pick usually shows 1).
8. **Gender-presentation parity** (`compatibleGenders`): `attributes.gender_presentation` (missing = unisex). Compatible decoys:
   - masculine pick → masculine or unisex;
   - feminine pick → feminine or unisex;
   - unisex pick → unisex plus the gendered presentations among the picks.

   Exact matches rank first and outrank price-rank balance; a pick may reach into tier 2 for one. After selection, a share pass makes each gendered presentation as common among decoys as among picks, swapping unisex picks' decoys, no wider a tier. Only when no compatible decoy can fill a slot is another presentation used (`GENDER_RELAXED`, hard reason code). The default-metal guarantee also covers shortlist metals that no decoy matches yet, never at the cost of gender exactness.

Guess probability (`estimateGuessProbability`): see docs/reports/A3.md for the measured numbers.

## Return-Risk (G8)

`lib/fit/returnRisk.ts`. An **estimate**, not a measured return rate:

```
multiplier(score) = clamp(1 + 0.5 × (50 − score) / 50, 0.5, 1.5)
P(return)         = baselineRate × multiplier(score)
expected cost     = P(return) × costPerReturn
```
Defaults: baselineRate 11% (fine jewelry online midpoint, market.md K3 / S31), costPerReturn $37 (jewelry mid all-in processing cost, market.md K6 / S5), maxReduction 0.5 (our assumption, unmeasured). Markdown loss on resale (K5 / S31) is excluded. All three inputs are editable in the console.
