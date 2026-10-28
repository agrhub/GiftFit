import { describe, expect, it } from "vitest";
import { joinUnspaced } from "../stt";

describe("joinUnspaced (chirp_3 token spacing)", () => {
  it("joins Japanese and Chinese tokens, keeps spaces next to Latin text and digits", () => {
    expect(joinUnspaced("母 の 誕生日 プレゼント を 探し て い ます 。 予算 は $150 です 。")).toBe("母の誕生日プレゼントを探しています。予算は $150 です。");
    expect(joinUnspaced("我 想 给 妈妈 买 金色 耳环 。")).toBe("我想给妈妈买金色耳环。");
    expect(joinUnspaced("ゴールド の ピアス 、 18K")).toBe("ゴールドのピアス、 18K");
  });

  it("leaves spaced languages alone", () => {
    for (const t of ["선물 도우미 추천해 주세요", "Mình muốn tìm quà", "gold earrings under $150", "ต่างหู ทอง สำหรับ แม่"]) expect(joinUnspaced(t)).toBe(t);
  });
});
