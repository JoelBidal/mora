/**
 * Figma "Glass" effect for the bubbles.
 *
 * Figma params (read from the file via the Plugin API):
 *   lg → radius (frost) 3, refraction 1,    depth 27, dispersion 0.34, light 0.8 @ -45°
 *   sm → radius (frost) 4, refraction 0.48, depth 20, dispersion 0.42, light 0.8 @ -45°
 *
 * Implementation: one SVG filter per bubble size, used as `backdrop-filter: url(#…)`:
 *   frost      → feGaussianBlur on the backdrop
 *   refraction → feDisplacementMap driven by a generated lens map (bends the rim, `depth` px wide)
 *   dispersion → R / G / B displaced by slightly different amounts, recombined (chromatic aberration)
 *   light      → rim highlight drawn in CSS (::after), angle/intensity via custom properties
 *
 * SVG filters in `backdrop-filter` are Chromium-only; other browsers keep the CSS fallback
 * (a plain frosted blur defined in styles.css).
 */

export const GLASS_PRESETS = {
  lg: { frost: 3, refraction: 1, depth: 27, dispersion: 0.34, lightIntensity: 0.8, lightAngle: -45 },
  sm: { frost: 4, refraction: 0.48, depth: 20, dispersion: 0.42, lightIntensity: 0.8, lightAngle: -45 },
};

const SVG_NS = "http://www.w3.org/2000/svg";

function supportsSvgBackdrop() {
  const brands = navigator.userAgentData?.brands ?? [];
  if (brands.some((b) => /Chromium/i.test(b.brand))) return true;
  // Fallback UA sniff for Chromium builds without userAgentData.
  return /Chrome\/\d+/.test(navigator.userAgent) && !/Firefox|FxiOS/.test(navigator.userAgent);
}

/**
 * Lens displacement map: neutral (128,128) in the flat centre, bending inward across the
 * outer `depth` px following a circular profile — like light passing through a rounded rim.
 */
function createLensMap(size, depth) {
  const res = Math.max(32, Math.round(size * 2));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(res, res);
  const band = Math.min(depth / (size / 2), 1);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const nx = ((x + 0.5) / res) * 2 - 1;
      const ny = ((y + 0.5) / res) * 2 - 1;
      const r = Math.hypot(nx, ny);
      let dx = 0;
      let dy = 0;
      if (r > 0 && r <= 1) {
        const t = Math.min(Math.max((r - (1 - band)) / band, 0), 1);
        const profile = 1 - Math.sqrt(1 - t * t);
        // Sample towards the centre so the rim magnifies what's under the bubble.
        dx = -(nx / r) * profile;
        dy = -(ny / r) * profile;
      }
      const i = (y * res + x) * 4;
      img.data[i] = Math.round(128 + 127 * dx);
      img.data[i + 1] = Math.round(128 + 127 * dy);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function createGlassFilter(id, size, p) {
  const filter = el("filter", {
    id,
    x: 0,
    y: 0,
    width: size,
    height: size,
    filterUnits: "userSpaceOnUse",
    primitiveUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  });

  // Figma's blur radius ≈ 2σ.
  filter.append(el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: p.frost / 2, result: "frost" }));
  filter.append(
    el("feImage", {
      href: createLensMap(size, p.depth),
      x: 0,
      y: 0,
      width: size,
      height: size,
      preserveAspectRatio: "none",
      result: "lens",
    }),
  );

  // Max rim offset = scale / 2 → half the radius at refraction 1.
  const base = p.refraction * size * 0.5;
  const spread = p.dispersion * 0.3;
  const channels = [
    { name: "r", scale: base * (1 + spread), matrix: "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" },
    { name: "g", scale: base, matrix: "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" },
    { name: "b", scale: base * (1 - spread), matrix: "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" },
  ];

  for (const c of channels) {
    filter.append(
      el("feDisplacementMap", {
        in: "frost",
        in2: "lens",
        scale: c.scale.toFixed(2),
        xChannelSelector: "R",
        yChannelSelector: "G",
        result: `d${c.name}`,
      }),
      el("feColorMatrix", { in: `d${c.name}`, type: "matrix", values: c.matrix, result: c.name }),
    );
  }

  filter.append(
    el("feBlend", { in: "r", in2: "g", mode: "screen", result: "rg" }),
    el("feBlend", { in: "rg", in2: "b", mode: "screen" }),
  );
  return filter;
}

/* ---------- Shared filter cache (bubbles are created and destroyed at runtime) ---------- */

export const svgGlassSupported = supportsSvgBackdrop();

let defs = null;
const filterIds = new Map(); // "preset:size" → filter id

function ensureDefs() {
  if (defs) return defs;
  const svg = el("svg", { width: 0, height: 0, "aria-hidden": "true" });
  svg.style.position = "absolute";
  defs = el("defs");
  svg.append(defs);
  document.body.append(svg);
  return defs;
}

/** One filter per preset + pixel size, created on first use and reused by every bubble. */
function glassFilterId(size, presetName) {
  const key = `${presetName}:${size}`;
  let id = filterIds.get(key);
  if (!id) {
    id = `glass-${presetName}-${size}`;
    ensureDefs().append(createGlassFilter(id, size, GLASS_PRESETS[presetName] ?? GLASS_PRESETS.lg));
    filterIds.set(key, id);
  }
  return id;
}

/**
 * Applies the glass look to one bubble element.
 * @param {HTMLElement} bubble
 * @param {number} size  bubble diameter in px (the filter is built for exactly this size)
 * @param {string} presetName  "lg" | "sm"
 * @param {{svg?: boolean}} [opts]  svg=false forces the plain CSS frost fallback
 */
export function applyGlass(bubble, size, presetName = "lg", { svg = svgGlassSupported } = {}) {
  const p = GLASS_PRESETS[presetName] ?? GLASS_PRESETS.lg;
  // Light highlight is pure CSS, so it applies in every browser.
  bubble.style.setProperty("--glass-light", p.lightIntensity);
  // Figma -45° = light from the top-left; CSS gradient angle points to where it ends.
  bubble.style.setProperty("--glass-light-angle", `${180 + p.lightAngle}deg`);

  if (svg) {
    bubble.style.backdropFilter = `url(#${glassFilterId(Math.round(size), presetName)})`;
    bubble.classList.add("bubble--svg-glass");
  } else {
    bubble.style.backdropFilter = ""; // back to the CSS frost fallback
    bubble.classList.remove("bubble--svg-glass");
  }
}

/** Static bubbles (e.g. reduced motion): apply glass to the existing markup. */
export function initGlass(bubbles) {
  for (const bubble of bubbles) applyGlass(bubble, bubble.offsetWidth, bubble.dataset.glass);
}
