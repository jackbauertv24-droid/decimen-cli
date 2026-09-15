// Render a file as the Decimen optical stream, written out as an animation.
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";

import { packFile } from "../vendor/shared/protocol.ts";
import { DEFAULT_FRAME_BYTES } from "../vendor/shared/send-settings.ts";
import { exportAnimation, planExport, type ExportFormat } from "../vendor/send/export.ts";
import { blockLength } from "../vendor/shared/frame-capacity.ts";
import type { EccLevel } from "../vendor/send/qr-frame.ts";
import { mimeFor } from "./mime.ts";
import { renderPlayer } from "./player.ts";

export type SendFormat = ExportFormat | "html";

export interface SendOptions {
  input: string;
  out?: string;
  format: SendFormat;
  fps: number;
  scale: number;
  cycles: number;
  ecc: EccLevel;
  grid: number;
  frameBytes: number;
  quiet: boolean;
  /** Bytes per part; the file is split when it is larger than this. */
  split?: number;
}

/** Zero-padded to the width of the total, so the parts sort correctly. */
function partLabel(i: number, n: number): string {
  const w = String(n).length;
  return `p${String(i).padStart(w, "0")}of${String(n).padStart(w, "0")}`;
}

/**
 * A part size whose stream plays for roughly `seconds`.
 *
 * Playback duration is what actually limits a transfer — nobody holds a camera
 * at a screen for eleven minutes — so the natural way to choose a part size is
 * to work backwards from how long one part should take.
 */
export function autoSplitBytes(seconds: number, frameBytes: number, fps: number, cycles: number, grid: number): number {
  const blockLen = blockLength(frameBytes);
  // animationFrames ≈ cycles × 2k / grid, and playback = animationFrames / fps.
  const k = Math.max(1, Math.floor((seconds * fps * grid) / (2 * cycles)));
  return Math.max(blockLen, k * blockLen);
}

export const SEND_DEFAULTS = {
  format: "html" as SendFormat,
  fps: 10,
  scale: 4,
  cycles: 2,
  ecc: "L" as EccLevel,
  grid: 1,
  frameBytes: DEFAULT_FRAME_BYTES,
};

/** "11 min 22 s", "45 s" — how long the animation actually runs. */
export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

export async function send(o: SendOptions): Promise<string> {
  const bytes = new Uint8Array(await readFile(o.input));
  const name = basename(o.input);
  const type = mimeFor(extname(o.input));

  if (o.split !== undefined && bytes.length > o.split) {
    return sendSplit(o, bytes, name, type);
  }

  const packed = await packFile(name, type, bytes);
  const plan = planExport(packed.container.length, o.frameBytes, o.grid, o.cycles);
  const log = o.quiet ? () => {} : (s: string) => console.error(s);

  log(`file      ${name} (${type})`);
  log(`size      ${bytes.length} B -> ${packed.transmittedSize} B on the wire (${packed.compression})`);
  log(`stream    k=${plan.k} blocks, ${plan.seqCount} fountain frames in ${plan.animationFrames} animation frames`);

  // The number people actually need: an animation is only useful if someone
  // is willing to hold a camera at it for this long.
  const playbackSeconds = plan.animationFrames / o.fps;
  log(`playback  ${formatDuration(playbackSeconds)} at ${o.fps} fps`);
  if (playbackSeconds > 300) {
    log("");
    log(`          That is a long time to hold a camera steady. To shorten it:`);
    log(`            --grid 4     four QR codes per frame, roughly a quarter the frames`);
    log(`            --fps 30     faster playback (needs a display and camera that keep up)`);
    log(`            --cycles 1   half the frames, but no repair margin — loop the file instead`);
    log("");
  }

  const startedAt = Date.now();
  const result = await exportAnimation({
    payload: packed.container,
    frameBytes: o.frameBytes,
    ecc: o.ecc,
    gridCodes: o.grid,
    format: o.format === "html" ? "apng" : o.format,
    fps: o.fps,
    scale: o.scale,
    cycles: o.cycles,
    sessionId: (Math.random() * 0x10000) | 0,
    onProgress: (done, total) => {
      if (o.quiet || (done !== total && done % 20 !== 0)) return;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = done > 0 ? (elapsed / done) * (total - done) : 0;
      const pct = Math.round((done / total) * 100);
      const tail = done === total ? "" : `  eta ${formatDuration(eta)}`;
      process.stderr.write(`\rrender    ${done}/${total}  ${pct}%${tail}          `);
    },
  });
  if (!result) throw new Error("export cancelled");
  if (!o.quiet) process.stderr.write("\r\u001b[2K");

  const apng = Buffer.concat(result.parts);
  const isHtml = o.format === "html";
  const body = isHtml
    ? Buffer.from(
        renderPlayer({
          apng,
          fileName: name,
          frameCount: result.frameCount,
          fps: o.fps,
          width: result.width,
          height: result.height,
          playbackSeconds,
        }),
        "utf8",
      )
    : apng;
  const outPath = o.out ?? `${o.input}.decimen.${isHtml ? "html" : result.extension}`;
  await writeFile(outPath, body);
  const total = body.length;
  log(`wrote     ${outPath}`);
  const mib = total / 1024 / 1024;
  const size = mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(total / 1024).toFixed(1)} KiB`;
  log(`          ${result.frameCount} frames, ${result.width}x${result.height}, ${size}, ${formatDuration(playbackSeconds)} of playback`);
  log("");
  if (isHtml) {
    log("Open it — double-clicking plays the animation in your browser. Press F for");
    log("fullscreen, then point decimen.app/receive at the screen. The stream loops,");
    log("so a missed frame comes back around.");
    return outPath;
  }
  if (o.format === "apng") {
    // People reasonably read ".png" as "one picture". It is an animated PNG:
    // every frame is in that one file, and a viewer that ignores the animation
    // shows frame 1 forever, which transfers nothing.
    log(`It is an animated PNG — all ${result.frameCount} frames are inside that one file,`);
    log("looping forever. Open it in a web browser: many desktop image viewers show");
    log("only the first frame, which will not transfer.");
  } else {
    log(`That is a ZIP of ${result.frameCount} numbered PNGs, one per frame, plus a note`);
    log(`recording the ${o.fps} fps they are meant to be played at.`);
  }
  log("");
  log("Play it fullscreen and point decimen.app/receive at the screen.");
  return outPath;
}

/**
 * Write one stream per part.
 *
 * Each part is a complete, independently decodable stream carrying its own
 * container — so its filename, media type and SHA-256 are verified on arrival
 * exactly as an unsplit transfer would be. What ties the set together is the
 * part name: `<file>.<runId>.pNNofMM`, where runId is the first 8 hex of the
 * whole file's SHA-256. That makes it impossible to reassemble parts from two
 * different sends of the same filename without noticing.
 */
async function sendSplit(o: SendOptions, bytes: Uint8Array, name: string, type: string): Promise<string> {
  const log = o.quiet ? () => {} : (s: string) => console.error(s);
  const runId = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const total = Math.ceil(bytes.length / o.split!);
  const ext = o.format === "html" ? "html" : o.format === "zip" ? "zip" : "png";
  const base = (o.out ?? `${o.input}.decimen`).replace(/\.(png|zip|html)$/i, "");

  log(`file      ${name} (${type})`);
  log(`size      ${bytes.length} B -> ${total} parts of up to ${o.split} B  [run ${runId}]`);
  log("");

  const written: string[] = [];
  let playback = 0;
  for (let i = 1; i <= total; i++) {
    const chunk = bytes.subarray((i - 1) * o.split!, Math.min(i * o.split!, bytes.length));
    const label = partLabel(i, total);
    const packed = await packFile(`${name}.${runId}.${label}`, type, chunk);
    const plan = planExport(packed.container.length, o.frameBytes, o.grid, o.cycles);
    const seconds = plan.animationFrames / o.fps;
    playback += seconds;

    const result = await exportAnimation({
      payload: packed.container,
      frameBytes: o.frameBytes,
      ecc: o.ecc,
      gridCodes: o.grid,
      format: o.format === "html" ? "apng" : o.format,
      fps: o.fps,
      scale: o.scale,
      cycles: o.cycles,
      sessionId: (Math.random() * 0x10000) | 0,
      onProgress: (done, totalFrames) => {
        if (o.quiet || (done !== totalFrames && done % 20 !== 0)) return;
        process.stderr.write(`\rpart ${i}/${total}  render ${done}/${totalFrames}          `);
      },
    });
    if (!result) throw new Error("export cancelled");
    if (!o.quiet) process.stderr.write("\r\u001b[2K");

    const apng = Buffer.concat(result.parts);
    const body = o.format === "html"
      ? Buffer.from(renderPlayer({
          apng, fileName: `${name} (${label})`, frameCount: result.frameCount,
          fps: o.fps, width: result.width, height: result.height, playbackSeconds: seconds,
        }), "utf8")
      : apng;

    const path = `${base}.${label}.${ext}`;
    await writeFile(path, body);
    written.push(path);
    log(`part ${i}/${total}  ${chunk.length} B -> ${result.frameCount} frames, ` +
        `${(body.length / 1024).toFixed(0)} KiB, ${formatDuration(seconds)}`);
  }

  log("");
  log(`wrote     ${total} parts, ${formatDuration(playback)} of playback in total`);
  log("");
  log("Show them one at a time. decimen receive reassembles the original once every");
  log("part has arrived — the parts carry their own order and checksums.");
  return written[0];
}
