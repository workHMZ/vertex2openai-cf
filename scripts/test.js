// Run the unit tests on Node's built-in test runner, with no extra dependencies.
//
// Node 22.18+ strips TypeScript itself, so the sources run as-is and coverage
// is measured against the real files, with thresholds enforced. Older Node
// falls back to bundling with the esbuild binary that ships inside wrangler,
// which runs the same tests without a coverage report.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Anything below these fails the run. Branch coverage sits lower because of
// defensive `?? default` fallbacks for fields Vertex always sends.
const THRESHOLDS = { lines: 99, branches: 90, functions: 100 };

const tests = readdirSync(path.join(root, "test"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("test", f));

if (tests.length === 0) {
  console.error("No test files found in test/.");
  process.exit(1);
}

const run = (args) =>
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: root });

const canRunTypeScript =
  process.features.typescript && typeof module.registerHooks === "function";

try {
  if (canRunTypeScript) {
    run([
      "--import",
      "./test/support/register.mjs",
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-exclude=test/**",
      `--test-coverage-lines=${THRESHOLDS.lines}`,
      `--test-coverage-branches=${THRESHOLDS.branches}`,
      `--test-coverage-functions=${THRESHOLDS.functions}`,
      ...tests,
    ]);
  } else {
    console.warn(
      `Node ${process.version} cannot run TypeScript directly; running the bundled tests without coverage.`
    );
    const outDir = path.join(root, ".test-build");
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    run([
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
    ]);
    const bundles = readdirSync(outDir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join(outDir, f));
    run(["--test", ...bundles]);
  }
} catch {
  // The runner has already printed the failing tests or the coverage shortfall.
  process.exit(1);
}
