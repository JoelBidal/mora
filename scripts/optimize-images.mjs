/**
 * Optimises the source images in /assets-src into /public/assets.
 *
 *   npm run optimize:images
 *
 * Each image is sized to ~2× the largest size it is displayed at (desktop or mobile), so it
 * stays sharp on retina screens without shipping unused pixels. Sources stay out of /public
 * so they are never deployed.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "assets-src");
const OUT = path.join(root, "public/assets");

const webp = (quality, extra = {}) => ({ format: "webp", options: { quality, effort: 6, smartSubsample: true, ...extra } });

/** file → { out, width?, encode } */
const IMAGES = {
  // Hero face: shown at 482×647 (source is already below 2×). Keeps its alpha.
  "face.png": { out: "face.webp", encode: webp(85, { alphaQuality: 95 }) },

  // Noise overlay texture: fine grain + alpha → lossless (lossy smears the grain).
  "noise.png": { out: "noise.webp", encode: { format: "webp", options: { lossless: true, effort: 6 } } },

  // Bento tiles (up to ~380px wide on desktop, ~360×450 on mobile) → 800px wide.
  "bento-science.png": { out: "bento-science.webp", width: 800, encode: webp(78) },
  "bento-botanical.png": { out: "bento-botanical.webp", width: 800, encode: webp(78) },
  "bento-designed.png": { out: "bento-designed.webp", width: 800, encode: webp(78) },
  "bento-microbiome.png": { out: "bento-microbiome.webp", width: 800, encode: webp(78) },
  "bento-skin.png": { out: "bento-skin.webp", width: 800, encode: webp(78) },
  "bento-ecosystem.png": { out: "bento-ecosystem.webp", width: 800, encode: webp(78) },
  "bento-everyone.png": { out: "bento-everyone.webp", width: 800, encode: webp(78) },

  // Stat card background: heavily blurred on the page, so a small file is plenty.
  "stat-understand.png": { out: "stat-understand.webp", width: 480, encode: webp(72) },

  // Pre-dithered photo (exported from Figma at 2×). Lossy WebP/AVIF smear the dot grid;
  // a full-chroma (4:4:4) mozjpeg keeps it while cutting ~85% of the weight. No resize.
  "approach-flower.jpg": {
    out: "approach-flower.jpg",
    encode: { format: "jpeg", options: { quality: 88, mozjpeg: true, chromaSubsampling: "4:4:4" } },
  },
};

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`.padStart(8);

await mkdir(OUT, { recursive: true });
const sources = new Set(await readdir(SRC));
let before = 0;
let after = 0;

for (const [file, cfg] of Object.entries(IMAGES)) {
  if (!sources.has(file)) {
    console.warn(`skip ${file}: not found in assets-src/`);
    continue;
  }
  const input = path.join(SRC, file);
  const output = path.join(OUT, cfg.out);
  let img = sharp(input);
  if (cfg.width) img = img.resize({ width: cfg.width, withoutEnlargement: true });
  const info = await img.toFormat(cfg.encode.format, cfg.encode.options).toFile(output);
  const inSize = (await stat(input)).size;
  before += inSize;
  after += info.size;
  console.log(`${file.padEnd(22)} ${kb(inSize)} → ${kb(info.size)}  ${cfg.out} (${info.width}×${info.height})`);
}

console.log(`\nTotal ${kb(before)} → ${kb(after)}  (−${Math.round((1 - after / before) * 100)}%)`);
