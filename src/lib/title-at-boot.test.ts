import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PRODUCT_NAME } from "./brand";

describe("the window's name at boot", () => {
  it("is the product's name before the page is rendered", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const title = main.indexOf("document.title = productName();");
    const render = main.indexOf("createRoot(");
    expect(title).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(title);
    expect(PRODUCT_NAME).toBe("Metal");
  });
});
