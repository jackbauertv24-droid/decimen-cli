// Collect a Decimen stream back into a file: frames in, fountain peeled, the
// container unpacked and its SHA-256 verified before anything is written.
import { writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

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
        const path = o.out ?? join(o.outDir, basename(file.name) || "received.bin");
        await writeFile(path, file.bytes);
        log("\n");
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
