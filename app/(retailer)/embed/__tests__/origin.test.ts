import { describe, expect, it } from "vitest";
import { parentOrigin } from "../origin";

describe("embed parentOrigin", () => {
  it("accepts a bare http(s) origin only", () => {
    expect(parentOrigin("https://shop.example")).toBe("https://shop.example");
    expect(parentOrigin("http://127.0.0.1:4310/")).toBe("http://127.0.0.1:4310");
    for (const bad of [undefined, "", "null", "*", "javascript:alert(1)", "https://shop.example/path", "https://user:pw@shop.example", "file:///x"]) expect(parentOrigin(bad)).toBeNull();
  });
});
