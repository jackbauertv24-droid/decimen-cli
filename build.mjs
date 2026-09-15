// Bundle the CLI into a single dependency-free ESM file so that
// `npx github:<owner>/decimen-cli` installs nothing and starts immediately.
import { build } from "esbuild";
import { mkdir, chmod, readFile } from "node:fs/promises";
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
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
    __BUILD_REV__: JSON.stringify(gitRev()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
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
// The codec binary is NOT copied next to the bundle: src/codec.ts falls back to
// vendor/, and shipping 281 KB twice only makes the clone slower.
console.log("built", gitRev());
