// The Decimen QR reader (zxing-cpp, reader-only, compiled to WASM) driven from
// Node. The upstream Emscripten glue only knows how to fetch its .wasm in a
// browser or worker — its Node branch is empty — so we never let it locate the
// binary and hand it an already-instantiated module through instantiateWasm.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import DecimenCodec from "../vendor/decimen-codec/decimen_codec.js";
import type { DecimenModule } from "../vendor/decimen-codec/decimen_codec.js";

// Replaced at build time in the single-file bundle with the codec as base64,
// and left empty in the normal build, which reads the .wasm from disk.
declare const __INLINE_WASM_B64__: string;

let cached: Promise<DecimenModule> | null = null;

/** Where the .wasm sits next to the bundled CLI, and in the source tree. */
function wasmCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "decimen_codec.wasm"),
    join(here, "..", "vendor", "decimen-codec", "decimen_codec.wasm"),
  ];
}

export function loadCodec(): Promise<DecimenModule> {
  cached ??= (async () => {
    // The single-file build carries the codec inside it, so there is nothing
    // to find on disk and nothing to keep next to the script.
    if (__INLINE_WASM_B64__.length > 0) {
      const inlined = Buffer.from(__INLINE_WASM_B64__, "base64");
      return DecimenCodec({
        instantiateWasm(imports, done) {
          void (async () => {
            const { instance, module } = await WebAssembly.instantiate(inlined as BufferSource, imports);
            done(instance, module);
          })();
          return {};
        },
      });
    }

    let bin: Buffer | null = null;
    for (const path of wasmCandidates()) {
      try {
        bin = await readFile(path);
        break;
      } catch {
        // try the next location
      }
    }
    if (!bin) throw new Error(`decimen_codec.wasm not found (looked in: ${wasmCandidates().join(", ")})`);
    const binary = bin;
    return DecimenCodec({
      instantiateWasm(imports, done) {
        void (async () => {
          const { instance, module } = await WebAssembly.instantiate(binary as BufferSource, imports);
          done(instance, module);
        })();
        return {};
      },
    });
  })();
  return cached;
}

export interface RgbaFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Every QR payload found in one frame. `maxSymbols` should match the sender's
 * grid, plus slack — reading more costs time on a frame that holds fewer.
 */
export interface ReadSymbol {
  bytes: Uint8Array;
  /** Symbol dimension in modules (17 + 4·version); 0 when the codec could not tell. */
  modules: number;
}

/** Like readFrame, but keeps the symbol geometry alongside the payload. */
export function readSymbols(zx: DecimenModule, frame: RgbaFrame, maxSymbols: number): ReadSymbol[] {
  const bytes = frame.width * frame.height * 4;
  const ptr = zx._malloc(bytes);
  try {
    zx.HEAPU8.set(frame.data.subarray(0, bytes), ptr);
    const vec = zx.readFull(ptr, frame.width, frame.height, true, maxSymbols, false);
    try {
      const out: ReadSymbol[] = [];
      for (let i = 0; i < vec.size(); i++) {
        const r = vec.get(i);
        if (r.valid && r.bytes.length > 0) out.push({ bytes: new Uint8Array(r.bytes), modules: r.modules });
      }
      return out;
    } finally {
      vec.delete();
    }
  } finally {
    zx._free(ptr);
  }
}

export function readFrame(zx: DecimenModule, frame: RgbaFrame, maxSymbols: number): Uint8Array[] {
  const bytes = frame.width * frame.height * 4;
  const ptr = zx._malloc(bytes);
  try {
    zx.HEAPU8.set(frame.data.subarray(0, bytes), ptr);
    const vec = zx.readFull(ptr, frame.width, frame.height, true, maxSymbols, false);
    try {
      const out: Uint8Array[] = [];
      for (let i = 0; i < vec.size(); i++) {
        const r = vec.get(i);
        // Copy: the embind view points into WASM memory that the next read reuses.
        if (r.valid && r.bytes.length > 0) out.push(new Uint8Array(r.bytes));
      }
      return out;
    } finally {
      vec.delete();
    }
  } finally {
    zx._free(ptr);
  }
}
