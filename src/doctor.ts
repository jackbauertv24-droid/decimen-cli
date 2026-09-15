// `decimen doctor` — prove the tool works without touching a file.
//
// Exists because npm's fetch spinner runs before this process starts, so a
// slow start is indistinguishable from a broken install unless there is a
// command that does nothing but report. Every check prints as it completes,
// so a stall is attributable to a specific step.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { packFile, parseFrame, unpackFile, verifyFile } from "../vendor/shared/protocol.ts";
import { WIRE_VERSION } from "../vendor/shared/protocol.ts";
import { LTDecoder } from "../vendor/shared/fountain.ts";
import { exportAnimation } from "../vendor/send/export.ts";
import { DEFAULT_FRAME_BYTES } from "../vendor/shared/send-settings.ts";
import { demuxApng } from "./frames.ts";
import { loadCodec, readFrame } from "./codec.ts";

declare const __PKG_VERSION__: string;
declare const __BUILD_REV__: string;
declare const __BUILD_DATE__: string;

const line = (label: string, value: string) => console.log(`  ${label.padEnd(14)}${value}`);

function since(start: bigint): string {
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return elapsed < 1 ? "<1 ms" : `${Math.round(elapsed)} ms`;
}

export async function doctor(): Promise<number> {
  console.log("");
  console.log("decimen doctor");
  console.log("");
  line("cli", `${__PKG_VERSION__}  build ${__BUILD_REV__} (${__BUILD_DATE__})`);
  line("node", `${process.version}  ${process.platform} ${process.arch}`);
  line("wire format", `v${WIRE_VERSION}`);
  // If npm's spinner ran for thirty seconds and this says 40 ms, the delay was
  // never in this program.
  line("startup", `${Math.round(process.uptime() * 1000)} ms from process start to here`);

  let failures = 0;

  // The WASM codec is the only part that can be missing from a bad install.
  let codecLabel = "";
  try {
    const t = process.hrtime.bigint();
    const zx = await loadCodec();
    codecLabel = `decimen-codec ${zx.version()} build ${zx.build()}`;
    line("codec", `${codecLabel}   loaded in ${since(t)}`);
  } catch (e) {
    failures++;
    line("codec", `FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }

  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: 4000 });
  if (ffmpeg.status === 0) {
    line("ffmpeg", (ffmpeg.stdout.split("\n")[0] ?? "present").replace("ffmpeg version ", ""));
  } else {
    line("ffmpeg", "not found — only needed for video and camera input");
  }

  console.log("");
  console.log("  self-test     encode -> QR -> decode -> verify, entirely in memory");

  try {
    const original = Buffer.from("decimen self-test ".repeat(40), "utf8");
    const packed = await packFile("selftest.txt", "text/plain", new Uint8Array(original));

    const tEnc = process.hrtime.bigint();
    const animation = await exportAnimation({
      payload: packed.container,
      frameBytes: DEFAULT_FRAME_BYTES,
      ecc: "L",
      gridCodes: 1,
      format: "apng",
      fps: 10,
      scale: 2,
      cycles: 1,
      sessionId: 0x5e1f,
    });
    if (!animation) throw new Error("encoder returned nothing");
    const encodeMs = since(tEnc);
    line("  payload", `${original.length} B -> ${animation.frameCount} frames, ${animation.width}x${animation.height}`);
    line("  encode", encodeMs);

    const tDec = process.hrtime.bigint();
    const zx = await loadCodec();
    let decoder: LTDecoder | null = null;
    let symbols = 0;
    for (const frame of demuxApng(Buffer.concat(animation.parts))) {
      for (const payload of readFrame(zx, frame, 1)) {
        const parsed = parseFrame(payload);
        if (!parsed) continue;
        symbols++;
        decoder ??= new LTDecoder(parsed.header.k, parsed.header.blockLen, parsed.header.sessionId, parsed.header.totalLen);
        decoder.addFrame(parsed.header.seq, parsed.block);
      }
      if (decoder?.isComplete) break;
    }
    if (!decoder?.isComplete) throw new Error(`decoded ${symbols} symbols but could not reassemble`);
    line("  decode", `${since(tDec)}  (${symbols} symbol${symbols === 1 ? "" : "s"} read)`);

    const file = await unpackFile(decoder.assemble()!);
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const matches = sha(file.bytes) === sha(new Uint8Array(original)) && (await verifyFile(file));
    line("  sha-256", matches ? "match" : "MISMATCH");
    if (!matches) failures++;
  } catch (e) {
    failures++;
    line("  self-test", `FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("");
  if (failures === 0) {
    console.log("  OK — sending and receiving both work on this machine.");
    console.log("");
    console.log("  If a real run still feels slow to start, the delay is npm fetching the");
    console.log("  package, not this tool. Install it once instead:");
    const v = __PKG_VERSION__;
    console.log(`    npm install -g https://github.com/jackbauertv24-droid/decimen-cli/releases/download/v${v}/decimen-cli-${v}.tgz`);
  } else {
    console.log(`  ${failures} check${failures === 1 ? "" : "s"} failed — this install is not working.`);
  }
  console.log("");
  return failures === 0 ? 0 : 1;
}
