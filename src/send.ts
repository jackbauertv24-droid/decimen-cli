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
      if (!o.quiet && (done === total || done % 20 === 0)) {
        process.stderr.write(`\rrender    ${done}/${total}`);
      }
    },
  });
  if (!result) throw new Error("export cancelled");
  if (!o.quiet) process.stderr.write("\r");

  const outPath = o.out ?? `${o.input}.decimen.${result.extension}`;
  await writeFile(outPath, Buffer.concat(result.parts));
  const total = result.parts.reduce((n, p) => n + p.length, 0);
  log(`wrote     ${outPath}`);
  log(`          ${result.frameCount} frames @ ${o.fps} fps, ${result.width}x${result.height}, ${(total / 1024).toFixed(1)} KiB`);
  log("");
  log("Play it fullscreen and point decimen.app/receive at the screen.");
  return outPath;
}
