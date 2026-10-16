/**
 * A deliberately naive estimator used only to prove the harness catches depth bias: it calls
 * anything with a* > b* * 0.9 or low lightness "cool". Never used by the product.
 */
import type { JewelryRules } from "@/lib/contracts/giftfit";
import { hexToLab, hueDeg } from "./color";

export const naiveHueEstimator: Pick<JewelryRules, "estimateUndertone"> = {
  estimateUndertone(colors) {
    const lab = hexToLab(colors.skin_color);
    const h = hueDeg(lab);
    // The classic mistake: treating "dark" as "cool".
    const undertone = lab.L < 40 || h < 55 ? "cool" : h > 70 ? "warm" : "neutral";
    return { undertone, confidence: 0.8, lab, hueDeg: h };
  },
};
