/**
 * Mora landing — entry point.
 *
 * The page is plain HTML/CSS. Progressive enhancements are mounted here:
 *  1. The hero asset (face + gradients) is wrapped in Figma's Dither ShaderEffect
 *     (`@figma/expressive-components`, a React component → mounted as a small React island).
 *     A cursor-driven "dither stir" exists in ./dither-stir.js but is not enabled yet.
 *  2. The bubbles rise, wobble and pop in a small physics simulation (./bubbles.js), each with
 *     Figma's Glass effect (./glass.js).
 *  3. Section 4: the masked ASCII art, animated (./ascii.js). Its photo is a static, pre-dithered export.
 */
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ShaderEffect } from "@figma/expressive-components";
import {
  setup as setupDither,
  render as renderDither,
  manifest as ditherManifest,
} from "./lib/custom-effects/CodeComponentId_55a4ca852373c81b69803326c5af7aa5f1af580b_412";
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

// Module-scope → stable reference.
// Work in progress, not enabled: ./dither-stir.js (cursor reshuffles the dither dots without
// moving the image). To try it: import createDitherStirShader/initDitherStir, put
// `createDitherStirShader(DITHER_PARAMS).shader` first in this array and call initDitherStir().
const DITHER_SHADERS = [
  { setup: setupDither, render: renderDither, params: DITHER_PARAMS, manifest: ditherManifest },
];

function HeroAsset() {
  return h(
    ShaderEffect,
    { shaders: DITHER_SHADERS, width: 1000, height: 950, className: "hero-asset__canvas" },
    h(
      "div",
      { className: "hero-asset__inner" },
      h("div", { className: "grad grad--bottom" }),
      h("img", {
        className: "hero-asset__face",
        src: "/assets/face.webp",
        alt: "",
        width: 482,
        height: 647,
      }),
      h("div", { className: "grad grad--top" }),
      h("div", { className: "grad grad--radial" }),
    ),
  );
}

const heroAsset = document.getElementById("hero-asset");
if (heroAsset) {
  // Replaces the static fallback markup. If WebGPU / HTML-in-Canvas are unavailable,
  // ShaderEffect renders its children as ordinary DOM, so the page looks the same minus the dither.
  createRoot(heroAsset).render(h(HeroAsset));
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
