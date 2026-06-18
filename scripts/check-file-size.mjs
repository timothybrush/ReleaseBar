import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const maxLines = 999;
const generatedFiles = new Set(["package-lock.json"]);
const maintainedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svelte",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
]);

async function maintainedFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(
      (name) =>
        name && !generatedFiles.has(name) && maintainedExtensions.has(extname(name).toLowerCase()),
    );
}

const violations = [];
for (const name of await maintainedFiles()) {
  let source;
  try {
    source = await readFile(join(root, name), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  const lines = source === "" ? 0 : source.split(/\r?\n/).length - Number(source.endsWith("\n"));
  if (lines > maxLines) violations.push({ name, lines });
}

if (violations.length > 0) {
  for (const { name, lines } of violations.sort((a, b) => b.lines - a.lines)) {
    console.error(`${name}: ${lines} lines (maximum ${maxLines})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Maintained files are at most ${maxLines} lines.`);
}
