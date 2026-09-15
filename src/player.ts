// A self-contained HTML player for the animation.
//
// Windows Photos, macOS Preview and most desktop image viewers render only the
// first frame of an APNG, so a .png hands people a static QR code and no error.
// Browsers animate APNG correctly, so the fix is to ship something whose
// default application IS a browser. Double-clicking this file plays the stream.
//
// The display rules matter as much as the playback: a QR code resampled with
// smoothing loses module edges, so the image is scaled with nearest-neighbour
// and sat on black with the code's own quiet zone providing the white border.

export interface PlayerOptions {
  apng: Uint8Array;
  fileName: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  playbackSeconds: number;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderPlayer(o: PlayerOptions): string {
  const dataUri = `data:image/png;base64,${Buffer.from(o.apng).toString("base64")}`;
  const name = escapeHtml(o.fileName);
  const duration = o.playbackSeconds < 60
    ? `${Math.round(o.playbackSeconds)} s`
    : `${Math.floor(o.playbackSeconds / 60)} min ${Math.round(o.playbackSeconds % 60)} s`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name} — Decimen stream</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: #000; color: #e7e7e7;
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; padding: 16px; overflow: hidden;
  }
  /* Nearest-neighbour: a smoothed QR loses its module edges and stops decoding. */
  img {
    image-rendering: pixelated;
    max-width: min(100%, 92vh); max-height: 92vh;
    width: auto; height: auto; display: block;
  }
  #bar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    justify-content: center; max-width: 100%;
  }
  #meta { color: #8b8b8b; font-variant-numeric: tabular-nums; text-align: center; }
  #meta b { color: #e7e7e7; font-weight: 600; }
  button {
    font: inherit; color: #e7e7e7; background: #1c1c1c;
    border: 1px solid #333; border-radius: 8px; padding: 8px 14px; cursor: pointer;
  }
  button:hover { background: #262626; border-color: #4a4a4a; }
  button:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
  body.full { gap: 0; padding: 0; cursor: none; }
  body.full #bar { display: none; }
  body.full img { max-width: 100vw; max-height: 100vh; }
  @media (max-width: 600px) { img { max-width: 100%; max-height: 70vh; } }
</style>
</head>
<body>
  <img id="stream" src="${dataUri}" alt="Animated QR stream for ${name}" width="${o.width}" height="${o.height}">
  <div id="bar">
    <button id="fs" type="button">Fullscreen</button>
    <button id="restart" type="button">Restart</button>
    <div id="meta">
      <b>${name}</b> · ${o.frameCount} frames · ${o.fps} fps · one pass ${duration}
      <br>Point <b>decimen.app/receive</b> at this screen. It loops, so a missed frame comes back.
    </div>
  </div>
<script>
  const img = document.getElementById("stream");
  const body = document.body;

  document.getElementById("fs").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else body.requestFullscreen?.().catch(() => {});
  });

  // Re-assigning src restarts the APNG from frame 1; the data URI is already
  // in memory, so this costs no fetch.
  const src = img.src;
  document.getElementById("restart").addEventListener("click", () => {
    img.src = "";
    img.src = src;
  });

  document.addEventListener("fullscreenchange", () => {
    body.classList.toggle("full", !!document.fullscreenElement);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") document.getElementById("fs").click();
    if (e.key === "r" || e.key === "R") document.getElementById("restart").click();
  });
</script>
</body>
</html>
`;
}
