// `decimen play` — show the stream in this terminal, forever, until Ctrl-C.
// Nothing is written to disk and nothing else needs to be installed.
//
// Two modes, chosen by what you point it at:
//   a source file      → encode it now and render the frames live
//   an existing stream → replay the frames already in that APNG / frame directory
//
// The second mode exists because a stream is often produced on one machine and
// shown on another. Re-encoding would need the original file; replaying needs
// only the picture.
import { open, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { packFile } from "../vendor/shared/protocol.ts";
import { cycleLength } from "../vendor/shared/fountain.ts";
import type { EccLevel } from "../vendor/send/qr-frame.ts";
import {
  fitFrameBytes, frameStream, rasterToModules, renderFrame, renderModules,
  scaleFromGeometry, type ModuleGrid,
} from "./terminal.ts";
import { framesFromPath } from "./frames.ts";
import { loadCodec, readSymbols } from "./codec.ts";
import { mimeFor } from "./mime.ts";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const HOME = "\x1b[H";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PlayOptions {
  input: string;
  fps: number;
  ecc: EccLevel;
  /** Explicit wire bytes per frame; otherwise the largest that fits. Encode mode only. */
  frameBytes?: number;
  quiet: boolean;
}

/** A directory of frames, or a file that starts with the PNG signature. */
async function isExistingStream(path: string): Promise<boolean> {
  const info = await stat(path);
  if (info.isDirectory()) return true;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(8);
    await handle.read(head, 0, 8, 0);
    return head.equals(PNG_SIG);
  } finally {
    await handle.close();
  }
}

export async function play(o: PlayOptions): Promise<void> {
  // stdout.columns is undefined when output is piped or redirected, so honour
  // COLUMNS/LINES the way other terminal programs do before falling back.
  const columns = process.stdout.columns ?? (Number(process.env.COLUMNS) || 80);
  const rows = process.stdout.rows ?? (Number(process.env.LINES) || 24);
  const log = o.quiet ? () => {} : (s: string) => process.stderr.write(s);

  const frames = (await isExistingStream(o.input))
    ? await loadStream(o.input, columns, rows, log)
    : await encodeStream(o, columns, rows, log);

  await renderLoop(frames, o, log);
}

// ---------------------------------------------------------------- encode mode

interface FrameSource {
  /** The next frame to draw. Called once per tick; may cycle forever. */
  next(): string;
  /** Frames in one full pass, for the status line. */
  perCycle: number;
}

async function encodeStream(o: PlayOptions, columns: number, rows: number, log: (s: string) => void): Promise<FrameSource> {
  // One row is kept for the status line; the code gets the rest.
  const frameBytes = o.frameBytes ?? fitFrameBytes(columns, rows - 1, o.ecc);
  if (frameBytes === null) {
    throw new Error(
      `this terminal is ${columns}x${rows}; the smallest QR needs about 93x48. ` +
        "Maximise the window or reduce the font size, then run it again.",
    );
  }

  const bytes = new Uint8Array(await readFile(o.input));
  const name = basename(o.input);
  const packed = await packFile(name, mimeFor(extname(o.input)), bytes);
  const stream = frameStream(packed.container, frameBytes, o.ecc, (Math.random() * 0x10000) | 0);
  const perCycle = cycleLength(stream.k);

  log(
    `playing ${name} — ${bytes.length} B, k=${stream.k}, ${frameBytes} B/frame at ${o.fps} fps\n` +
      `one full pass every ${(perCycle / o.fps).toFixed(1)} s; it loops until you press Ctrl-C\n\n` +
      "point decimen.app/receive at this screen\n",
  );

  return { perCycle, next: () => renderFrame(stream.next()) };
}

// ---------------------------------------------------------------- replay mode

async function loadStream(path: string, columns: number, rows: number, log: (s: string) => void): Promise<FrameSource> {
  log(`reading ${basename(path)}...\n`);

  const rasters = [];
  for await (const frame of await framesFromPath(path)) rasters.push(frame);
  if (rasters.length === 0) throw new Error(`no frames found in ${path}`);

  // The upscale factor has to be exact, so take it from a decoded symbol's
  // geometry rather than guessing from the image.
  const zx = await loadCodec();
  const first = rasters[0];
  const symbols = readSymbols(zx, first, 4);
  if (symbols.length === 0) {
    throw new Error("could not read a QR code from the first frame — is this a decimen stream?");
  }
  const modules = symbols[0].modules;
  const scale = scaleFromGeometry(first.height, modules, 4);
  if (scale === null) {
    throw new Error(
      `frame is ${first.width}x${first.height} but the symbol is ${modules} modules; ` +
        "the upscale factor is not a whole number, so this raster cannot be replayed exactly.",
    );
  }

  const grids: ModuleGrid[] = rasters.map((r) => rasterToModules(r.data, r.width, r.height, scale));
  const { width, height } = grids[0];
  const needRows = Math.ceil(height / 2) + 1;
  if (width > columns || needRows > rows) {
    throw new Error(
      `this stream needs ${width}x${needRows} of terminal and you have ${columns}x${rows}. ` +
        "Maximise the window or reduce the font size.",
    );
  }

  log(
    `${rasters.length} frames, ${modules} modules at scale ${scale} ` +
      `(${first.width}x${first.height} px) -> ${width}x${needRows} cells\n` +
      "it loops until you press Ctrl-C; point decimen.app/receive at this screen\n",
  );

  const drawn = grids.map((g) => renderModules(g));
  let i = 0;
  return { perCycle: drawn.length, next: () => drawn[i++ % drawn.length] };
}

// ---------------------------------------------------------------- shared loop

async function renderLoop(frames: FrameSource, o: PlayOptions, log: (s: string) => void): Promise<void> {
  if (!o.quiet) await new Promise((r) => setTimeout(r, 1200));

  let stop = false;
  const restore = () => process.stdout.write(SHOW_CURSOR + "\x1b[0m\n");
  const onSignal = () => {
    stop = true;
    restore();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  process.stdout.write(HIDE_CURSOR + CLEAR);
  const interval = 1000 / o.fps;
  let shown = 0;
  let next = Date.now();

  try {
    while (!stop) {
      const status = o.quiet
        ? ""
        : `\x1b[0m frame ${(shown % frames.perCycle) + 1}/${frames.perCycle}  ` +
          `pass ${Math.floor(shown / frames.perCycle) + 1}  ${o.fps} fps  Ctrl-C to stop`;
      process.stdout.write(HOME + frames.next() + "\n" + status);
      shown++;

      // Absolute schedule, so a slow frame does not make every later one late.
      next += interval;
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else next = Date.now();
    }
  } finally {
    restore();
  }
}
