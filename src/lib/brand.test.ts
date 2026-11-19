import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, productName } from "./brand";

describe("product name", () => {
  it("uses Metal", () => {
    expect(productName()).toBe("Metal");
  });

  it.each(["index.html", "src/windows/rail.html", "src/windows/ambient.html"])("%s starts with the product name", (page) => {
    const html = readFileSync(new URL(`../../${page}`, import.meta.url), "utf8");
    expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
  });
});
