import { spawnSync } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testEntry = path.resolve(__dirname, "../test/index.test.ts");

const tempDir = mkdtempSync(path.join(tmpdir(), "rpg-widget-tests-"));
const outFile = path.join(tempDir, "index.test.mjs");

try {
  await build({
    entryPoints: [testEntry],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
    logLevel: "silent",
  });

  const result = spawnSync(process.execPath, ["--test", outFile], {
    stdio: "inherit",
  });

  process.exit(result.status ?? 1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
