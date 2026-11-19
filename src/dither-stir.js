/**
 * Hero "dither stir" — the cursor rearranges the dither dots without touching the image.
 *
 * Runs right *before* Figma's Dither shader. Near the cursor it adds a tiny, zero-mean,
 * time-varying noise to the image — smaller than one quantisation step. The photo is not
 * displaced or deformed at all (and the average tone is unchanged), but dots sitting near a
 * threshold flip on and off, so the dither pattern shimmers and reshuffles around the cursor.
 * When the cursor stops, the effect fades out and a final clean paint restores the exact
 * original pattern.
 *
 * GPU side (this shader, in the ShaderEffect chain):
 *   1. energy pass — low-res field, ping-ponged each paint:
 *                    energy = previous · decay + cursorSpeed · gaussian(cursor)
 *   2. stir pass   — output = input + noise(dither cell, seed) · energy · step
 * JS side (initDitherStir): tracks the pointer, writes the uniforms into the shared `params`
 * object and requests paints only while there is energy left — zero cost when idle.
 */

const FIELD_SCALE = 0.25; // energy field resolution relative to the canvas

const WGSL = /* wgsl */ `
struct U {
  mouse: vec2f,     // cursor, uv
  speed: f32,       // cursor speed impulse for this paint
  aspect: f32,      // width / height (keeps the brush round)
  radius: f32,      // brush radius, in uv of height
  decay: f32,       // energy retention for this paint (0 = clear)
  amount: f32,      // noise amplitude, in quantisation steps
  step: f32,        // one quantisation step: 1 / (levels − 1)
  cell: f32,        // dither cell size in texture px (pixelSize)
  seed: f32,        // changes ~20×/s so the dots reshuffle
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}

// Pass 1: decay the previous energy and add the cursor's motion.
@fragment fn energy(in: VsOut) -> @location(0) vec4f {
  let prev = textureSampleLevel(src, samp, in.uv, 0.0).r;
  let d = (in.uv - u.mouse) * vec2f(u.aspect, 1.0);
  let brush = exp(-dot(d, d) / (u.radius * u.radius));
  let e = clamp(prev * u.decay + u.speed * brush, 0.0, 1.0);
  return vec4f(e, 0.0, 0.0, 1.0);
}

// PCG3D hash → [0, 1)
fn hash(p: vec3u) -> f32 {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return f32(v.x) / 4294967296.0;
}

@group(0) @binding(3) var energyTex: texture_2d<f32>;

// Pass 2: nudge each dither cell by a zero-mean amount (no geometric change at all).
@fragment fn stir(in: VsOut) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, in.uv, 0.0);
  let e = textureSampleLevel(energyTex, samp, in.uv, 0.0).r;
  if (e < 0.002) { return c; }
  let cellId = vec2u(floor(in.pos.xy / u.cell));
  let n = hash(vec3u(cellId, u32(u.seed))) * 2.0 - 1.0;
  // Premultiplied colour: scale the nudge by alpha and keep rgb ≤ alpha.
  let delta = n * u.amount * u.step * e * c.a;
  return vec4f(clamp(c.rgb + vec3f(delta), vec3f(0.0), vec3f(c.a)), c.a);
}
`;

/**
 * @param {{levels:number, pixelSize:number}} dither  the Dither shader's params (step & cell size)
 */
export function createDitherStirShader(dither) {
  // Shared with the JS controller; the runtime passes this same object to render().
  const params = {
    mouse: [0.5, 0.5],
    speed: 0,
    decay: 1,
    radius: 0.09,
    amount: 0.9, // < 1 step: only dots near a threshold flip
    seed: 0,
  };

  function setup(device, frame) {
    const s = frame.state;
    s.module = device.createShaderModule({ code: WGSL });
    s.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    s.ubuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    s.energyPipe = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: s.module, entryPoint: "vs" },
      fragment: { module: s.module, entryPoint: "energy", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    });
    s.field = [];
    s.fieldIndex = 0;
  }

  function ensureTargets(device, s, input, outFormat) {
    const w = Math.max(8, Math.round(input.width * FIELD_SCALE));
    const h = Math.max(8, Math.round(input.height * FIELD_SCALE));
    if (!s.field.length || s.field[0].width !== w || s.field[0].height !== h) {
      s.field.forEach((t) => t.destroy());
      s.field = [0, 1].map(() =>
        device.createTexture({
          size: [w, h, 1],
          format: "rgba16float",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      );
    }
    if (!s.stirPipe || s.stirFormat !== outFormat) {
      s.stirPipe = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: s.module, entryPoint: "vs" },
        fragment: { module: s.module, entryPoint: "stir", targets: [{ format: outFormat }] },
        primitive: { topology: "triangle-list" },
      });
      s.stirFormat = outFormat;
    }
  }

  function render(device, frame) {
    const { input, output, state: s } = frame;
    if (!input || !output) return;
    ensureTargets(device, s, input, output.format);

    const levels = Math.max(2, dither.levels);
    device.queue.writeBuffer(
      s.ubuf,
      0,
      new Float32Array([
        params.mouse[0], params.mouse[1],
        params.speed, input.width / input.height,
        params.radius, params.decay,
        params.amount, 1 / (levels - 1),
        // The dither samples one value per pixelSize block of the texture.
        Math.max(1, dither.pixelSize), params.seed,
        0, 0,
      ]),
    );
    // Speed is an impulse: consume it so repeated paints don't re-apply it.
    params.speed = 0;

    const prev = s.field[s.fieldIndex];
    const next = s.field[1 - s.fieldIndex];
    s.fieldIndex = 1 - s.fieldIndex;

    const enc = device.createCommandEncoder();

    const energyPass = enc.beginRenderPass({
      colorAttachments: [{ view: next.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
    });
    energyPass.setPipeline(s.energyPipe);
    energyPass.setBindGroup(0, device.createBindGroup({
      layout: s.energyPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: s.ubuf } },
        { binding: 1, resource: s.sampler },
        { binding: 2, resource: prev.createView() },
      ],
    }));
    energyPass.draw(3);
    energyPass.end();

    const stirPass = enc.beginRenderPass({
      colorAttachments: [{ view: output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
    });
    stirPass.setPipeline(s.stirPipe);
    stirPass.setBindGroup(0, device.createBindGroup({
      layout: s.stirPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: s.ubuf } },
        { binding: 1, resource: s.sampler },
        { binding: 2, resource: input.createView() },
        { binding: 3, resource: next.createView() },
      ],
    }));
    stirPass.draw(3);
    stirPass.end();

    device.queue.submit([enc.finish()]);
  }

  return {
    shader: {
      setup,
      render,
      params,
      // Paints are requested by initDitherStir only while there is energy, so neither the
      // runtime's continuous clock nor its window-wide mouse listeners are needed.
      manifest: { version: 2, name: "Dither stir", isAnimated: false, usesMouse: false },
    },
    params,
  };
}

/**
 * Drives the effect from the pointer.
 * @param {HTMLElement} area   element whose pointer movement feeds the effect (the hero card)
 * @param {object} params      the `params` object returned by createDitherStirShader()
 * @param {() => HTMLCanvasElement | null} getCanvas  the ShaderEffect canvas (mounted async)
 */
export function initDitherStir(area, params, getCanvas) {
  const TAU_S = 0.7; // seconds for the stir to fall to ~37%
  const GAIN = 9; // uv per frame → energy
  const RESHUFFLE_HZ = 18; // how often the dots pick new positions

  let pointer = null; // latest pointer uv
  let lastUv = null; // pointer uv at the previous frame
  let energy = 0; // rough upper bound of the remaining energy
  let raf = 0;
  let lastT = 0;

  function toUv(e) {
    const canvas = getCanvas();
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  function tick(now) {
    raf = 0;
    const canvas = getCanvas();
    if (!canvas || typeof canvas.requestPaint !== "function") return;
    const dt = lastT ? Math.min((now - lastT) / 1000, 1 / 20) : 1 / 60;
    lastT = now;

    const decay = Math.exp(-dt / TAU_S);
    params.decay = decay;
    params.seed = Math.floor((now / 1000) * RESHUFFLE_HZ) % 65536;
    energy *= decay;

    if (pointer) {
      params.mouse[0] = pointer[0];
      params.mouse[1] = pointer[1];
      if (lastUv) {
        const impulse = Math.min(Math.hypot(pointer[0] - lastUv[0], pointer[1] - lastUv[1]) * GAIN, 0.6);
        params.speed += impulse;
        energy = Math.min(energy + impulse, 1);
      }
      lastUv = pointer;
    }

    if (energy > 0.01) {
      canvas.requestPaint();
      raf = requestAnimationFrame(tick);
    } else {
      // Final clean paint: clear the field so the original dither pattern returns exactly.
      params.decay = 0;
      params.speed = 0;
      energy = 0;
      lastT = 0;
      canvas.requestPaint();
    }
  }

  area.addEventListener("pointermove", (e) => {
    pointer = toUv(e);
    if (!raf) raf = requestAnimationFrame(tick);
  });
  area.addEventListener("pointerleave", () => {
    pointer = null;
    lastUv = null;
  });
}
