// Collect a Decimen stream back into a file: frames in, fountain peeled, the
// container unpacked and its SHA-256 verified before anything is written.
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

import { parseFrame, streamIdentity, unpackFile, verifyFile } from "../vendor/shared/protocol.ts";
import { LTDecoder } from "../vendor/shared/fountain.ts";
import { loadCodec, readFrame, type RgbaFrame } from "./codec.ts";

export interface ReceiveOptions {
  frames: AsyncGenerator<RgbaFrame>;
  outDir: string;
  out?: string;
  maxSymbols: number;
  quiet: boolean;
  /** Called when the transfer completes, so a live source can be shut down. */
  onDone?: () => void;
}

export interface ReceiveResult {
  path: string;
  name: string;
  type: string;
  size: number;
  framesSeen: number;
  framesUsed: number;
  /** Set when the payload was one part of a split transfer. */
  part?: { index: number; total: number; have: number };
  /** Set when that part completed the set and the original was reassembled. */
  joined?: string;
}

/** `<file>.<runId>.pNNofMM` — the shape `send --split` gives each part. */
const PART_NAME = /^(.+)\.([0-9a-f]{8})\.p(\d+)of(\d+)$/;

interface PartName { base: string; runId: string; index: number; total: number }

function parsePartName(name: string): PartName | null {
  const m = PART_NAME.exec(name);
  if (!m) return null;
  return { base: m[1], runId: m[2], index: Number(m[3]), total: Number(m[4]) };
}

/**
 * Reassemble once every part of a set is on disk.
 *
 * Each part was verified against its own SHA-256 as it arrived, so the only
 * thing left to establish is that these parts belong to each other and are in
 * the right order. The run id in the name is the first 8 hex of the whole
 * file's digest, so re-hashing the joined result proves both at once.
 */
async function tryJoin(dir: string, part: PartName, log: (s: string) => void): Promise<{ joined?: string; have: number }> {
  const found = new Map<number, string>();
  for (const entry of await readdir(dir)) {
    const p = parsePartName(entry);
    if (p && p.base === part.base && p.runId === part.runId && p.total === part.total) found.set(p.index, entry);
  }
  if (found.size < part.total) return { have: found.size };

  const chunks: Buffer[] = [];
  for (let i = 1; i <= part.total; i++) {
    const entry = found.get(i);
    if (!entry) return { have: found.size };
    chunks.push(await readFile(join(dir, entry)));
  }
  const whole = Buffer.concat(chunks);
  const digest = createHash("sha256").update(whole).digest("hex");
  if (!digest.startsWith(part.runId)) {
    throw new Error(
      `parts do not belong together: names say run ${part.runId}, the joined bytes hash to ${digest.slice(0, 8)}`,
    );
  }

  const out = join(dir, part.base);
  await writeFile(out, whole);
  for (const entry of found.values()) await unlink(join(dir, entry));
  log(`joined    ${part.total} parts -> ${part.base} (${whole.length} B), SHA-256 ${digest.slice(0, 16)}...\n`);
  return { joined: out, have: found.size };
}

export async function receive(o: ReceiveOptions): Promise<ReceiveResult | null> {
  const zx = await loadCodec();
  let decoder: LTDecoder | null = null;
  let identity = "";
  let framesSeen = 0;
  let framesUsed = 0;
  const log = o.quiet ? () => {} : (s: string) => process.stderr.write(s);

  log("waiting for a Decimen stream...\n");

  for await (const frame of o.frames) {
    framesSeen++;
    for (const payload of readFrame(zx, frame, o.maxSymbols)) {
      const parsed = parseFrame(payload);
      if (!parsed) continue;
      const { header, block } = parsed;

      // Any change to a field that must hold constant means a different
      // stream — a restarted sender, or a second one in view. Start over.
      const id = streamIdentity(header);
      if (id !== identity) {
        identity = id;
        decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
        log(`\nstream    session ${header.sessionId}, k=${header.k}, ${header.totalLen} B payload\n`);
      }
      decoder!.addFrame(header.seq, block);
      framesUsed++;

      if (!o.quiet) {
        // Frames collected, not blocks solved: the peeling cascade back-loads,
        // so blocks-solved sits flat and then teleports.
        const pct = Math.min(100, Math.round((decoder!.framesNew / (decoder!.k * 1.15)) * 100));
        process.stderr.write(`\rcollect   ${decoder!.framesNew} frames  ~${pct}%  (${decoder!.solvedCount}/${decoder!.k} blocks)   `);
      }
      if (decoder!.isComplete) {
        o.onDone?.();
        const container = decoder!.assemble()!;
        const file = await unpackFile(container);
        if (!(await verifyFile(file))) throw new Error("SHA-256 mismatch — the reassembled file is corrupt");
        log("\n");

        // An explicit --out means the caller wants this exact payload at that
        // exact path, so it wins over the part-joining convention.
        const part = o.out ? null : parsePartName(file.name);
        if (part) {
          const path = join(o.outDir, file.name);
          await writeFile(path, file.bytes);
          const { joined, have } = await tryJoin(o.outDir, part, log);
          return {
            path, name: file.name, type: file.type, size: file.bytes.length,
            framesSeen, framesUsed, part: { index: part.index, total: part.total, have }, joined,
          };
        }

        const path = o.out ?? join(o.outDir, basename(file.name) || "received.bin");
        await writeFile(path, file.bytes);
        return { path, name: file.name, type: file.type, size: file.bytes.length, framesSeen, framesUsed };
      }
    }
  }

  log("\n");
  if (decoder && !decoder.isComplete) {
    const need = Math.ceil(decoder.k * 1.15);
    throw new Error(
      `stream ended short: ${decoder.solvedCount}/${decoder.k} blocks from ${decoder.framesNew} frames ` +
        `(needs roughly ${need}). Capture more of the animation, or re-send with a higher --cycles.`,
    );
  }
  return null;
}
