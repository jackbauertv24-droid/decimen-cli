// Play the stream in the terminal itself — no browser, no image viewer, no
// window manager. The QR modules are drawn with half-block characters, so one
// character cell carries two modules vertically and the code fits in half the
// rows it otherwise would.
//
// This is the point of a CLI on an air-gapped box: the machine that holds the
// secret never has to open anything. You run one command, a camera reads the
// screen, and nothing is installed to make that happen.
import { LTEncoder } from "../vendor/shared/fountain.ts";
import { blockLength } from "../vendor/shared/frame-capacity.ts";
import { fnv1a, packFrame, type FrameHeader } from "../vendor/shared/protocol.ts";
import { FRAME_BYTES_OPTIONS } from "../vendor/shared/send-settings.ts";
import { QUIET_ZONE_MODULES, createFrameQr, type EccLevel } from "../vendor/send/qr-frame.ts";

/** One wire frame as a square module grid: 1 = dark, 0 = light. */
export interface ModuleFrame {
  size: number;
  data: ArrayLike<number>;
  seq: number;
  k: number;
}

export function frameStream(
  payload: Uint8Array,
  frameBytes: number,
  ecc: EccLevel,
  sessionId: number,
): { k: number; next(): ModuleFrame } {
  const blockLen = blockLength(frameBytes);
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
    flags: 0,
  };
  let version: number | undefined; // locked by the first code, like the live stream
  let seq = 0;
  return {
    k: encoder.k,
    next(): ModuleFrame {
      const bytes = packFrame({ ...header, seq }, encoder.encode(seq));
      const qr = createFrameQr(bytes, ecc, version);
      version ??= qr.version;
      return { size: qr.modules.size, data: qr.modules.data, seq: seq++, k: encoder.k };
    },
  };
}

// Four possible cell states, one escape sequence each. Bright white against
// black keeps the contrast a camera needs.
// Indexed by (top light ? 1 : 0) | (bottom light ? 2 : 0). The foreground
// paints the upper half of "▀" and the background the lower half.
const CELL = [
  "\x1b[30;40m",   // both halves dark
  "\x1b[97;40m",   // top light, bottom dark
  "\x1b[30;107m",  // top dark, bottom light
  "\x1b[97;107m",  // both halves light
];

/**
 * Render one frame as half-block rows.
 *
 * "▀" paints the upper half in the foreground colour and the lower half in the
 * background colour, so one cell carries two module rows. A QR needs a light
 * quiet zone to be found at all, so the margin is drawn light, not skipped.
 */
export function renderFrame(frame: ModuleFrame, quiet = QUIET_ZONE_MODULES): string {
  const span = frame.size + quiet * 2;
  // Dark module => paint dark. Outside the code (the quiet zone) is light.
  const at = (x: number, y: number): 0 | 1 => {
    const mx = x - quiet;
    const my = y - quiet;
    if (mx < 0 || my < 0 || mx >= frame.size || my >= frame.size) return 0;
    return frame.data[my * frame.size + mx] ? 1 : 0;
  };

  const out: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let row = "";
    let run = -1;
    let count = 0;
    for (let x = 0; x < span; x++) {
      const top = at(x, y);
      const bottom = y + 1 < span ? at(x, y + 1) : 0;
      // Light is what the camera reads as white: foreground white where the
      // half is light, so "▀" shows light on top and the background shows the
      // bottom half.
      const state = (top ? 0 : 1) | (bottom ? 0 : 2);
      if (state === run) {
        count++;
      } else {
        if (run >= 0) row += CELL[run] + "▀".repeat(count);
        run = state;
        count = 1;
      }
    }
    if (run >= 0) row += CELL[run] + "▀".repeat(count);
    out.push(row + "\x1b[0m");
  }
  return out.join("\n");
}

/** Largest wire-frame size whose QR still fits the terminal, or null if none do. */
export function fitFrameBytes(columns: number, rows: number, ecc: EccLevel): number | null {
  const probe = new Uint8Array(32);
  for (const candidate of [...FRAME_BYTES_OPTIONS].sort((a, b) => b - a)) {
    const blockLen = blockLength(candidate);
    // Header plus one block is exactly what a real frame carries.
    const bytes = new Uint8Array(22 + blockLen);
    bytes.set(probe.subarray(0, Math.min(probe.length, bytes.length)));
    let size: number;
    try {
      size = createFrameQr(bytes, ecc, undefined).modules.size;
    } catch {
      continue;
    }
    const span = size + QUIET_ZONE_MODULES * 2;
    if (span <= columns && Math.ceil(span / 2) <= rows) return candidate;
  }
  return null;
}
