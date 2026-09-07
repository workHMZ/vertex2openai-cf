// Bundle the TypeScript sources with the esbuild binary that ships inside
// wrangler, then run the result on Node's built-in test runner. Keeps the
// suite dependency-free.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".test-build");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tests = readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(root, "test", f));

if (tests.length === 0) {
  console.error("No test files found in test/.");
  process.exit(1);
}

execFileSync(
  process.execPath,
  [
    require.resolve("esbuild/bin/esbuild"),
    ...tests,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--external:node:*",
    `--outdir=${outDir}`,
    "--out-extension:.js=.mjs",
    "--log-level=warning",
  ],
  { stdio: "inherit", cwd: root }
);

const bundles = readdirSync(outDir)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => path.join(outDir, f));

execFileSync(process.execPath, ["--test", ...bundles], {
  stdio: "inherit",
  cwd: root,
});
