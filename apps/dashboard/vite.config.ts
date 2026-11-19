import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { licenseFiles } from "../../scripts/license-files.ts";
import { webManifest } from "./web-manifest.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// the dashboard service (apps/dashboard/server/main.ts); `pnpm dashboard:fixture` starts one with a fake account server
const base = process.env.DUSK_DASHBOARD_BASE || "/";
const service = process.env.DUSK_DASHBOARD_SERVICE || "http://127.0.0.1:7480";

// the hosted account dashboard page; the @ alias reaches the app's connector catalogue
export default defineConfig({
  root: here("."),
  // DUSK_DASHBOARD_BASE=/dashboard/ serves the page under /dashboard on an origin it shares with the site
  base,
  publicDir: false,
  plugins: [react(), tailwindcss(), licenseFiles(here("../..")), webManifest(here("./icons"), base)],
  resolve: { alias: { "@": here("../../src") } },
  define: { __APP_VERSION__: JSON.stringify("dashboard"), __DUSK_SITE_URL__: JSON.stringify(process.env.DUSK_SITE_URL || "") },
  build: { outDir: here("./dist"), emptyOutDir: true,
    // the admin panel's own chunks sit in assets/admin, which the service hands only to an admin (server/app.ts)
    rollupOptions: { output: { chunkFileNames: (chunk) => chunk.moduleIds.length > 0 && chunk.moduleIds.every((id) => id.includes("/src/admin/")) ? "assets/admin/[name]-[hash].js" : "assets/[name]-[hash].js" } } },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DUSK_DASHBOARD_DEV_PORT) || 5288,
    // a worktree may link node_modules from another checkout; its fonts must still be served
    fs: { allow: [here("../.."), realpathSync(here("../../node_modules"))] },
    proxy: { "/v1": { target: service }, "/.well-known": { target: service } },
  },
  preview: { host: "127.0.0.1", port: Number(process.env.DUSK_DASHBOARD_DEV_PORT) || 5288 },
});
