// What a camera actually sees when it is pointed at the terminal.
//
// `decimen play` writes ANSI half-blocks. These tests turn that output back
// into pixels and run it through the real WASM decoder, which catches the
// failures that matter here: inverted polarity, a missing quiet zone, or rows
// that do not line up with modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

/** Cursor-home escape that separates rendered frames, and the half-block glyph. */
const HOME = "[H";
const HALF_BLOCK = "▀";

/** One rendered frame of ANSI half-blocks -> an RGBA bitmap, 5x upscaled. */
function ansiToBitmap(text, scale = 5) {
  const rows = [];
  for (const raw of text.split("\n")) {
    const top = [];
    const bottom = [];
    let i = 0, fgLight = false, bgLight = false;
    while (i < raw.length) {
      if (raw[i] === "\x1b") {
        const end = raw.indexOf("m", i);
        if (end < 0) break;
        for (const p of raw.slice(i + 2, end).split(";")) {
          if (p === "97") fgLight = true;
          else if (p === "30") fgLight = false;
          else if (p === "107") bgLight = true;
          else if (p === "40") bgLight = false;
        }
        i = end + 1;
        continue;
      }
      if (raw[i] === "▀") { top.push(fgLight ? 0 : 1); bottom.push(bgLight ? 0 : 1); }
      i++;
    }
    if (top.length) { rows.push(top, bottom); }
  }
  if (rows.length === 0) return null;
  const w = rows[0].length, h = rows.length;
  if (!rows.every((r) => r.length === w)) return null;
  const px = Buffer.alloc(w * scale * h * scale * 4);
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const v = rows[(y / scale) | 0][(x / scale) | 0] ? 0 : 255;
      const o = (y * w * scale + x) * 4;
      px[o] = px[o + 1] = px[o + 2] = v;
      px[o + 3] = 255;
    }
  }
  return { px, w: w * scale, h: h * scale };
}

test("a camera pointed at the terminal can read the stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decimen-term-"));
  const src = join(dir, "secret.txt");
  const original = randomBytes(900);
  await writeFile(src, original);

  // A generous terminal, declared through COLUMNS/LINES because stdout is a pipe.
  const run = spawnSync(process.execPath, [CLI, "play", src, "--fps", "60", "-q"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "200", LINES: "60" },
    timeout: 6000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = run.stdout ?? "";
  assert.ok(out.length > 0, "play produced no output");

  // Frames are separated by a cursor-home escape.
  const frames = out.split("\x1b[H").slice(1).filter((f) => f.includes("▀"));
  assert.ok(frames.length >= 4, `expected several frames, got ${frames.length}`);

  const bmp = ansiToBitmap(frames[1]);
  assert.ok(bmp, "could not rebuild a bitmap from the terminal output");

  // The bitmap is checked through the shipped receive path: write it as a PNG
  // frame directory and let receive do the reading.
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: bmp.w, height: bmp.h });
  bmp.px.copy(png.data);
  const framesDir = join(dir, "frames");
  const { mkdir, writeFile: wf } = await import("node:fs/promises");
  await mkdir(framesDir, { recursive: true });
  await wf(join(framesDir, "frame-0001.png"), PNG.sync.write(png));

  // One frame of a 900-byte payload is the whole payload at this frame size,
  // so receive should reassemble the file from it alone.
  execFileSync(process.execPath, [CLI, "receive", framesDir, "-o", join(dir, "out.bin"), "-q"], { encoding: "utf8" });
  const { readFile } = await import("node:fs/promises");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(sha(await readFile(join(dir, "out.bin"))), sha(original));
});

test("play refuses a terminal too small to hold a code", () => {
  const run = spawnSync(process.execPath, [CLI, "play", CLI, "-q"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "40", LINES: "12" },
    timeout: 5000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Maximise the window|smallest QR needs/);
});

test("replays an existing PNG stream in the terminal, and it still decodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decimen-replay-"));
  const src = join(dir, "secret.bin");
  const original = randomBytes(900);
  await writeFile(src, original);

  // Produce a stream the way another machine would have, then replay the
  // picture alone — with no access to the original file.
  const png = join(dir, "stream.png");
  execFileSync(
    process.execPath,
    [CLI, "send", src, "--format", "apng", "--frame-bytes", "500", "--scale", "3", "-o", png, "-q"],
    { encoding: "utf8" },
  );

  const run = spawnSync(process.execPath, [CLI, "play", png, "-q"], {
    encoding: "utf8",
    env: { ...process.env, COLUMNS: "120", LINES: "60" },
    timeout: 6000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const frames = (run.stdout ?? "").split(HOME).slice(1).filter((f) => f.includes(HALF_BLOCK));
  assert.ok(frames.length >= 4, `expected several replayed frames, got ${frames.length}`);

  // Point a notional camera at the replay and hand what it sees to receive.
  const { PNG } = await import("pngjs");
  const shot = join(dir, "shot");
  await mkdir(shot, { recursive: true });
  let n = 0;
  for (const f of frames.slice(0, 20)) {
    const bmp = ansiToBitmap(f);
    if (!bmp) continue;
    const img = new PNG({ width: bmp.w, height: bmp.h });
    bmp.px.copy(img.data);
    await writeFile(join(shot, `frame-${String(++n).padStart(4, "0")}.png`), PNG.sync.write(img));
  }
  assert.ok(n > 0, "no frames survived the ANSI round trip");

  execFileSync(process.execPath, [CLI, "receive", shot, "-o", join(dir, "back.bin"), "-q"], { encoding: "utf8" });
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  assert.equal(sha(await readFile(join(dir, "back.bin"))), sha(original));
});
