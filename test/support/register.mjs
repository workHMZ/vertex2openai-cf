// Lets Node run the TypeScript sources directly, so coverage is reported
// against the real files and line numbers instead of an esbuild bundle.
// Node strips the types itself; this only fills in what bundlers allow and
// Node's ESM resolver does not: extensionless relative imports and a JSON
// import without an attribute.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return next(`${specifier}.ts`, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".json")) {
      const json = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", source: `export default ${json};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
