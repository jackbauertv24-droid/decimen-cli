// End-to-end tests against the built bundle: send produces frames, receive
// reads them back byte-identically, and the fountain survives frame loss.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, copyFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (b) => createHash("sha256").update(b).digest("hex");

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "decimen-test-"));
});

test("round-trips an APNG stream byte-identically", async () => {
  const src = join(dir, "payload.bin");
  const original = randomBytes(120_000); // incompressible: forces many blocks
  await writeFile(src, original);

  run("send", src, "--format", "apng", "-o", join(dir, "stream.png"), "--cycles", "2", "--scale", "2", "-q");
  run("receive", join(dir, "stream.png"), "-o", join(dir, "out.bin"), "-q");

  assert.equal(sha(await readFile(join(dir, "out.bin"))), sha(original));
});

test("round-trips a small text file and preserves its name and type", async () => {
  const src = join(dir, "notes.txt");
  await writeFile(src, "decimen round trip\n".repeat(200));
  run("send", src, "--format", "apng", "-o", join(dir, "notes.png"), "-q");
  const out = run("receive", join(dir, "notes.png"), "-d", dir, "-q").trim();
  assert.ok(out.endsWith("notes.txt"), `expected the original filename, got ${out}`);
  assert.equal(sha(await readFile(out)), sha(await readFile(src)));
});

test("recovers from 35% frame loss when sent with enough cycles", async () => {
  const src = join(dir, "lossy.bin");
  const original = randomBytes(60_000);
  await writeFile(src, original);

  const frames = join(dir, "frames");
  run("send", src, "--format", "zip", "-o", join(dir, "frames.zip"), "--cycles", "3", "--scale", "2", "-q");
  execFileSync("unzip", ["-q", "-o", join(dir, "frames.zip"), "-d", frames]);

  // Drop frames the way a camera does: at random, keeping the rest in order.
  let dropped = 0;
  for (const name of await readdir(frames)) {
    if (name.endsWith(".png") && Math.random() < 0.35) {
      await rm(join(frames, name));
      dropped++;
    }
  }
  assert.ok(dropped > 0, "expected the simulation to drop some frames");

  run("receive", frames, "-o", join(dir, "lossy-out.bin"), "-q");
  assert.equal(sha(await readFile(join(dir, "lossy-out.bin"))), sha(original));
});

test("refuses a source with no Decimen frames", async () => {
  const empty = join(dir, "empty");
  await writeFile(join(dir, "not-a-stream.txt"), "nothing optical here");
  assert.throws(() => run("receive", join(dir, "not-a-stream.txt"), "-q"));
  void empty;
});

test("parses the documented flags without crashing the argument parser", () => {
  // --camera takes no value; the device goes in --device. Regression test:
  // declaring it as a string option made `receive --camera` throw a raw
  // ERR_PARSE_ARGS_INVALID_OPTION_VALUE stack trace at the user.
  const help = run("--help");
  assert.match(help, /--camera\b/);
  assert.match(help, /--device <name>/);

  // Without ffmpeg this exits non-zero with a readable message rather than a
  // parser stack trace; with ffmpeg it would block on the camera, so only the
  // parse path is asserted here.
  try {
    execFileSync(process.execPath, [CLI, "receive", "--camera"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000 });
  } catch (e) {
    assert.doesNotMatch(String(e.stderr ?? ""), /ERR_PARSE_ARGS/);
  }
});

test("rejects an unknown command with a readable message", () => {
  try {
    run("teleport", "./x");
    assert.fail("expected a non-zero exit");
  } catch (e) {
    assert.match(String(e.stderr), /unknown command "teleport"/);
  }
});

test("doctor self-tests the install without touching a file", () => {
  const out = run("doctor");
  assert.match(out, /decimen doctor/);
  assert.match(out, /codec\s+decimen-codec \d+\.\d+\.\d+/);
  assert.match(out, /sha-256\s+match/);
  assert.match(out, /OK — sending and receiving both work/);
  // No file argument, and nothing written: the whole check runs in memory.
  assert.doesNotMatch(out, /wrote/);
});

test("survives its output pipe closing early", () => {
  // `decimen doctor | head` used to die with an unhandled EPIPE stack trace.
  const out = execFileSync("/bin/sh", ["-c", `${process.execPath} ${CLI} doctor | head -3`], { encoding: "utf8" });
  assert.doesNotMatch(out, /EPIPE/);
  assert.doesNotMatch(out, /Unhandled/);
});

test("the single-file bundle works with nothing beside it", async () => {
  // dist/decimen.mjs carries the WASM codec inlined, for machines where npm
  // cannot reach a registry: one download, no extraction, no install.
  const solo = join(dir, "solo");
  await mkdir(solo, { recursive: true });
  await copyFile(new URL("../dist/decimen.mjs", import.meta.url).pathname, join(solo, "decimen.mjs"));
  assert.deepEqual(await readdir(solo), ["decimen.mjs"], "nothing else may be present");

  const src = join(solo, "payload.bin");
  const original = randomBytes(40_000);
  await writeFile(src, original);

  const solorun = (...args) =>
    execFileSync(process.execPath, [join(solo, "decimen.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  assert.match(solorun("doctor"), /OK — sending and receiving both work/);
  solorun("send", src, "--format", "apng", "-o", join(solo, "s.png"), "-q");
  solorun("receive", join(solo, "s.png"), "-o", join(solo, "out.bin"), "-q");
  assert.equal(sha(await readFile(join(solo, "out.bin"))), sha(original));
});

test("the .png output is a multi-frame APNG, not a still image", async () => {
  const src = join(dir, "anim.bin");
  await writeFile(src, randomBytes(30_000));
  const out = join(dir, "anim.png");
  run("send", src, "--format", "apng", "-o", out, "--cycles", "1", "--scale", "2", "-q");

  // Walk the chunks: acTL declares the animation, fcTL introduces each frame.
  const file = await readFile(out);
  let off = 8;
  let acTLFrames = 0;
  let fcTL = 0;
  while (off + 8 <= file.length) {
    const len = file.readUInt32BE(off);
    const type = file.toString("ascii", off + 4, off + 8);
    if (type === "acTL") acTLFrames = file.readUInt32BE(off + 8);
    if (type === "fcTL") fcTL++;
    if (type === "IEND") break;
    off += 12 + len;
  }
  assert.ok(acTLFrames > 1, `expected an animation, acTL declared ${acTLFrames} frames`);
  assert.equal(fcTL, acTLFrames, "every declared frame needs its own fcTL");
});

test("the HTML player carries an intact, decodable stream", async () => {
  const src = join(dir, "player.bin");
  const original = randomBytes(30_000);
  await writeFile(src, original);
  const out = join(dir, "player.html");
  run("send", src, "--format", "html", "-o", out, "--cycles", "1", "--scale", "2", "-q");

  const html = await readFile(out, "utf8");
  assert.match(html, /<!doctype html>/i);
  // Nearest-neighbour scaling: a smoothed QR loses module edges and stops decoding.
  assert.match(html, /image-rendering:\s*pixelated/);
  assert.match(html, /decimen\.app\/receive/);

  // The animation must be embedded, not referenced: this file travels alone.
  assert.doesNotMatch(html, /<img[^>]+src="(?!data:)/);
  const embedded = html.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(embedded, "expected the APNG inline as a data URI");

  // And it has to still be a working stream, not just bytes that look like one.
  const apng = join(dir, "from-html.png");
  await writeFile(apng, Buffer.from(embedded[1], "base64"));
  run("receive", apng, "-o", join(dir, "from-html.bin"), "-q");
  assert.equal(sha(await readFile(join(dir, "from-html.bin"))), sha(original));
});

test("splits a large file and rejoins it from parts arriving out of order", async () => {
  const src = join(dir, "split-src.bin");
  const original = randomBytes(220_000);
  await writeFile(src, original);

  const outDir = join(dir, "split-out");
  await mkdir(outDir, { recursive: true });
  run("send", src, "--format", "apng", "--split", "10s", "--scale", "2", "-o", join(outDir, "s.png"), "-q");

  const parts = (await readdir(outDir)).filter((f) => /\.p\d+of\d+\.png$/.test(f)).sort();
  assert.ok(parts.length >= 2, `expected the file to split, got ${parts.length} part(s)`);

  // Deliver them in the wrong order — a camera has no idea which part is which.
  const inDir = join(dir, "split-in");
  await mkdir(inDir, { recursive: true });
  const shuffled = [...parts].reverse();
  let last = "";
  for (const p of shuffled) last = run("receive", join(outDir, p), "-d", inDir, "-q").trim();

  // The last part completes the set, so receive prints the joined file.
  assert.equal(last, join(inDir, "split-src.bin"));
  assert.equal(sha(await readFile(last)), sha(original));

  // And the parts are cleaned up once they have been consumed.
  const leftovers = (await readdir(inDir)).filter((f) => /\.p\d+of\d+$/.test(f));
  assert.deepEqual(leftovers, [], "part files should be removed after joining");
});

test("holds parts separately until the whole set has arrived", async () => {
  const src = join(dir, "partial-src.bin");
  const original = randomBytes(200_000);
  await writeFile(src, original);

  const outDir = join(dir, "partial-out");
  await mkdir(outDir, { recursive: true });
  run("send", src, "--format", "apng", "--split", "8s", "--scale", "2", "-o", join(outDir, "s.png"), "-q");
  const parts = (await readdir(outDir)).filter((f) => /\.p\d+of\d+\.png$/.test(f)).sort();
  assert.ok(parts.length >= 3, `need at least three parts for this test, got ${parts.length}`);

  const inDir = join(dir, "partial-in");
  await mkdir(inDir, { recursive: true });
  for (const p of parts.slice(0, -1)) run("receive", join(outDir, p), "-d", inDir, "-q");

  const held = (await readdir(inDir)).sort();
  assert.equal(held.length, parts.length - 1, "every arrived part should be held on disk");
  assert.ok(held.every((f) => /\.[0-9a-f]{8}\.p\d+of\d+$/.test(f)), `unexpected names: ${held}`);
  assert.ok(!held.includes("partial-src.bin"), "must not assemble before the last part arrives");
});
