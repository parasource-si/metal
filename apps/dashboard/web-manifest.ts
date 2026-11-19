import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const ICONS = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, purpose: "maskable" },
] as const;

/** writes manifest.webmanifest beside index.html and links it; the icons go to assets/ like every other file, so the
 * manifest names their hashed paths under `base` */
export function webManifest(iconDir: string, base: string): Plugin {
  return {
    name: "dusk-web-manifest",
    apply: "build",
    transformIndexHtml: () => [{ tag: "link", attrs: { rel: "manifest", href: `${base}manifest.webmanifest` }, injectTo: "head" }],
    generateBundle() {
      const icons = ICONS.map(({ file, size, purpose }) => {
        const ref = this.emitFile({ type: "asset", name: file, source: readFileSync(`${iconDir}/${file}`) });
        return { src: `${base}${this.getFileName(ref)}`, sizes: `${size}x${size}`, type: "image/png", purpose };
      });
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify({ id: base, name: "Metal", short_name: "Metal", start_url: base, scope: base, display: "standalone", background_color: "#ffffff", theme_color: "#ffffff", icons }, null, 2),
      });
    },
  };
}
