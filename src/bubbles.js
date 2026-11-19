/**
 * Hero bubbles — a small physics simulation.
 *
 * Every bubble is an entity updated each frame (no canned CSS keyframes):
 *  - Buoyancy vs drag: accelerates from rest towards a size-dependent terminal velocity.
 *  - Path: a gentle sway plus a slow drift keeps every path unique; small ones rise straight.
 *  - Shape: a hint of oblateness, a very subtle volume-preserving wobble, a tiny tilt
 *    towards the direction of travel, and a little expansion as they rise.
 *  - Bubbles push each other apart, and the cursor drags the air around them.
 *  - Life cycle: nucleate under the face, fade in, rise, dissolve near the top.
 *  - Popping is a hidden, click-only interaction: the film ruptures where it was clicked,
 *    the hole sweeps across the bubble in a few tens of ms, and the retracting rim sheds
 *    droplets that fly off and fall.
 *
 * Coordinates are in the hero artwork space (the 1000×950 `.bubbles` box).
 */
import { applyGlass, svgGlassSupported } from "./glass.js";

const ART_WIDTH = 1000;

const CONFIG = {
  maxLive: 9,
  speed: 0.7, // global rise-speed factor
  spawnEvery: [1.1, 2.0], // s
  spawnX: [350, 650], // over the face
  spawnY: [700, 770], // under the chin, fading in while rising
  fadeInDistance: 110, // px of rise to become fully visible
  walls: [300, 700], // soft horizontal bounds
  // They dissolve by position (they only pop when clicked): from the top of the head…
  fadeStart: [120, 150],
  // …to the white band under the nav, where they are fully gone.
  fadeEnd: [70, 90],
  gravity: 980, // px/s² for droplets
};

// [diameter px, weight]. Largest is 63px (30% under the original 90px).
const SIZES = [
  [14, 2], [18, 2], [24, 2], [30, 2], [40, 3], [48, 3], [56, 2], [63, 2],
];

// Labels (rendered uppercase). Two lines only fit comfortably from 56px up; smaller
// bubbles get a single short word so the text never crowds the rim.
const LABEL_TWO_LINE_MIN = 56;
const LABELS = {
  large: [
    ["01", "base"], ["02", "serum"], ["03", "care"], ["++++", "pa"], ["uv", "a+b"], ["50", "spf"],
    ["30", "spf"], ["ha", "1.5%"], ["vit", "c"], ["b3", "10%"], ["zinc"], ["spf", "15"],
  ],
  small: [["ha"], ["b3"], ["b5"], ["spf"], ["uv"], ["pa"]],
};

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const weighted = (items) => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[items.length - 1][0];
};

/* ---------------------------------------------------------------------------------------- */

class Bubble {
  constructor(sim, { el, x, y, size, label, fadeIn, hold = 0 }) {
    this.sim = sim;
    this.hold = hold; // seconds floating in place before starting to rise
    this.size = size;
    this.label = label;
    this.x = x;
    this.y = y;
    this.startY = y;
    this.vx = 0;
    this.vy = 0;
    this.fx = 0;
    this.fy = 0;
    this.age = 0;
    this.alpha = fadeIn ? 0 : 1;
    this.fadeIn = fadeIn;
    this.state = "alive"; // alive → (fading | rupturing) → dead

    const sizeK = Math.min(size / 63, 1);
    // Terminal velocity grows with size (and a little randomness so they don't move in lockstep).
    this.vt = (22 + 6 * Math.sqrt(size)) * CONFIG.speed * rand(0.9, 1.1);
    this.tau = rand(0.7, 1.1); // time constant to reach terminal velocity
    // Gentle sway rather than a zig-zag; small bubbles rise almost straight.
    this.zig = {
      amp: (size < 26 ? 0.02 : rand(0.03, 0.06)) * size + rand(0.5, 1.5),
      freq: rand(0.25, 0.4),
      phase: rand(0, TAU),
    };
    this.drift = [
      { amp: rand(3, 8), freq: rand(0.04, 0.09), phase: rand(0, TAU) },
      { amp: rand(1, 3), freq: rand(0.12, 0.2), phase: rand(0, TAU) },
    ];
    // Subtle surface wobble (volume preserving) + a hint of oblateness while rising.
    this.wobble = {
      omega: TAU * rand(1.2, 1.8) * (40 / size) ** 0.3,
      amp: 0.004 + 0.008 * sizeK,
      phase: rand(0, TAU),
    };
    this.oblate = 0.01 * sizeK;

    // They never pop on their own: they dissolve near the top (popping is a click-only reward).
    this.fadeStartY = rand(...CONFIG.fadeStart);
    this.fadeEndY = rand(...CONFIG.fadeEnd);
    // Bubbles that start high (the initial composition) still travel a bit before fading.
    if (this.fadeStartY > y - 30) this.fadeStartY = y - 30;
    this.fadeEndY = Math.min(this.fadeEndY, this.fadeStartY - 45);
    this.fadeP = 0;

    this.el = el ?? sim.createElement(size, label);
    this.el.classList.add("bubble--live");
    this.el.style.left = "0";
    this.el.style.top = "0";
    this.el.style.zIndex = String(Math.round(rand(1, 20)));
    this.labelEl = this.el.querySelector(".bubble__label");
    if (!this.el.querySelector(".bubble__film")) {
      const film = document.createElement("span");
      film.className = "bubble__film";
      film.style.setProperty("--film-dur", `${rand(7, 13).toFixed(1)}s`);
      film.style.setProperty("--film-from", `${Math.round(rand(0, 360))}deg`);
      this.el.prepend(film);
    }
    this.preset = size < 26 ? "sm" : "lg";
    applyGlass(this.el, size, this.preset, { svg: sim.svgGlass });
    this.el.__bubble = this;
  }

  get growth() {
    // Lower hydrostatic pressure near the top → the bubble expands slightly.
    return 1 + 0.06 * clamp((this.startY - this.y) / 500, 0, 1);
  }

  update(dt) {
    this.age += dt;
    const t = this.age;

    // Initial composition: hover in place (only the surface wobbles) before rising.
    if (this.hold > 0 && this.state === "alive") {
      this.hold -= dt;
      return;
    }

    if (this.state === "rupturing") {
      this.ruptureT += dt;
      this.sim.emitRimDroplets(this, dt);
      if (this.ruptureT >= this.ruptureDur) this.die();
      return;
    }

    // Lateral velocity the path "wants" (derivative of zig-zag + drift).
    let pathVx = this.zig.amp * TAU * this.zig.freq * Math.cos(TAU * this.zig.freq * t + this.zig.phase);
    for (const d of this.drift) pathVx += d.amp * TAU * d.freq * Math.cos(TAU * d.freq * t + d.phase);
    // Path speed ramps up with the rise speed (a bubble at rest doesn't zig-zag).
    pathVx *= clamp(-this.vy / this.vt, 0, 1);

    this.vx += (pathVx - this.vx) * Math.min(1, dt * 4) + this.fx * dt;
    this.vy += (-this.vt - this.vy) * (1 - Math.exp(-dt / this.tau)) + this.fy * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.fadeIn && this.state === "alive") {
      this.alpha = smoothstep(0, CONFIG.fadeInDistance, this.startY - this.y);
    }

    // Dissolve by height: from the top of the head up into the white band under the nav.
    if (this.state === "alive" && this.y <= this.fadeStartY) this.state = "fading";
    if (this.state === "fading") {
      this.fadeP = clamp((this.fadeStartY - this.y) / (this.fadeStartY - this.fadeEndY), 0, 1);
      this.alpha = 1 - smoothstep(0, 1, this.fadeP);
      if (this.fadeP >= 1) this.die();
    }
  }

  render() {
    const s = this.size;
    const rupturing = this.state === "rupturing";
    const wob = rupturing ? 0 : Math.sin(this.wobble.omega * this.age + this.wobble.phase) * this.wobble.amp;
    const fadeShrink = this.state === "fading" ? 1 - 0.08 * smoothstep(0, 1, this.fadeP) : 1;
    const g = this.growth * fadeShrink;
    const sx = (1 + this.oblate + wob) * g;
    const sy = (1 - this.oblate - wob) * g;
    // Lean very slightly into the direction of travel.
    const tilt = clamp(Math.atan2(this.vx, Math.max(-this.vy, 1)) * 0.3, -0.05, 0.05);

    this.el.style.transform =
      `translate3d(${(this.x - s / 2).toFixed(2)}px, ${(this.y - s / 2).toFixed(2)}px, 0) ` +
      `rotate(${tilt.toFixed(4)}rad) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    this.el.style.opacity = this.alpha.toFixed(3);

    if (rupturing) {
      // The hole opens at the rupture point and sweeps across the film. clip-path (not mask)
      // because Chrome doesn't mask the backdrop-filter output; evenodd cuts the circle out.
      const p = clamp(this.ruptureT / this.ruptureDur, 0, 1);
      const h = Math.max((p * p * 0.6 + p * 0.4) * s * 1.05, 0.01);
      const { rx, ry } = this;
      const pad = s; // outer rect larger than the bubble so the rim highlight isn't clipped
      this.el.style.clipPath =
        `path(evenodd, "M${-pad} ${-pad}H${s + pad}V${s + pad}H${-pad}Z ` +
        `M${(rx - h).toFixed(2)} ${ry.toFixed(2)}a${h.toFixed(2)} ${h.toFixed(2)} 0 1 0 ${(2 * h).toFixed(2)} 0` +
        `a${h.toFixed(2)} ${h.toFixed(2)} 0 1 0 ${(-2 * h).toFixed(2)} 0Z")`;
    }
  }

  /**
   * Bursts the bubble (only ever triggered by a click / tap).
   * @param {{x:number,y:number}} at rupture point in the bubble's local px (0..size)
   */
  pop(at) {
    if (this.state === "rupturing" || this.state === "dead") return;
    const r = this.size / 2;
    this.state = "rupturing";
    this.ruptureT = 0;
    this.ruptureDur = 0.045 + this.size * 0.00045; // ~50–90 ms
    this.rx = at.x;
    this.ry = at.y;
    this.rupAngle = Math.atan2(at.y - r, at.x - r);
    this.dropsLeft = Math.round(5 + this.size / 8);
    this.dropRate = this.dropsLeft / this.ruptureDur; // shed evenly while the hole sweeps
    this.dropAcc = 0;
    this.alpha = Math.max(this.alpha, 0.6);
    this.el.classList.add("bubble--popping");
    if (this.labelEl) this.labelEl.style.opacity = "0";
    this.sim.flashRing(this);
  }

  die() {
    this.state = "dead";
    this.el.remove();
  }
}

/* ---------------------------------------------------------------------------------------- */

class Particle {
  constructor(container, { kind, x, y, vx = 0, vy = 0, size, life }) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.size = size;
    this.life = life;
    this.t = 0;
    this.el = document.createElement("span");
    this.el.className = kind === "ring" ? "bubble-ring" : "bubble-drop";
    this.el.style.width = this.el.style.height = `${size}px`;
    container.append(this.el);
  }

  update(dt) {
    this.t += dt;
    if (this.kind === "drop") {
      const drag = Math.exp(-dt * 2.2);
      this.vx *= drag;
      this.vy = this.vy * drag + CONFIG.gravity * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
    }
    return this.t < this.life;
  }

  render() {
    const p = clamp(this.t / this.life, 0, 1);
    if (this.kind === "ring") {
      // Brief flash of the outline as the film snaps away.
      const scale = 1 + 0.2 * (1 - (1 - p) ** 3);
      this.el.style.transform = `translate3d(${this.x - this.size / 2}px, ${this.y - this.size / 2}px, 0) scale(${scale.toFixed(3)})`;
      this.el.style.opacity = (0.55 * (1 - p) ** 2).toFixed(3);
    } else {
      const s = 1 - 0.4 * p;
      this.el.style.transform = `translate3d(${(this.x - this.size / 2).toFixed(2)}px, ${(this.y - this.size / 2).toFixed(2)}px, 0) scale(${s.toFixed(3)})`;
      this.el.style.opacity = (0.75 * (1 - p) ** 1.5).toFixed(3);
    }
  }
}

/* ---------------------------------------------------------------------------------------- */

class BubbleSim {
  constructor(container) {
    this.container = container;
    this.bubbles = [];
    this.particles = [];
    this.spawnT = rand(0.6, 1.2);
    this.svgGlass = svgGlassSupported;
    this.pointer = null;
    this.running = false;
    this.visible = true;
    this.frameMs = 16;
    this.slowFor = 0;
    this.timeScale = 1; // 1 = real time (lower values give slow motion, handy for debugging)
    this.loop = this.loop.bind(this);
    container.__bubbleSim = this;

    this.adoptExisting();
    this.bindEvents();
  }

  /* ----- creation ----- */

  /** The Figma composition is the starting state: those bubbles start rising from where they are. */
  adoptExisting() {
    for (const el of this.container.querySelectorAll(".bubble")) {
      const size = parseFloat(el.style.getPropertyValue("--s"));
      const left = parseFloat(el.style.getPropertyValue("--x"));
      const top = parseFloat(el.style.getPropertyValue("--y"));
      const labelEl = el.querySelector(".bubble__label");
      const label = labelEl ? labelEl.innerHTML.split(/<br\s*\/?>/i).map((s) => s.trim()) : null;
      el.style.removeProperty("--x");
      el.style.removeProperty("--y");
      this.bubbles.push(
        new Bubble(this, { el, x: left + size / 2, y: top + size / 2, size, label, fadeIn: false, hold: rand(0.8, 2) }),
      );
    }
  }

  createElement(size, label) {
    const el = document.createElement("span");
    el.className = "bubble";
    if (size >= 40) el.classList.add("bubble--glow");
    else if (size >= 26) el.classList.add("bubble--glow", "bubble--glow-sm");
    el.dataset.glass = size < 26 ? "sm" : "lg";
    el.style.setProperty("--s", `${size}px`);
    if (label) {
      const span = document.createElement("span");
      span.className = "bubble__label";
      label.forEach((line, i) => {
        if (i) span.append(document.createElement("br"));
        span.append(line);
      });
      el.append(span);
    }
    this.container.append(el);
    return el;
  }

  pickLabel(size) {
    if (size < 40 || Math.random() < 0.22) return null; // small or "empty" bubbles
    const pool = size >= LABEL_TWO_LINE_MIN ? LABELS.large : LABELS.small;
    // Avoid repeats on screen, including the same keyword ("b3" vs "b3 10%", "spf" vs "50 spf").
    const words = (l) => (l ?? []).filter((w) => /[a-z]/.test(w));
    const inUse = new Set(this.bubbles.flatMap((b) => words(b.label)));
    const free = pool.filter((l) => !words(l).some((w) => inUse.has(w)));
    const list = free.length ? free : pool;
    return list[Math.floor(Math.random() * list.length)];
  }

  spawn() {
    const size = weighted(SIZES);
    const y = rand(...CONFIG.spawnY);
    // Pick the spawn x farthest from bubbles that are still near the bottom.
    let best = null;
    for (let i = 0; i < 8; i++) {
      const x = rand(CONFIG.spawnX[0] + size / 2, CONFIG.spawnX[1] - size / 2);
      let minD = Infinity;
      for (const b of this.bubbles) {
        if (b.y < 520) continue;
        minD = Math.min(minD, Math.hypot(b.x - x, b.y - y) - b.size / 2 - size / 2);
      }
      if (!best || minD > best.minD) best = { x, minD };
    }
    this.bubbles.push(new Bubble(this, { x: best.x, y, size, label: this.pickLabel(size), fadeIn: true }));
  }

  flashRing(b) {
    const size = b.size * b.growth;
    this.particles.push(new Particle(this.container, { kind: "ring", x: b.x, y: b.y, size, life: 0.16 }));
  }

  /** Droplets shed by the retracting rim, flung away from the rupture point. */
  emitRimDroplets(b, dt) {
    if (b.dropsLeft <= 0) return;
    b.dropAcc += b.dropRate * dt;
    // Whatever is left goes out on the last frame of the rupture.
    const due = b.ruptureT >= b.ruptureDur ? b.dropsLeft : Math.floor(b.dropAcc);
    b.dropAcc -= due;
    const r = (b.size / 2) * b.growth;
    const speedK = (b.size / 60) ** 0.5;
    for (let i = 0; i < due && b.dropsLeft > 0; i++, b.dropsLeft--) {
      // Rim position swept so far: from the rupture side towards the far side.
      const sweep = clamp(b.ruptureT / b.ruptureDur, 0, 1) * Math.PI;
      const side = Math.random() < 0.5 ? -1 : 1;
      const a = b.rupAngle + side * (sweep * rand(0.6, 1) + rand(-0.2, 0.2));
      const px = b.x + Math.cos(a) * r;
      const py = b.y + Math.sin(a) * r;
      // Away from the rupture point + a bit outward.
      const awayX = px - (b.x + Math.cos(b.rupAngle) * r);
      const awayY = py - (b.y + Math.sin(b.rupAngle) * r);
      const len = Math.hypot(awayX, awayY) || 1;
      const sp = rand(70, 170) * speedK;
      const out = rand(15, 45);
      this.particles.push(
        new Particle(this.container, {
          kind: "drop",
          x: px,
          y: py,
          vx: (awayX / len) * sp + Math.cos(a) * out + b.vx * 0.5,
          vy: (awayY / len) * sp + Math.sin(a) * out + b.vy * 0.5 - rand(20, 60),
          size: rand(1.4, 3.2),
          life: rand(0.35, 0.7),
        }),
      );
    }
  }

  /* ----- events ----- */

  bindEvents() {
    const hero = this.container.closest(".card--hero") ?? this.container.parentElement;

    // Click / tap pops the bubble at the exact point that was touched.
    this.container.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".bubble--live");
      const b = el?.__bubble;
      if (!b || b.state !== "alive" && b.state !== "fading") return;
      const rect = el.getBoundingClientRect();
      b.pop({
        x: ((e.clientX - rect.left) / rect.width) * b.size,
        y: ((e.clientY - rect.top) / rect.height) * b.size,
      });
    });

    // The cursor drags the air around it: moving fast near a bubble nudges it.
    hero.addEventListener("pointermove", (e) => {
      const rect = this.container.getBoundingClientRect();
      const k = ART_WIDTH / rect.width;
      const x = (e.clientX - rect.left) * k;
      const y = (e.clientY - rect.top) * k;
      const now = performance.now();
      if (this.pointer && now - this.pointer.t < 100) {
        const dt = Math.max((now - this.pointer.t) / 1000, 1 / 240);
        const vx = (x - this.pointer.x) / dt;
        const vy = (y - this.pointer.y) / dt;
        this.pointer = { x, y, t: now, vx: this.pointer.vx * 0.5 + vx * 0.5, vy: this.pointer.vy * 0.5 + vy * 0.5 };
      } else {
        this.pointer = { x, y, t: now, vx: 0, vy: 0 };
      }
    });
    hero.addEventListener("pointerleave", () => (this.pointer = null));

    // Only simulate while the hero is on screen and the tab is visible.
    new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.visible ? this.start() : this.stop();
    }).observe(hero);
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.visible && this.start()));
  }

  /* ----- loop ----- */

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
  }

  loop(now) {
    if (!this.running) return;
    const frame = now - this.last;
    const dt = Math.min(frame / 1000, 1 / 30) * this.timeScale;
    this.last = now;
    this.watchPerformance(frame, dt);
    this.update(dt);
    this.render();
    requestAnimationFrame(this.loop);
  }

  update(dt) {
    // Spawning
    this.spawnT -= dt;
    const live = this.bubbles.filter((b) => b.state === "alive").length;
    if (this.spawnT <= 0) {
      if (live < CONFIG.maxLive) this.spawn();
      this.spawnT = rand(...CONFIG.spawnEvery);
    }

    // Forces
    for (const b of this.bubbles) {
      b.fx = 0;
      b.fy = 0;
      // Soft side walls keep them over the face.
      if (b.x < CONFIG.walls[0]) b.fx += (CONFIG.walls[0] - b.x) * 6;
      if (b.x > CONFIG.walls[1]) b.fx -= (b.x - CONFIG.walls[1]) * 6;
    }

    // Bubbles don't overlap: a spring pushes intersecting pairs apart.
    const active = this.bubbles.filter((b) => b.state === "alive" || b.state === "fading");
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const c = active[j];
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = (a.size * a.growth + c.size * c.growth) / 2 + 3;
        if (d < min) {
          const f = (min - d) * 22;
          const nx = dx / d;
          const ny = dy / d;
          // Lighter (smaller) bubbles get pushed more.
          const wa = c.size / (a.size + c.size);
          const wc = a.size / (a.size + c.size);
          a.fx -= nx * f * wa * 2;
          a.fy -= ny * f * wa;
          c.fx += nx * f * wc * 2;
          c.fy += ny * f * wc;
        }
      }
    }

    // Air dragged by the cursor.
    if (this.pointer) {
      const p = this.pointer;
      p.vx *= Math.exp(-dt * 6);
      p.vy *= Math.exp(-dt * 6);
      for (const b of active) {
        const reach = (b.size / 2) * b.growth + 80;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < reach) {
          const fall = (1 - d / reach) ** 2;
          b.fx += clamp(p.vx, -2500, 2500) * 2.2 * fall;
          b.fy += clamp(p.vy, -2500, 2500) * 1.4 * fall;
        }
      }
    }

    for (const b of this.bubbles) b.update(dt);
    this.bubbles = this.bubbles.filter((b) => b.state !== "dead");

    this.particles = this.particles.filter((p) => {
      const alive = p.update(dt);
      if (!alive) p.el.remove();
      return alive;
    });
  }

  render() {
    for (const b of this.bubbles) b.render();
    for (const p of this.particles) p.render();
  }

  /** If the SVG lens filters make frames slow on this device, fall back to plain frosted glass. */
  watchPerformance(frameMs) {
    if (!this.svgGlass || frameMs > 250) return; // ignore tab switches / long pauses
    this.frameMs += (frameMs - this.frameMs) * 0.05;
    this.slowFor = this.frameMs > 24 ? this.slowFor + frameMs : 0;
    if (this.slowFor > 2500) {
      this.svgGlass = false;
      for (const b of this.bubbles) applyGlass(b.el, b.size, b.preset, { svg: false });
    }
  }
}

/**
 * Starts the bubble simulation inside the hero's `.bubbles` container.
 * @param {HTMLElement} container
 */
export function initBubbles(container) {
  const sim = new BubbleSim(container);
  sim.start();
  return sim;
}
