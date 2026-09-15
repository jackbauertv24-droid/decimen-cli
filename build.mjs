// Bundle the CLI into a single dependency-free ESM file so that
// `npx github:<owner>/decimen-cli` installs nothing and starts immediately.
import { build } from "esbuild";
import { copyFile, mkdir, chmod } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  // pngjs is CommonJS; an ESM bundle has no require() of its own to lend it.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __cliCreateRequire } from "node:module";',
      "const require = __cliCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
await chmod("dist/cli.js", 0o755);
// The codec binary stays a sibling of the bundle; src/codec.ts looks for it there.
await copyFile("vendor/decimen-codec/decimen_codec.wasm", "dist/decimen_codec.wasm");
console.log("dist/decimen_codec.wasm copied");
