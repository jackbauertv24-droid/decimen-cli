import { parseArgs } from "node:util";

// Piping into head/less closes the pipe early. Without this, Node turns an
// ordinary `decimen doctor | head` into an unhandled EPIPE stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
}
import { cameraSource, ffmpegFrames, framesFromPath } from "./frames.ts";
import { receive } from "./receive.ts";
import { SEND_DEFAULTS, send } from "./send.ts";
import { doctor } from "./doctor.ts";
import type { ExportFormat } from "../vendor/send/export.ts";
import type { EccLevel } from "../vendor/send/qr-frame.ts";

const USAGE = `decimen — optical file transfer over animated QR, from the terminal

  decimen send <file> [options]          render a file as a QR animation
  decimen receive <source> [options]     read a stream back into a file
  decimen doctor                         check this install works, no file needed

send options
  -o, --out <path>       output file (default: <file>.decimen.png)
      --format <fmt>     apng | zip                  (default: ${SEND_DEFAULTS.format})
      --fps <n>          animation frame rate        (default: ${SEND_DEFAULTS.fps})
      --scale <n>        integer module upscale      (default: ${SEND_DEFAULTS.scale})
      --cycles <n>       carousel cycles, >=1        (default: ${SEND_DEFAULTS.cycles})
      --ecc <L|M|Q|H>    QR error correction         (default: ${SEND_DEFAULTS.ecc})
      --grid <n>         QR codes per frame          (default: ${SEND_DEFAULTS.grid})
      --frame-bytes <n>  wire bytes per QR           (default: ${SEND_DEFAULTS.frameBytes})

receive sources
  <dir>                  a directory of .png frames
  <file.png>             an APNG produced by "decimen send"
  <file.mp4>             any video ffmpeg can read
  --camera               live capture (needs ffmpeg)
      --device <name>    capture device (default: the platform's first camera)

receive options
  -o, --out <path>       write here instead of <dir>/<original name>
  -d, --dir <path>       directory to write into     (default: .)
      --fps <n>          sample video/camera at n fps
      --symbols <n>      max QR codes per frame      (default: 4)

Receiving also works with no install at all: play the animation fullscreen and
point https://decimen.app/receive at it from a phone.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    dir: { type: "string", short: "d" },
    format: { type: "string" },
    fps: { type: "string" },
    scale: { type: "string" },
    cycles: { type: "string" },
    ecc: { type: "string" },
    grid: { type: "string" },
    "frame-bytes": { type: "string" },
    symbols: { type: "string" },
    camera: { type: "boolean" },
    device: { type: "string" },
    quiet: { type: "boolean", short: "q" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  strict: true,
});

declare const __PKG_VERSION__: string;
declare const __BUILD_REV__: string;
declare const __BUILD_DATE__: string;

if (values.version) {
  console.log(`decimen-cli ${__PKG_VERSION__}  build ${__BUILD_REV__} (${__BUILD_DATE__})  wire v3`);
  process.exit(0);
}

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

function num(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`--${label} must be a positive number`);
  return n;
}

function fail(message: string): never {
  console.error(`decimen: ${message}`);
  process.exit(1);
}

const quiet = values.quiet ?? false;

try {
  if (command === "doctor") {
    process.exit(await doctor());
  } else if (command === "send") {
    const input = rest[0];
    if (!input) fail("send needs a file — try: decimen send ./report.pdf");

    const format = (values.format ?? SEND_DEFAULTS.format) as ExportFormat;
    if (format !== "apng" && format !== "zip") fail("--format must be apng or zip");
    const ecc = (values.ecc ?? SEND_DEFAULTS.ecc).toUpperCase() as EccLevel;
    if (!["L", "M", "Q", "H"].includes(ecc)) fail("--ecc must be L, M, Q or H");

    await send({
      input,
      out: values.out,
      format,
      ecc,
      fps: num(values.fps, SEND_DEFAULTS.fps, "fps"),
      scale: num(values.scale, SEND_DEFAULTS.scale, "scale"),
      cycles: num(values.cycles, SEND_DEFAULTS.cycles, "cycles"),
      grid: num(values.grid, SEND_DEFAULTS.grid, "grid"),
      frameBytes: num(values["frame-bytes"], SEND_DEFAULTS.frameBytes, "frame-bytes"),
      quiet,
    });
  } else if (command === "receive") {
    const fps = values.fps ? num(values.fps, 0, "fps") : undefined;
    const useCamera = values.camera ?? false;
    const source = rest[0];
    if (!useCamera && !source) fail("receive needs a source — a directory, an APNG, a video, or --camera");

    let frames;
    let stop: (() => void) | undefined;
    if (useCamera) {
      const device = values.device || undefined;
      const started = ffmpegFrames(cameraSource(device), fps);
      frames = started.frames;
      stop = () => started.child.kill("SIGTERM");
      if (!quiet) console.error(`camera    ${cameraSource(device).label}`);
    } else {
      frames = await framesFromPath(source!, fps);
    }

    const result = await receive({
      frames,
      outDir: values.dir ?? ".",
      out: values.out,
      maxSymbols: num(values.symbols, 4, "symbols"),
      quiet,
      onDone: stop,
    });
    if (!result) fail("no Decimen frames found in that source");
    if (!quiet) {
      console.error(`received  ${result.name} (${result.type}), ${result.size} B`);
      console.error(`          SHA-256 verified, ${result.framesUsed} usable frames of ${result.framesSeen} read`);
    }
    console.log(result.path);
    stop?.();
  } else {
    fail(`unknown command "${command}" — expected send, receive or doctor`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
