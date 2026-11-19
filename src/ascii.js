/**
 * Figma's masked ASCII art, drawn on a canvas — and animated.
 *
 * In Figma ("Mask group", node 3812:66) the ASCII frame is an alpha mask over a vertical
 * linear gradient. Here the glyphs are drawn opaque, then the gradient is composited
 * `source-in`, which is exactly that mask.
 *
 * Animation: the silhouette never changes — the same cells stay filled and empty cells stay
 * empty. Each glyph is a step on a density ramp (. : - = + * # %); a slow field of
 * interfering waves drifts across the flower and nudges every glyph one step up or down
 * that ramp, so the shading flows while the image stays readable. A few cells also flicker
 * to a random glyph for an instant.
 *
 * Performance: the glyphs are rasterised once into an atlas and blitted each frame
 * (no per-frame text shaping); redraws are capped at ~30 fps and stop off-screen.
 */

// Inter's ascender (hhea) in em: with Figma's AUTO line height, the baseline sits this far
// below the text box's top edge.
const INTER_ASCENDER = 0.96875;

// Density ramp, light → dense. Every glyph used by the art is on it.
const RAMP = [".", ":", "-", "=", "+", "*", "#", "%"];

const FPS = 30;
const TAU = Math.PI * 2;

// Cheap deterministic hash → [0, 1)
function hash(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth field in [-1, 1]: three plane waves in different directions and speeds. */
function field(c, r, t) {
  return (
    0.5 * Math.sin(c * 0.16 + r * 0.1 - t * 1.1) +
    0.3 * Math.sin(-c * 0.07 + r * 0.19 - t * 0.7 + 1.3) +
    0.2 * Math.sin(c * 0.23 - r * 0.13 + t * 1.6 + 2.1)
  );
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{x0:number,y0:number,dx:number,dy:number,rows:string[]}} art
 * @param {object} opts
 * @returns {Promise<{ draw: (t?: number) => void, start: () => void, stop: () => void }>}
 */
export async function createAsciiArt(canvas, art, opts) {
  const {
    width,
    height,
    fontSize = 12,
    fontFamily = "Inter",
    offsetY = 0, // art frame's y inside the card
    clipHeight = height, // art frame clips its content
    gradient, // { y0, y1, from, to } in card coordinates
    animate = true,
    amplitude = 1.45, // wave shift in ramp steps (rounds to at most ±1, so shading stays readable)
    flicker = 0.012, // share of cells flickering at any moment
  } = opts;

  const font = `400 ${fontSize}px ${fontFamily}`;
  try {
    await document.fonts.load(font);
  } catch {
    /* fall back to whatever is available */
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");

  // --- Glyph atlas: each ramp glyph rasterised once at device resolution ---------------
  const pad = 2;
  const ascent = fontSize * INTER_ASCENDER;
  const cellW = Math.ceil(fontSize) + pad * 2;
  const cellH = Math.ceil(fontSize * 1.25) + pad * 2;
  const atlas = document.createElement("canvas");
  atlas.width = Math.ceil(cellW * RAMP.length * dpr);
  atlas.height = Math.ceil(cellH * dpr);
  const actx = atlas.getContext("2d");
  actx.scale(dpr, dpr);
  actx.font = font;
  actx.textBaseline = "alphabetic";
  actx.fillStyle = "#000";
  RAMP.forEach((g, i) => actx.fillText(g, i * cellW + pad, pad + ascent));

  // --- Cells: position (snapped to device pixels) + base density -----------------------
  const cells = [];
  art.rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const base = RAMP.indexOf(row[c]);
      if (base < 0) continue; // spaces stay empty: the silhouette never changes
      cells.push({
        c,
        r,
        base,
        x: Math.round((art.x0 + c * art.dx - pad) * dpr) / dpr,
        y: Math.round((offsetY + art.y0 + r * art.dy - pad) * dpr) / dpr,
      });
    }
  });

  const fill = ctx.createLinearGradient(0, gradient.y0, 0, gradient.y1);
  fill.addColorStop(0, gradient.from);
  fill.addColorStop(1, gradient.to);

  const sw = cellW * dpr;
  const sh = cellH * dpr;
  const last = RAMP.length - 1;

  /** Draws one frame. t in seconds; omit for the static, original art. */
  function draw(t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, offsetY, width, clipHeight);
    ctx.clip();

    const tick = t === undefined ? 0 : Math.floor(t * 7); // flicker slots
    for (const cell of cells) {
      let i = cell.base;
      if (t !== undefined) {
        i += Math.round(field(cell.c, cell.r, t) * amplitude);
        if (hash(cell.c, cell.r, tick) < flicker) i = Math.floor(hash(cell.r, cell.c, tick + 99) * RAMP.length);
        i = i < 0 ? 0 : i > last ? last : i;
      }
      ctx.drawImage(atlas, i * sw, 0, sw, sh, cell.x, cell.y, cellW, cellH);
    }

    // Recolour the glyphs with the gradient (= Figma's alpha mask).
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = fill;
    ctx.fillRect(0, offsetY, width, clipHeight);
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
  }

  // --- Loop: ~30 fps, only while on screen ---------------------------------------------
  let running = false;
  let visible = false;
  let raf = 0;
  let lastDraw = -Infinity;
  const t0 = performance.now();

  function frame(now) {
    if (!running) return;
    if (now - lastDraw >= 1000 / FPS - 1) {
      lastDraw = now;
      draw((now - t0) / 1000);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || !animate) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  draw(animate ? 0 : undefined);

  if (animate) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      visible ? start() : stop();
    }).observe(canvas);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else if (visible) start();
    });
  }

  return { draw, start, stop };
}
