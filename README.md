# decimen-cli

Move a file between two machines with nothing but a screen and a camera — from
the terminal.

`decimen send` renders a file as a fountain-coded animated QR stream. Play it
on any display and it can be read back by **[decimen.app](https://decimen.app)**
in a phone browser, or by `decimen receive` on another machine. No network
between the two devices, no pairing, no account, no upload.

```
┌──────────────┐        photons         ┌──────────────┐
│ decimen send │ ─────────────────────▶ │ decimen.app  │
│  (terminal)  │   animated QR frames   │  or receive  │
└──────────────┘                        └──────────────┘
```

## Running it

Pick whichever matches your machine. All three give the same tool.

### 1. One file, no npm (works where npm cannot reach a registry)

```sh
curl -LO https://github.com/jackbauertv24-droid/decimen-cli/releases/download/v1.0.3/decimen.mjs
node decimen.mjs doctor
node decimen.mjs send ./report.pdf
```

One download, nothing to install and nothing to extract. The WASM codec is
inlined, so the file works on its own in an empty directory. This is the path
to use if `npx` hangs on a spinner — that spinner is npm talking to a registry
it cannot reach, and this route never involves npm at all.

### 2. Install it properly

```sh
npm install -g https://github.com/jackbauertv24-droid/decimen-cli/releases/download/v1.0.3/decimen-cli-1.0.3.tgz
decimen doctor
```

Also works from a tarball you already downloaded — `npm install -g ./decimen-cli-1.0.3.tgz`
needs no network.

### 3. Run once without installing

```sh
npx -y https://github.com/jackbauertv24-droid/decimen-cli/releases/download/v1.0.3/decimen-cli-1.0.3.tgz send ./report.pdf
```

Under a second cold, but it does require npm to reach the network.

### Not recommended: the `github:` spec

`npx github:jackbauertv24-droid/decimen-cli` re-clones the whole repository on
**every single run** — about a megabyte before your file is touched, and that
clone is the spinner. `npm install -g github:...` is worse: on npm 11 it can
leave a dangling symlink into npm's own cache, so `decimen` ends up pointing at
nothing. Use a release asset instead.

### No npm and no curl?

The tarball is a plain gzipped tar. Extract it and run the bundle directly:

```sh
tar -xzf decimen-cli-1.0.3.tgz
node package/dist/cli.js doctor
```

## Is it working? `decimen doctor`

Checks the install end to end without sending anything. No file argument,
nothing written to disk — it encodes a payload in memory, reads the frames back
through the real WASM decoder and compares SHA-256:

```
$ decimen doctor

  cli           1.0.3  build 4c32306 (2026-09-15)
  node          v24.19.0  linux x64
  wire format   v3
  startup       62 ms from process start to here
  codec         decimen-codec 0.2.0 build dc2b8c5   loaded in 8 ms
  ffmpeg        not found — only needed for video and camera input

  self-test     encode -> QR -> decode -> verify, entirely in memory
    payload     720 B -> 2 frames, 370x370
    encode      62 ms
    decode      56 ms  (1 symbol read)
    sha-256     match

  OK — sending and receiving both work on this machine.
```

It exits non-zero if any check fails, so it works in a script.

The `startup` line is the one that settles arguments about speed: it is the
time from process launch to that line. **If npm spun for thirty seconds and
this reports 62 ms, the delay was never in this program** — it was npm fetching
the package, which is what the release tarball below is for.

## Which version am I running?

```sh
decimen --version
# decimen-cli 1.0.0  build bb464d1 (2026-09-15)  wire v3
```

The build hash is baked in at bundle time and names the source commit the
binary was built from, so you can compare it against the commit list on GitHub.

`npx` re-resolves its source on every run, so you are never served a stale
build — but with a `github:` spec that means re-cloning the repository each
time. The release tarball is fetched and cached instead, which is why it starts
in under a second.

To update later, re-run the same `npm install -g` against a newer release URL.

## Receive

### With the web app — nothing to install

Play the animation fullscreen and open **<https://decimen.app/receive>** on a
phone. Point it at the screen. That is the whole procedure; the receiving
device needs only a browser and a camera.

### With the CLI

```sh
decimen receive ./report.pdf.decimen.png      # read back an APNG
decimen receive ./frames/                     # a directory of PNG frames
decimen receive ./screen-recording.mp4        # any video ffmpeg can read
decimen receive --camera                      # live capture (needs ffmpeg)
decimen receive --camera --device /dev/video1 # pick a specific capture device
```

It prints the path it wrote and verifies the payload's SHA-256 before writing
anything. Video and camera input shell out to `ffmpeg`; the other two modes
need nothing but Node.

## Options

```
send
  -o, --out <path>       output file (default: <file>.decimen.png)
      --format <fmt>     apng | zip                  (default: apng)
      --fps <n>          animation frame rate        (default: 10)
      --scale <n>        integer module upscale      (default: 4)
      --cycles <n>       carousel cycles, >=1        (default: 2)
      --ecc <L|M|Q|H>    QR error correction         (default: L)
      --grid <n>         QR codes per frame          (default: 1)
      --frame-bytes <n>  wire bytes per QR           (default: 2953)

receive
  -o, --out <path>       write here instead of <dir>/<original name>
  -d, --dir <path>       directory to write into     (default: .)
      --fps <n>          sample video/camera at n fps
      --symbols <n>      max QR codes per frame      (default: 4)
      --device <name>    capture device for --camera
```

`--format zip` writes numbered PNGs instead of an APNG, which is what you want
if you plan to feed the frames to a video encoder.

## What to expect

`send` prints the playback duration before it starts rendering, because that
is the number that decides whether a transfer is practical — not the render
time. Measured on a laptop-class machine at the defaults:

| Input | Frames | Render | APNG size | Playback at 10 fps |
|---|---|---|---|---|
| 40 KB | 56 | 0.5 s | 350 KB | 6 s |
| 100 KB | 140 | 0.9 s | 877 KB | 14 s |
| 1 MB | 1,368 | 8.3 s | 8.6 MB | 2 min 17 s |
| 5 MB | 6,824 | 44 s | 43 MB | 11 min 22 s |

Two consequences worth internalising:

- **The animation is roughly 8.6x the size of the input.** Every byte becomes
  QR modules rendered as pixels.
- **Playback time, not render time, is the ceiling.** A 5 MB file is an
  eleven-minute animation somebody has to hold a camera at without losing
  focus. This is a tool for keys, configs, certificates, recovery phrases and
  documents. It is not a way to move a video file.

If the stream runs long, `--grid 4` packs four QR codes into each frame and
cuts the frame count to roughly a quarter. `--fps 30` helps if both the
display and the camera genuinely keep up.

Separately, `npx` spends a few seconds cloning the repo before any of this
starts, and shows its own spinner while it does. Output from the tool begins
only after that.

## Things worth knowing

**`--cycles` is the dial that matters.** One cycle is *k* systematic frames
plus *k* repair frames, and the fountain needs roughly *k × 1.15* **distinct**
frames to peel. At `--cycles 1` there is almost no margin: in testing, a
200 KB payload captured with 35% frame loss stalled at 44 of 69 blocks and
never finished. The same payload at `--cycles 3` under the same loss decoded
cleanly. The default of 2 is a reasonable floor; raise it for a handheld
camera, drop to 1 only for an animation you loop forever.

**This is an air gap, not a secure channel.** The stream is not encrypted.
Anyone with line of sight to the screen — or a copy of the APNG — reconstructs
the file exactly as the intended receiver does. Encrypt the file before sending
it if it matters:

```sh
age -r age1... secrets.tar | sponge secrets.tar.age
decimen send ./secrets.tar.age
```

**Throughput is bounded by the camera, not the encoder.** Frames carry 2953
wire bytes by default; at 10 fps that is a ceiling of about 29 KB/s before
losses, and a phone camera reading off a screen will do considerably less.
Fine for keys, configs, certificates and documents. Not a way to move video.

**Size cap:** 64 MB, inherited from the wire format.

## How it works

The interesting parts are not ours. `src/` is argument parsing, frame plumbing
and the WASM loader; everything on the wire comes from the upstream Decimen
project, vendored unmodified in `vendor/`:

| Stage | Where it lives |
|---|---|
| Container: gzip when it helps, SHA-256 of the original | `vendor/shared/protocol.ts` — `packFile` |
| Fountain coding (Luby transform, robust soliton) | `vendor/shared/fountain.ts` — `LTEncoder` / `LTDecoder` |
| 22-byte frame header, magic `0xD1 0xC3`, wire v3 | `vendor/shared/protocol.ts` — `packFrame` |
| QR generation, mask pinned to 4 at ECC L | `vendor/send/qr-frame.ts` |
| Rasterizing and APNG/ZIP assembly | `vendor/send/export.ts`, `vendor/shared/apng.ts` |
| QR reading (zxing-cpp, reader-only, WASM) | `vendor/decimen-codec/` |

Those modules are deliberately DOM-free upstream — the exporter's own header
comment says it is written that way "so the whole pipeline golden-tests in
Node" — which is the only reason this CLI is as thin as it is.

The one adaptation: the codec's Emscripten glue only knows how to fetch its
`.wasm` from a browser or worker, and its Node branch is empty. `src/codec.ts`
sidesteps that by reading the binary from disk and handing the module in
through `instantiateWasm`.

## Verified, not assumed

`npm test` runs the loop end to end against the built bundle: send a payload,
read the frames back through the real WASM decoder, compare SHA-256.

```
✔ round-trips an APNG stream byte-identically
✔ round-trips a small text file and preserves its name and type
✔ recovers from 35% frame loss when sent with enough cycles
✔ refuses a source with no Decimen frames
```

Wire compatibility with decimen.app is established at the byte level: frames
carry the documented v3 header and decode with decimen.app's own codec build.
What has *not* been tested here is a physical camera pointed at a physical
screen — that path depends on your display, lighting and lens, and `--cycles`
and `--scale` are the knobs for it.

## Building

```sh
npm install
npm run build      # esbuild -> dist/cli.js, plus the .wasm alongside
npm run typecheck
npm test
```

`dist/` is committed on purpose: it is what lets a release asset run with
nothing installed. `npm run build` emits both bundles — `dist/cli.js`, which
reads the codec from `vendor/`, and `dist/decimen.mjs`, which inlines it.

## Licence

AGPL-3.0-or-later, inherited from the vendored Decimen code. See `LICENSE` and
`NOTICE` for full attribution, including zxing-cpp (Apache-2.0) inside the WASM
codec. If you modify this and offer it to users over a network, the AGPL
requires you to offer them your source.

Upstream, and the people who did the hard part:
**[decimen-optical-transfer](https://github.com/bashalarmistalt/decimen-optical-transfer)**
and **[decimen-codec](https://github.com/bashalarmistalt/decimen-codec)** by
Evan Crawley (Bash Alarmist).
