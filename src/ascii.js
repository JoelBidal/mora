/**
 * Draws Figma's masked ASCII art onto a canvas.
 *
 * In Figma ("Mask group", node 3812:66) the ASCII frame is an alpha mask over a vertical
 * linear gradient, so the glyphs only show the gradient colour. Here every glyph is drawn
 * at its exact grid position and filled with that same gradient.
 */

// Inter's ascender (hhea) in em: with Figma's AUTO line height, the baseline sits this far
// below the text box's top edge.
const INTER_ASCENDER = 0.96875;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{x0:number,y0:number,dx:number,dy:number,rows:string[]}} art
 * @param {object} opts
 */
export async function drawAsciiArt(canvas, art, opts) {
  const {
    width,
    height,
    fontSize = 12,
    fontFamily = "Inter",
    offsetY = 0, // art frame's y inside the card
    clipHeight = height, // art frame clips its content
    gradient, // { y0, y1, from, to } in card coordinates
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, offsetY, width, clipHeight);
  ctx.clip();

  const fill = ctx.createLinearGradient(0, gradient.y0, 0, gradient.y1);
  fill.addColorStop(0, gradient.from);
  fill.addColorStop(1, gradient.to);
  ctx.fillStyle = fill;
  ctx.font = font;
  ctx.textBaseline = "alphabetic";

  const baseline = offsetY + fontSize * INTER_ASCENDER;
  art.rows.forEach((row, r) => {
    const y = baseline + art.y0 + r * art.dy;
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch !== " ") ctx.fillText(ch, art.x0 + c * art.dx, y);
    }
  });
  ctx.restore();
}
