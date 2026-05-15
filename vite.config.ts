import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  publicDir: false,
  plugins: [svelte({ configFile: "../svelte.config.js" })],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
