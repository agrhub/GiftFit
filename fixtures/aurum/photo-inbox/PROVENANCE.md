# Photo inbox: provenance

- **Tool**: Google Flow (flow.google.com), image model "Nano Banana 2.1", 1:1, 2 variants per prompt; best variant chosen by a human-supervised review.
- **Account / project**: the team's own Flow account, project "YouCam".
- **Date generated**: 2026-10-15. **Downloaded**: 2026-10-15, with the user's approval, from the project's signed CDN URLs.
- **Inputs**: text prompts only, written by the team from `fixtures/aurum/catalog.json` attributes. No third-party product photos, brand images or reference images were uploaded.
- **Output**: 1024×1024 JPEG, white background, no visible watermark observed. Google embeds an invisible SynthID watermark in generated images.
- **Credits used**: 0 (Flow showed "Generating will use 0 credits").
- **Disclosure**: AI-generated product imagery for a fictional demo store. Label as such in LICENSES.md and the README.
- **Format note**: files are `.jpg` (Flow output), not `.png`.

Common prompt frame for every file (product-specific sentence in the table): "Professional e-commerce product photograph of …, on a pure white seamless background. … Only ONE item, no person/hand/ear, no box, no props, no text, no logo, no watermark. Soft even studio lighting, sharp focus, photorealistic."

| File | SKU | Product-specific prompt content | Notes |
|---|---|---|---|
| aur-ear-028.jpg | AUR-EAR-028 Halo Drop Earrings | single drop earring, front view; 10k yellow gold; round lab-grown diamond bezel stud top, jump ring, teardrop pendant with pear lab-grown diamond centre and white topaz halo | Hero item |
| aur-ear-038.jpg | AUR-EAR-038 Jubilee Pearl Chandeliers | single chandelier earring, front view; 10k white gold openwork filigree frame; three dangling freshwater pearls of graduated size | Regenerated alone after a merged first attempt |
| aur-ear-034.jpg | AUR-EAR-034 Chime Bell Drop Earrings | single bell-shaped drop earring, front view; 10k rose gold; lab-grown diamond pavé along the bell rim | Source prompt was accidentally merged with the pearl chandelier prompt; the chosen variant shows only the rose gold bell drop. Check the rim stones against the description |
| aur-ear-042.jpg | AUR-EAR-042 Cove Fringe Earrings | single short chandelier/fringe earring, front view; 10k yellow gold half-moon bar with a fan of fine chains and beads; no stones | |
| aur-ear-002.jpg | AUR-EAR-002 Dot Bezel Studs | single round bezel stud, front view; sterling silver; one small round white topaz | Regenerated alone after a merged first attempt |
| aur-nec-037.jpg | AUR-NEC-037 Reverie Pear Pendant | necklace shown as worn, front view, ghost-mannequin drape; 10k white gold cable chain, 22 in V drape; large pear lab-grown diamond pendant | Regenerated alone after a merged first attempt |
| aur-nec-021.jpg | AUR-NEC-021 Starlit Bib Collar | necklace shown as worn, front view; 10k yellow gold 18 in collar; horizontal bib of peridot in gold bezels with white topaz accents | |
| aur-nec-009.jpg | AUR-NEC-009 Nightfall Crescent Pendant | necklace shown as worn, front view; 10k rose gold fine chain, 18 in U drape; polished crescent moon pendant, no stones | |
| aur-nec-017.jpg | AUR-NEC-017 Regal Pavé Choker | necklace shown as worn, front view; 10k yellow gold 14 in wide choker band, white topaz pavé | **VTO risk**: rendered as a closed full circle, not a front "as worn" drape with chain ends; verify with the necklace VTO or regenerate |
| aur-rng-005.jpg | AUR-RNG-005 Radiance Halo Ring | single ring, three-quarter front view about 45°; 14k rose gold; oval blue sapphire centre with diamond halo | |
| aur-brc-003.jpg | AUR-BRC-003 Prism Line Gemstone Tennis Bracelet | single tennis bracelet, three-quarter view about 45°; sterling silver; continuous line of round white topaz | Source prompt was accidentally merged with the watch prompt; the chosen variant shows only the bracelet. **VTO risk**: closer to upright front view than 45° |
| aur-wch-002.jpg | AUR-WCH-002 Ashford Dress Watch 40 | men's dress watch, flat front view, face upright; 40 mm two-tone steel case with gold-tone bezel; silver dial, gold-tone baton markers; black leather strap straight up and down, no buckle or clasp visible; no text on dial | Regenerated alone after a merged first attempt |

## v2 replacements (try-on spec fixes)

Generated and downloaded the same day, same tool, account, model and settings, text prompts only, 0 credits, with the user's approval. They replace the three files A2 marked display-only. The v1 files are kept for reference.

| File | SKU | Fix in the prompt | Result |
|---|---|---|---|
| aur-nec-017-v2.jpg | AUR-NEC-017 Regal Pavé Choker | Shown as worn from the front as an open U curve. Back of the necklace not visible, not a closed circle. Band ends inside the frame at the upper left and right. | Open U collar, both ends visible inside the frame |
| aur-brc-003-v2.jpg | AUR-BRC-003 Prism Line Gemstone Tennis Bracelet | Closed loop tilted about 45° toward the camera, seen as a clear open ellipse. Not edge-on, not top-down. | Clear ellipse with the front stones facing the camera |
| aur-nec-009-v2.jpg | AUR-NEC-009 Nightfall Crescent Pendant | Whole necklace inside the frame. Both chain ends finish at the upper left and right with margin. | Chain ends inside the frame. The pendant is now an upturned "horn" crescent instead of a C-shaped crescent; it still matches "crescent pendant, rose gold, no stones" |

### Correction (same day): v2 filenames were mismatched

The parent session mapped image URLs to SKUs by DOM order while Flow was still rendering, so two v2 files got the wrong names. Each file was checked by eye afterwards:

| File | Actual content | Use |
|---|---|---|
| aur-nec-009-v2.jpg | Rose gold horn crescent pendant, whole necklace inside the frame | AUR-NEC-009 (correct name) |
| aur-nec-017-v2.jpg | **Silver tennis bracelet at about 45°** | AUR-BRC-003 (A2 already wired it that way) |
| aur-brc-003-v2.jpg | **Second variant of the rose gold crescent pendant** | Spare for AUR-NEC-009; not a bracelet |
| aur-nec-017-v3.jpg | **Yellow gold pavé choker as an open U, front view, ends inside the frame** | AUR-NEC-017. Added after the mismatch was found; downloaded under the same approval, URL taken by tile caption |
