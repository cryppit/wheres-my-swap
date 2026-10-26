import { resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

import { SITE } from "./src/site.js";

/** Absolute URLs in the pages' meta tags (canonical, Open Graph) name the public site. */
const siteUrl: Plugin = { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE%", SITE) };

const web = resolve(import.meta.dirname, "web");

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [siteUrl],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(web, "index.html"), refund: resolve(web, "refund.html"), address: resolve(web, "address.html"), zec: resolve(web, "zec.html"), notFound: resolve(web, "404.html") } },
  },
  server: { port: 5003 },
});
