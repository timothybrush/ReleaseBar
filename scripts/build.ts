import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDashboard, normalizeBuildOptions } from "./lib/dashboard.js";
import type { ReleaseBarConfig } from "../src/types.js";

const root = process.cwd();
const distDir = path.join(root, "dist");
const configPath = path.join(root, "releasebar.config.json");
const publicDir = path.join(root, "src");
const checkOnly = process.argv.includes("--check");
const assetsOnly = process.argv.includes("--assets-only");

async function finishStaticAssets(): Promise<void> {
  await mkdir(path.join(distDir, "data"), { recursive: true });

  for (const file of [
    "favicon.ico",
    "favicon.svg",
    "apple-touch-icon.png",
    "og-card.png",
    "github-app-logo.svg",
    "github-app-logo.png",
  ]) {
    await copyFile(path.join(publicDir, file), path.join(distDir, file));
  }
  for (const file of [
    "jetbrains-mono-latin-400-normal.woff2",
    "jetbrains-mono-latin-700-normal.woff2",
  ]) {
    await copyFile(
      path.join(root, "node_modules", "@fontsource", "jetbrains-mono", "files", file),
      path.join(distDir, file),
    );
  }

  await copyFile(path.join(distDir, "index.html"), path.join(distDir, "404.html"));
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ReleaseBarConfig;
  if (assetsOnly) {
    await finishStaticAssets();
    return;
  }

  const payload = await buildDashboard(
    normalizeBuildOptions(config, {
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
      log: (message) => process.stdout.write(`${message}\n`),
    }),
  );

  if (checkOnly) {
    console.log(JSON.stringify(payload.totals, null, 2));
    return;
  }

  await finishStaticAssets();
  await writeFile(
    path.join(distDir, "data", "projects.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(`built ${payload.projects.length} projects at ${payload.generatedAt}`);
}

await main();
