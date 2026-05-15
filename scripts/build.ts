import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { buildDashboard, normalizeBuildOptions } from "./lib/dashboard.js";
import type { ReleaseDeckConfig } from "../src/types.js";

const root = process.cwd();
const distDir = path.join(root, "dist");
const configPath = path.join(root, "releasedeck.config.json");
const publicDir = path.join(root, "src");
const checkOnly = process.argv.includes("--check");

async function copyStaticAssets(config: ReleaseDeckConfig): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "data"), { recursive: true });

  for (const file of [
    "index.html",
    "styles.css",
    "favicon.ico",
    "favicon.svg",
    "apple-touch-icon.png",
    "og-card.png",
    "github-app-logo.svg",
    "github-app-logo.png",
  ]) {
    await copyFile(path.join(publicDir, file), path.join(distDir, file));
  }

  for (const file of ["app.ts", "routing.ts"]) {
    const source = await readFile(path.join(publicDir, file), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        removeComments: false,
      },
      fileName: file,
    });
    await writeFile(path.join(distDir, file.replace(/\.ts$/, ".js")), output.outputText);
  }

  await writeFile(path.join(distDir, "CNAME"), `${config.canonicalDomain}\n`);
  await copyFile(path.join(distDir, "index.html"), path.join(distDir, "404.html"));
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ReleaseDeckConfig;
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

  await copyStaticAssets(config);
  await writeFile(
    path.join(distDir, "data", "projects.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  console.log(`built ${payload.projects.length} projects at ${payload.generatedAt}`);
}

await main();
