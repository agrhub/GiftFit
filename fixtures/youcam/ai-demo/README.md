# AI-demo fixtures: real YouCam results for fictional AI-generated people

**Every subject here is a fictional, AI-generated person. None depicts or is derived from a real person.** In any judged material (video, screenshots, Devpost, the seeded judge Fit Request), show them as **"AI-generated model"**, never as a real customer or recipient.

These are real responses from the YouCam API, committed on purpose (user decision, ADR-030) so the seeded judge demo can run without a selfie and without spending units.

## What is here
Files follow the mock-fixture shape (`response.data.task_status / results`) with:
- `_synthetic: false`: a real API response, not hand-made;
- `_ai_generated_subject: true`;
- `_subject_set`: where the source image came from.

Task ids and cache keys are stripped (the tasks were deleted at YouCam after recording). No URLs. Images are included only under `showcase/*/tryons/` (try-on renders of fictional AI models, for the seeded judge demo and the video).

| File prefix | Subject | Source image (git-ignored) | Provenance |
|---|---|---|---|
| `portrait-fz1-fair-cool`, `-fz3-lightmed-warm`, `-fz4-olive-neutral`, `-fz5-deep-warm`, `-fz6-deep-cool` | Fairness-set AI portraits, bare skin | `fixtures/youcam/real/inbox/ai/` | Google Flow ("Nano Banana 2.1"), text prompts only, 2026-10-15; see PROVENANCE.md there. Prompt-intended labels are not measurements (`docs/research/fairness_real_api.md`). |
| `smoke-portrait` | The first-smoke portrait | `fixtures/youcam/real/inbox/` | AI-generated portrait provided by the user (ADR-027). |
| `showcase/<subject>/` (3) | Styled demo recipients: hero (Latina, warm), Black woman (deep, warm), man (light-medium, neutral) | `fixtures/youcam/real/inbox/showcase/` | Google Flow, user-approved (ADR-029). Tones + face attributes + try-on JPEGs (re-encoded 1080 px) for the demo carousel; `showcase/manifest.json` records the demo seed, picks, decoys and metals (ADR-037). The try-on images show the AI model's face: label them "AI-generated model" wherever they appear. |

## Rules
- Only fictional AI people go here. **Never commit anything derived from a real person.** `fixtures/youcam/real/` stays git-ignored as the default landing place for any future input.
- Source images are added here only if the seeded demo must display them, labelled "AI-generated model" and with the visible AI sparkle kept.
- Hex colors and face attributes here describe fictional people, so they are not personal data. Giver-facing routes still never return them (privacy rules apply to the product regardless of the subject).
