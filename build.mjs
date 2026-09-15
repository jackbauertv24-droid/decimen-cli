// Two bundles from one entry point:
//
//   dist/cli.js      the package binary; loads the codec from vendor/
//   dist/decimen.mjs a single self-contained file with the codec inlined,
//                    for machines where npm cannot reach a registry — download
//                    it and run `node decimen.mjs`, nothing else required
import { build } from "esbuild";
import { mkdir, chmod, readFile, stat } from "node:fs/promises";
import { execSync } from "node:child_process";

// Baked into --version so anyone can tell exactly which build they are running.
function gitRev() {
  try {
    const rev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    return dirty ? `${rev}-dirty` : rev;
  } catch {
    return "unknown";
  }
}

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const rev = gitRev();
const wasmB64 = (await readFile("vendor/decimen-codec/decimen_codec.wasm")).toString("base64");
await mkdir("dist", { recursive: true });

const common = {
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
  // pngjs is CommonJS; an ESM bundle has no require() of its own to lend it.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __cliCreateRequire } from "node:module";',
      "const require = __cliCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

const defines = (inlineWasm) => ({
  __PKG_VERSION__: JSON.stringify(pkg.version),
  __BUILD_REV__: JSON.stringify(rev),
  __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  __INLINE_WASM_B64__: JSON.stringify(inlineWasm ? wasmB64 : ""),
});

await build({ ...common, outfile: "dist/cli.js", define: defines(false) });
await chmod("dist/cli.js", 0o755);

await build({ ...common, outfile: "dist/decimen.mjs", define: defines(true) });
await chmod("dist/decimen.mjs", 0o755);

const kb = async (p) => `${Math.round((await stat(p)).size / 1024)} KB`;
console.log(`built ${rev}`);
console.log(`  dist/cli.js       ${await kb("dist/cli.js")}  (codec read from vendor/)`);
console.log(`  dist/decimen.mjs  ${await kb("dist/decimen.mjs")}  (codec inlined, self-contained)`);
