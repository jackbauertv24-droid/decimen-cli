// `decimen play <file>` — display the stream in this terminal, forever, until
// Ctrl-C. Nothing is written to disk and nothing else needs to be installed.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { packFile } from "../vendor/shared/protocol.ts";
import { cycleLength } from "../vendor/shared/fountain.ts";
import type { EccLevel } from "../vendor/send/qr-frame.ts";
import { fitFrameBytes, frameStream, renderFrame } from "./terminal.ts";
import { mimeFor } from "./mime.ts";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";
const HOME = "\x1b[H";

export interface PlayOptions {
  input: string;
  fps: number;
  ecc: EccLevel;
  /** Explicit wire bytes per frame; otherwise the largest that fits. */
  frameBytes?: number;
  quiet: boolean;
}

export async function play(o: PlayOptions): Promise<void> {
  // stdout.columns is undefined when output is piped or redirected, so honour
  // COLUMNS/LINES the way other terminal programs do before falling back.
  const columns = process.stdout.columns ?? (Number(process.env.COLUMNS) || 80);
  const rows = process.stdout.rows ?? (Number(process.env.LINES) || 24);

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

  if (!o.quiet) {
    process.stderr.write(
      `playing ${name} — ${bytes.length} B, k=${stream.k}, ${frameBytes} B/frame at ${o.fps} fps\n` +
        `one full pass every ${(perCycle / o.fps).toFixed(1)} s; it loops until you press Ctrl-C\n\n` +
        "point decimen.app/receive at this screen\n",
    );
    await new Promise((r) => setTimeout(r, 1200));
  }

  let stop = false;
  const restore = () => {
    process.stdout.write(SHOW_CURSOR + "\x1b[0m\n");
  };
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
      const frame = stream.next();
      const status = o.quiet
        ? ""
        : `\x1b[0m frame ${frame.seq + 1}  pass ${Math.floor(shown / perCycle) + 1}  ${o.fps} fps  Ctrl-C to stop`;
      process.stdout.write(HOME + renderFrame(frame) + "\n" + status);
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
