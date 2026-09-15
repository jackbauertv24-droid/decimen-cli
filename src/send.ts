// Render a file as the Decimen optical stream, written out as an animation.
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { packFile } from "../vendor/shared/protocol.ts";
import { DEFAULT_FRAME_BYTES } from "../vendor/shared/send-settings.ts";
import { exportAnimation, planExport, type ExportFormat } from "../vendor/send/export.ts";
import type { EccLevel } from "../vendor/send/qr-frame.ts";
import { mimeFor } from "./mime.ts";

export interface SendOptions {
  input: string;
  out?: string;
  format: ExportFormat;
  fps: number;
  scale: number;
  cycles: number;
  ecc: EccLevel;
  grid: number;
  frameBytes: number;
  quiet: boolean;
}

export const SEND_DEFAULTS = {
  format: "apng" as ExportFormat,
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
    format: o.format,
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
  if (!o.quiet) process.stderr.write("\r");

  const outPath = o.out ?? `${o.input}.decimen.${result.extension}`;
  await writeFile(outPath, Buffer.concat(result.parts));
  const total = result.parts.reduce((n, p) => n + p.length, 0);
  log(`wrote     ${outPath}`);
  const mib = total / 1024 / 1024;
  const size = mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(total / 1024).toFixed(1)} KiB`;
  log(`          ${result.frameCount} frames, ${result.width}x${result.height}, ${size}, ${formatDuration(playbackSeconds)} of playback`);
  log("");
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
