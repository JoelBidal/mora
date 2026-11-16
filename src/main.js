/**
 * Mora landing — entry point.
 *
 * The page is plain HTML/CSS. Two progressive enhancements are mounted here:
 *  1. The hero asset (face + gradients) is wrapped in Figma's Dither ShaderEffect
 *     (`@figma/expressive-components`, a React component → mounted as a small React island).
 *  2. The bubbles get Figma's Glass effect (see ./glass.js).
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

/* ---------- 1. Dither shader on the hero asset ---------- */

// Params exactly as authored in Figma (node 3710:131). Module-scope → stable reference.
const DITHER_SHADERS = [
  {
    setup: setupDither,
    render: renderDither,
    params: {
      algorithm: "Bayer 16x16",
      monoColor: { r: 1, g: 1, b: 1, a: 1 },
      contrast: 1,
      levels: 6,
      mono: false,
      brightness: 101,
      pixelSize: 1,
    },
    manifest: ditherManifest,
  },
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
        src: "/assets/face.png",
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

/* ---------- 2. Glass effect on the bubbles ---------- */

initGlass(document.querySelectorAll(".bubble[data-glass]"));
