/**
 * Mora landing — entry point.
 *
 * The page is plain HTML/CSS. Progressive enhancements are mounted here:
 *  1. The hero artwork gets Figma's Dither shader via WebGPU, without the experimental
 *     HTML-in-Canvas API (./hero-dither.js). A cursor-driven "dither stir" exists in
 *     ./dither-stir.js but is not enabled yet.
 *  2. The bubbles rise, wobble and pop in a small physics simulation (./bubbles.js), each with
 *     Figma's Glass effect (./glass.js).
 *  3. Section 4: the masked ASCII art, animated (./ascii.js). Its photo is a static, pre-dithered export.
 */
import { mountHeroDither } from "./hero-dither.js";
import { initGlass } from "./glass.js";
import { initBubbles } from "./bubbles.js";
import { createAsciiArt } from "./ascii.js";
import { ASCII_FLOWER } from "./data/ascii-flower.js";

/* ---------- 1. Dither shader on the hero asset ---------- */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const DITHER_PARAMS = {
  algorithm: "Bayer 16x16",
  monoColor: { r: 1, g: 1, b: 1, a: 1 },
  contrast: 1.01,
  levels: 8,
  mono: false,
  brightness: 101,
  pixelSize: 2,
};

// Work in progress, not enabled: ./dither-stir.js (cursor reshuffles the dither dots without
// moving the image). It would go between the image source and the dither in hero-dither.js;
// note it repaints via canvas.requestPaint(), which a child-less ShaderEffect doesn't have.

const heroDither = document.getElementById("hero-dither");
const heroArt = document.querySelector(".hero-asset__inner");
if (heroDither && heroArt) {
  // WebGPU only (no HTML-in-Canvas). Without it, the static artwork underneath stays visible.
  mountHeroDither(heroDither, heroArt, DITHER_PARAMS);
}

/* ---------- 2. Bubbles: physics simulation (static glass bubbles with reduced motion) ---------- */

const bubblesEl = document.querySelector(".bubbles");
if (bubblesEl) {
  if (reducedMotion) {
    initGlass(bubblesEl.querySelectorAll(".bubble[data-glass]"));
  } else {
    initBubbles(bubblesEl);
  }
}

/* ---------- 3. Section 4: animated ASCII art ---------- */
// (The flower photo behind it is a static export with the dither baked in — no runtime shader.)

const asciiCanvas = document.getElementById("approach-ascii");
if (asciiCanvas) {
  // Mask frame sits at y = -1.5 and clips to 545px; gradient rect spans y 0.5 → 550.5.
  createAsciiArt(asciiCanvas, ASCII_FLOWER, {
    width: 448,
    height: 550,
    offsetY: -1.5,
    clipHeight: 545,
    gradient: { y0: 0.5, y1: 550.5, from: "rgb(40, 45, 4)", to: "rgb(151, 151, 151)" },
    animate: !reducedMotion,
  });
}
