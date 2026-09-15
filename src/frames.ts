// Where frames come from. Everything here yields RGBA, because that is what
// the codec's ImageView expects.
import { readFile, readdir, stat } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import { PNG } from "pngjs";

import type { RgbaFrame } from "./codec.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function toRgba(png: PNG): RgbaFrame {
  return {
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
    width: png.width,
    height: png.height,
  };
}

/** An APNG is a PNG whose animation frames live in fcTL/fdAT chunks. Decimen
 *  writes every frame as a full-frame replacement (dispose NONE, blend SOURCE),
 *  so each one rebuilds into a standalone PNG with no compositing. */
export function* demuxApng(file: Buffer): Generator<RgbaFrame> {
  if (!file.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG file");
  const header: Buffer[] = []; // IHDR, PLTE, tRNS — shared by every frame
  const frames: Buffer[][] = [];
  let sawFctl = false;

  let off = 8;
  while (off + 8 <= file.length) {
    const len = file.readUInt32BE(off);
    const type = file.toString("ascii", off + 4, off + 8);
    const data = file.subarray(off + 8, off + 8 + len);
    const whole = file.subarray(off, off + 12 + len);
    if (type === "IHDR" || type === "PLTE" || type === "tRNS") header.push(whole);
    else if (type === "fcTL") {
      sawFctl = true;
      frames.push([]);
    } else if (type === "IDAT") {
      // Before any fcTL this is a still image; after one it is frame 1.
      if (!sawFctl) frames.push([]);
      frames[frames.length - 1].push(whole);
    } else if (type === "fdAT") {
      // fdAT is an IDAT with a 4-byte sequence number in front of it.
      frames[frames.length - 1].push(rebuildChunk("IDAT", data.subarray(4)));
    } else if (type === "IEND") break;
    off += 12 + len;
  }
  if (frames.length === 0) throw new Error("no image data in PNG");

  const iend = rebuildChunk("IEND", Buffer.alloc(0));
  for (const idats of frames) {
    if (idats.length === 0) continue;
    yield toRgba(PNG.sync.read(Buffer.concat([PNG_SIG, ...header, ...idats, iend])));
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function rebuildChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** PNG frames arriving on a stream, split on the 8-byte signature. */
async function* splitPngStream(stream: NodeJS.ReadableStream): AsyncGenerator<RgbaFrame> {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    // A complete frame is everything up to the next signature.
    for (;;) {
      const next = buf.indexOf(PNG_SIG, PNG_SIG.length);
      if (next < 0) break;
      const frame = buf.subarray(0, next);
      buf = buf.subarray(next);
      try {
        yield toRgba(PNG.sync.read(frame));
      } catch {
        // A torn frame is exactly what the fountain is for.
      }
    }
  }
  if (buf.length > PNG_SIG.length) {
    try {
      yield toRgba(PNG.sync.read(buf));
    } catch {
      /* ignore trailing partial frame */
    }
  }
}

export interface FfmpegSource {
  /** ffmpeg args before the output spec. */
  input: string[];
  label: string;
}

/** Default capture device per platform, for `receive --camera`. */
export function cameraSource(device?: string): FfmpegSource {
  switch (process.platform) {
    case "darwin":
      return { input: ["-f", "avfoundation", "-framerate", "30", "-i", device ?? "0"], label: `avfoundation:${device ?? "0"}` };
    case "win32":
      return { input: ["-f", "dshow", "-i", `video=${device ?? "Integrated Camera"}`], label: `dshow:${device ?? "Integrated Camera"}` };
    default:
      return { input: ["-f", "v4l2", "-framerate", "30", "-i", device ?? "/dev/video0"], label: `v4l2:${device ?? "/dev/video0"}` };
  }
}

export function ffmpegFrames(source: FfmpegSource, fps?: number): {
  frames: AsyncGenerator<RgbaFrame>;
  child: ChildProcessByStdio<null, Readable, Readable>;
} {
  const args = [
    "-hide_banner", "-loglevel", "error",
    ...source.input,
    ...(fps ? ["-vf", `fps=${fps}`] : []),
    "-f", "image2pipe", "-vcodec", "png", "-",
  ];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") {
      console.error("ffmpeg not found on PATH — needed for video and camera input.");
      process.exit(127);
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  child.on("close", (code) => {
    if (code && code !== 0 && stderr.trim()) console.error(`\nffmpeg: ${stderr.trim()}`);
  });
  return { frames: splitPngStream(child.stdout), child };
}

const IMAGE_EXT = new Set([".png", ".apng"]);

/** Resolve a path into frames: a directory of PNGs, an APNG, or a video. */
export async function framesFromPath(path: string, fps?: number): Promise<AsyncGenerator<RgbaFrame>> {
  const info = await stat(path);
  if (info.isDirectory()) {
    const names = (await readdir(path)).filter((n) => IMAGE_EXT.has(extname(n).toLowerCase())).sort();
    if (names.length === 0) throw new Error(`no .png frames in ${path}`);
    return (async function* () {
      for (const n of names) {
        try {
          yield toRgba(PNG.sync.read(await readFile(join(path, n))));
        } catch {
          /* skip unreadable frame */
        }
      }
    })();
  }
  if (IMAGE_EXT.has(extname(path).toLowerCase())) {
    const file = await readFile(path);
    return (async function* () {
      for (const f of demuxApng(file)) yield f;
    })();
  }
  return ffmpegFrames({ input: ["-i", path], label: path }, fps).frames;
}
