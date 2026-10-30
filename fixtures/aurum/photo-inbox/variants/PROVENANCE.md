# Metal-variant photos: provenance (ADR-032)

- **Tool**: Google Flow, "Nano Banana 2.1", **image edit** mode. Each variant was made by opening the existing catalog photo in Flow and asking it to change *only* the metal, so design, stones, framing and lighting stay identical across variants.
- **Account / project**: the team's own Flow account, project "YouCam".
- **Date**: edited and downloaded 2026-10-15, with the user's approval. **Credits**: 0.
- **Inputs**: the team's own AI-generated catalog photos (see `../PROVENANCE.md`) plus text edit instructions. No third-party images.
- **Format**: 1024×1024 JPEG, white background.
- **Disclosure**: AI-generated product imagery for a fictional demo store.
- **Checks**: every file was checked by eye against its label in a labelled sheet before download. The three Chime Bell versions were compared side by side at full resolution afterwards: the design, ball stud and diamond rim match.

Edit prompt frame: "Change only the metal [from X] to Y. Keep everything else exactly identical: same design, same stones, same proportions, same size and position in the frame, same lighting, same pure white background, photorealistic product photo."

| File | Design (SKU) | Source photo (existing variant) | New metal |
|---|---|---|---|
| aur-ear-028-white_gold.jpg | Halo Drop Earrings (AUR-EAR-028) | yellow gold | 14k white gold |
| aur-ear-028-rose_gold.jpg | Halo Drop Earrings (AUR-EAR-028) | yellow gold (edited from the white gold step) | 14k rose gold |
| aur-nec-009-yellow_gold.jpg | Nightfall Crescent Pendant (AUR-NEC-009, v2 horn crescent) | rose gold | 14k yellow gold |
| aur-nec-009-silver.jpg | Nightfall Crescent Pendant (AUR-NEC-009) | rose gold (edited from the yellow gold step) | 925 sterling silver |
| aur-nec-037-yellow_gold.jpg | Reverie Pear Pendant (AUR-NEC-037) | white gold | 14k yellow gold |
| aur-nec-037-rose_gold.jpg | Reverie Pear Pendant (AUR-NEC-037) | white gold (edited from the yellow gold step) | 14k rose gold |
| aur-ear-002-yellow_gold.jpg | Dot Bezel Studs (AUR-EAR-002) | sterling silver | 14k yellow gold |
| aur-ear-038-yellow_gold.jpg | Jubilee Pearl Chandeliers (AUR-EAR-038) | white gold | 14k yellow gold |
| aur-ear-034-yellow_gold.jpg | Chime Bell Drop Earrings (AUR-EAR-034) | rose gold | 14k yellow gold |
| aur-ear-034-white_gold.jpg | Chime Bell Drop Earrings (AUR-EAR-034) | rose gold (edited from the yellow gold step) | 14k white gold |

**Change from the ADR-032 message**: Halo Drop gets **rose gold instead of sterling silver**. Lab-grown diamonds in silver are uncommon, and silver is visually indistinguishable from white gold in a photo. Rose gold gives a clearly different swatch for the demo. So Halo Drop's variants are yellow gold, white gold and rose gold.

**Material naming**: the photos show 14k for gold variants. If the catalog keeps 10k for an existing variant, the new variants can be priced as 10k or 14k at A2's discretion; the photo does not distinguish karat.

## Batch 2 (ADR-035, strict swatch leveling): 8 more variants

Same tool, account, mode and prompt frame as above. Edited and downloaded 2026-10-15 with the user's approval; 0 credits. Each new version was identified in Flow's version history (not by on-screen order). Its average metal colour was measured against the source photo (white gold neutral, e.g. RGB ≈ 186/186/187; rose gold shifted pink, with lower G and higher B than yellow gold). Every file was checked again by eye on a labelled sheet after download.

| File | Design (SKU) | Source photo | New metal |
|---|---|---|---|
| aur-ear-042-white_gold.jpg | Cove Fringe Earrings (AUR-EAR-042) | yellow gold | 14k white gold |
| aur-ear-042-rose_gold.jpg | Cove Fringe Earrings (AUR-EAR-042) | yellow gold (chained edit) | 14k rose gold |
| aur-nec-021-white_gold.jpg | Starlit Bib Collar (AUR-NEC-021) | yellow gold | 14k white gold |
| aur-nec-021-rose_gold.jpg | Starlit Bib Collar (AUR-NEC-021) | yellow gold (chained edit) | 14k rose gold |
| aur-nec-017-white_gold.jpg | Regal Pavé Choker (AUR-NEC-017, v3 open-U photo) | yellow gold | 14k white gold |
| aur-nec-017-rose_gold.jpg | Regal Pavé Choker (AUR-NEC-017) | yellow gold (chained edit) | 14k rose gold |
| aur-ear-038-rose_gold.jpg | Jubilee Pearl Chandeliers (AUR-EAR-038) | yellow gold variant (chained from white gold) | 14k rose gold |
| aur-ear-002-rose_gold.jpg | Dot Bezel Studs (AUR-EAR-002) | yellow gold variant (chained from silver) | 14k rose gold |

Result with batch 1: **9 three-metal designs** (5 earrings: EAR-028, EAR-034, EAR-038, EAR-042, EAR-002; 4 necklaces: NEC-009, NEC-017, NEC-021, NEC-037).
