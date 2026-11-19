/**
 * Hero dither — Figma's Dither shader on the hero artwork, WITHOUT HTML-in-Canvas.
 *
 * `ShaderEffect` normally rasterises its DOM children through HTML-in-Canvas, an experimental
 * API that is off by default in browsers (only on behind chrome://flags). Our hero artwork is
 * just a photo + three white gradients, so instead we:
 *   1. compose that artwork on a 2D canvas, reading positions/sizes from the static markup,
 *   2. upload it to WebGPU with a tiny "image source" shader,
 *   3. chain Figma's Dither module (unchanged) after it, in a child-less ShaderEffect.
 * Child-less ShaderEffect only needs WebGPU (Chrome/Edge, Safari 26+, Firefox on Windows…).
 *
 * The static markup (.hero-asset__inner) always stays underneath: without WebGPU it is what
 * people see; with WebGPU the opaque dithered canvas covers it.
 */
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { ShaderEffect } from "@figma/expressive-components";
import {
  setup as setupDither,
  render as renderDither,
  manifest as ditherManifest,
} from "./lib/custom-effects/CodeComponentId_55a4ca852373c81b69803326c5af7aa5f1af580b_412";

const WHITE = (a) => `rgba(255, 255, 255, ${a})`;

// Gradient stops — mirror .grad--bottom / .grad--top in styles.css.
const BOTTOM_STOPS = [
  [0.10547, WHITE(0)],
  [0.55273, WHITE(0.25)],
  [0.86582, WHITE(0.5)],
];
const TOP_STOPS_FROM_BOTTOM = [
  [0.5, WHITE(0)],
  [1, WHITE(0.15)],
];

function loadImage(src) {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img.decode().then(() => img);
}

/**
 * Draws the hero artwork exactly as the static markup lays it out, over the card's white.
 * @param {HTMLElement} inner  .hero-asset__inner (positions are read from its children)
 * @param {number} scale       device pixel ratio to render at
 */
async function composeArtwork(inner, scale) {
  const W = inner.offsetWidth;
  const H = inner.offsetHeight;
  const face = inner.querySelector(".hero-asset__face");
  const bottom = inner.querySelector(".grad--bottom");
  const top = inner.querySelector(".grad--top");
  const radial = inner.querySelector(".grad--radial");
  const radialUrl = /url\("?(.*?)"?\)$/.exec(getComputedStyle(radial).backgroundImage)?.[1];

  const [faceImg, radialImg] = await Promise.all([
    loadImage(face.currentSrc || face.src),
    radialUrl ? loadImage(radialUrl) : null,
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = "high";

  // The card behind the artwork is white; compositing onto it makes the input opaque.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  const box = (el) => [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight];

  // 1. Bottom gradient (top → bottom)
  {
    const [x, y, w, hh] = box(bottom);
    const g = ctx.createLinearGradient(0, y, 0, y + hh);
    BOTTOM_STOPS.forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, hh);
  }
  // 2. Face (stretched to its box, like object-fit: fill)
  ctx.drawImage(faceImg, ...box(face));
  // 3. Top gradient (bottom → top)
  {
    const [x, y, w, hh] = box(top);
    const g = ctx.createLinearGradient(0, y + hh, 0, y);
    TOP_STOPS_FROM_BOTTOM.forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, hh);
  }
  // 4. Radial gradient (the same SVG the CSS uses)
  if (radialImg) ctx.drawImage(radialImg, ...box(radial));

  return createImageBitmap(canvas);
}

/** First shader in the chain: draws the composed artwork into the effect pipeline. */
function createImageSourceShader(bitmap) {
  const WGSL = /* wgsl */ `
    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var tex: texture_2d<f32>;
    struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
    @vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
      var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
      var o: VsOut;
      o.pos = vec4f(p[i], 0.0, 1.0);
      o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
      return o;
    }
    @fragment fn fs(in: VsOut) -> @location(0) vec4f {
      return textureSampleLevel(tex, samp, in.uv, 0.0);
    }
  `;

  return {
    params: {},
    manifest: { version: 2, name: "Image source", isAnimated: false, usesMouse: false },
    setup(device, frame) {
      const s = frame.state;
      s.texture = device.createTexture({
        size: [bitmap.width, bitmap.height, 1],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: s.texture, premultipliedAlpha: true },
        [bitmap.width, bitmap.height],
      );
      s.module = device.createShaderModule({ code: WGSL });
      s.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    },
    render(device, frame) {
      const { output, state: s } = frame;
      if (!output) return;
      if (!s.pipeline || s.format !== output.format) {
        s.pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module: s.module, entryPoint: "vs" },
          fragment: { module: s.module, entryPoint: "fs", targets: [{ format: output.format }] },
          primitive: { topology: "triangle-list" },
        });
        s.format = output.format;
        s.bindGroup = device.createBindGroup({
          layout: s.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: s.sampler },
            { binding: 1, resource: s.texture.createView() },
          ],
        });
      }
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: output.createView(), loadOp: "clear", clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: "store" }],
      });
      pass.setPipeline(s.pipeline);
      pass.setBindGroup(0, s.bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
  };
}

/**
 * Mounts the dithered hero canvas over the static artwork.
 * @param {HTMLElement} container  element that receives the canvas (.hero-asset__dither)
 * @param {HTMLElement} inner      the static artwork (.hero-asset__inner)
 * @param {object} ditherParams    params for Figma's Dither shader
 */
export async function mountHeroDither(container, inner, ditherParams) {
  if (!navigator.gpu) return; // no WebGPU: the static artwork stays as is

  try {
    // The photo has no detail beyond 2× (735px source shown at 482px); the dither grid itself
    // is still generated at the canvas' full device resolution by the shader.
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const bitmap = await composeArtwork(inner, scale);
    const shaders = [
      createImageSourceShader(bitmap),
      { setup: setupDither, render: renderDither, params: ditherParams, manifest: ditherManifest },
    ];
    // Child-less ShaderEffect → WebGPU only, no HTML-in-Canvas. If WebGPU fails at runtime
    // it renders nothing, and the static artwork underneath remains visible.
    createRoot(container).render(
      h(ShaderEffect, { shaders, width: inner.offsetWidth, height: inner.offsetHeight, className: "hero-asset__canvas" }),
    );
  } catch (e) {
    console.warn("Hero dither unavailable, showing the static artwork", e);
  }
}
