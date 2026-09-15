// End-to-end tests against the built bundle: send produces frames, receive
// reads them back byte-identically, and the fountain survives frame loss.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
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

  run("send", src, "-o", join(dir, "stream.png"), "--cycles", "2", "--scale", "2", "-q");
  run("receive", join(dir, "stream.png"), "-o", join(dir, "out.bin"), "-q");

  assert.equal(sha(await readFile(join(dir, "out.bin"))), sha(original));
});

test("round-trips a small text file and preserves its name and type", async () => {
  const src = join(dir, "notes.txt");
  await writeFile(src, "decimen round trip\n".repeat(200));
  run("send", src, "-o", join(dir, "notes.png"), "-q");
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
