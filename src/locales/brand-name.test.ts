import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../lib/brand";
import { locales } from "./index";

describe("Metal product branding", () => {
  it("uses the Metal name across locale packs", () => {
    expect(PRODUCT_NAME).toBe("Metal");
    const offending = Object.entries(locales).flatMap(([code, pack]) => Object.entries(pack)
      .filter(([, value]) => /(?<![\w@./-])dusk[ -]?bot(?!\w|\.[A-Za-z]|:| speech)/i.test(value ?? ""))
      .map(([key]) => `${code}:${key}`));
    expect(offending).toEqual([]);
  });
});
