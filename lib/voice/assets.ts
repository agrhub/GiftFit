/**
 * Same-origin URLs of the in-browser voice assets (owner: A13; consumed by A4's engine under
 * components/widget/voice/**). Written at image build by scripts/copy-ort-web.mjs and
 * scripts/fetch-supertonic.mjs; both folders are version-pinned and served `immutable` (next.config.ts).
 * Client-safe: constants only.
 */
export const SUPERTONIC_REVISION = "aafc6e32416a594460b32413efc49d7fe4ce6d46";
export const SUPERTONIC_BASE = `/voice/supertonic/${SUPERTONIC_REVISION.slice(0, 8)}/`;
export const SUPERTONIC_MANIFEST_URL = `${SUPERTONIC_BASE}manifest.json`;
export const SUPERTONIC_LICENSE_URL = `${SUPERTONIC_BASE}LICENSE`;
/** The one stock voice style shipped (shared by en and vi; no cloning, Open RAIL-M Attachment A(g)). */
export const SUPERTONIC_VOICE = "M1";
export const ORT_WEB_VERSION = "1.30.0";
export const ORT_BASE = `/voice/ort/${ORT_WEB_VERSION}/`;
