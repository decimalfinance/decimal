import { useEffect, useRef } from 'react';
import { ORB_SHADER } from './orb-shader';

/**
 * The orb, the Decimal agent's mark (the handoff's o13 renderer).
 *
 * One offscreen WebGL canvas renders the shader once per size and state, and
 * each orb on the page copies the result into its own 2D canvas, so twenty
 * orbs cost one WebGL context. Frames run at ~30fps and only for orbs on
 * screen; a still orb, or anyone who prefers reduced motion, gets one frame.
 *
 * `size` is the sphere in CSS px. The canvas is larger, by 30% of the size on
 * every side (90% from 100px up), for the glow, and pulls itself back with a
 * negative margin so the sphere sits where `size` says.
 */
export type OrbState = 'rest' | 'work' | 'still';
/** What the orb sits on: Decimal's pink surface, the page, or white. */
export type OrbBackground = 'surf' | 'page' | 'white';

type Dest = {
  el: HTMLCanvasElement;
  size: number;
  state: OrbState;
  bg: OrbBackground;
  S: number;
  drawn: boolean;
};

type Program = {
  p: WebGLProgram;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uWork: WebGLUniformLocation | null;
  uCss: WebGLUniformLocation | null;
  uW: WebGLUniformLocation | null;
  uGlow: WebGLUniformLocation | null;
};

type Engine = {
  cv: HTMLCanvasElement;
  gl: WebGLRenderingContext | null;
  prog: Program | null;
  dests: Set<Dest>;
  byEl: WeakMap<HTMLCanvasElement, Dest>;
  vis: Set<HTMLCanvasElement>;
  io: IntersectionObserver | null;
  mq: MediaQueryList | null;
  t0: number;
  last: number;
  lastScan: number;
  raf: number;
};

let engine: Engine | null = null;

export function orbPad(size: number) {
  return Math.round(size * (size >= 100 ? 0.9 : 0.3));
}

function compile(gl: WebGLRenderingContext): Program | null {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Orb shader: ' + gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = mk(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}');
  const f = mk(gl.FRAGMENT_SHADER, ORB_SHADER);
  if (!v || !f) return null;
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, 'a');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('Orb shader: ' + gl.getProgramInfoLog(p));
    return null;
  }
  return {
    p,
    uRes: gl.getUniformLocation(p, 'uRes'),
    uTime: gl.getUniformLocation(p, 'uTime'),
    uWork: gl.getUniformLocation(p, 'uWork'),
    uCss: gl.getUniformLocation(p, 'uCss'),
    uW: gl.getUniformLocation(p, 'uW'),
    uGlow: gl.getUniformLocation(p, 'uGlow'),
  };
}

function getEngine(): Engine {
  if (engine) return engine;
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 1024;
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = cv.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
  } catch {
    gl = null;
  }
  let prog: Program | null = null;
  if (gl) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    prog = compile(gl);
  }
  const e: Engine = {
    cv,
    gl,
    prog,
    dests: new Set(),
    byEl: new WeakMap(),
    vis: new Set(),
    io: null,
    mq: window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null,
    t0: performance.now(),
    last: 0,
    lastScan: 0,
    raf: 0,
  };
  if ('IntersectionObserver' in window) {
    e.io = new IntersectionObserver(
      (entries) => entries.forEach((en) => {
        const el = en.target as HTMLCanvasElement;
        if (en.isIntersecting) e.vis.add(el);
        else e.vis.delete(el);
      }),
      { rootMargin: '120px' },
    );
  }
  engine = e;
  return e;
}

/** Size each canvas's backing store for the screen it is on (zoom included). */
function scan(e: Engine) {
  const dpr = window.devicePixelRatio || 1;
  e.dests.forEach((d) => {
    const el = d.el;
    const ow = el.offsetWidth;
    if (!ow) return;
    let k = el.getBoundingClientRect().width / ow;
    if (!(k > 0) || !isFinite(k)) k = 1;
    const pr = d.size >= 100 ? 0.9 : 0.3;
    const f = Math.min(1024 / (d.size + 2 * Math.round(d.size * pr)), Math.max(0.5, Math.ceil(dpr * k * 2 - 0.05) / 2));
    const S = Math.round(d.size * f);
    const pad = Math.round(Math.round(d.size * pr) * f);
    const W = S + 2 * pad;
    if (el.width !== W || d.S !== S) {
      el.width = W;
      el.height = W;
      d.S = S;
      d.drawn = false;
    }
  });
}

function render(e: Engine, size: number, full: number, time: number, work: number, css: number, glow: number[]) {
  const gl = e.gl;
  const P = e.prog;
  if (!gl || !P) return false;
  gl.viewport(0, 0, full, full);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(P.p);
  gl.uniform2f(P.uRes, size, size);
  if (P.uW) gl.uniform1f(P.uW, full);
  if (P.uGlow) gl.uniform4f(P.uGlow, glow[0]!, glow[1]!, glow[2]!, glow[3]!);
  gl.uniform1f(P.uTime, time);
  gl.uniform1f(P.uWork, work);
  if (P.uCss) gl.uniform1f(P.uCss, css);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return true;
}

/** Copy the rendered orb into one canvas, or draw a plain sphere without WebGL. */
function blit(e: Engine, d: Dest, full: number, ok: boolean) {
  const el = d.el;
  const ctx = el.getContext('2d');
  if (!ctx) return;
  const Wd = el.width;
  const R = d.S / 2;
  const c = Wd / 2;
  ctx.clearRect(0, 0, Wd, Wd);
  if (ok) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(e.cv, 0, e.cv.height - full, full, full, 0, 0, Wd, Wd);
    return;
  }
  const surf = d.bg === 'surf';
  const rgb = surf ? '255,255,255' : '240,176,191';
  const a = surf ? 0.9 : 0.55;
  const g = ctx.createRadialGradient(c, c, R * 0.9, c, c, Wd / 2);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(0.4, `rgba(${rgb},${(a * 0.4).toFixed(3)})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, Wd, Wd);
  const f = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
  f.addColorStop(0, '#DC8DA2');
  f.addColorStop(0.45, '#883A52');
  f.addColorStop(1, '#350E1B');
  ctx.fillStyle = f;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();
}

function frame(now: number) {
  const e = engine;
  if (!e) return;
  if (e.dests.size === 0) {
    e.raf = 0;
    return;
  }
  e.raf = requestAnimationFrame(frame);
  if (now - e.last < 33) return;
  e.last = now;
  if (now - e.lastScan > 1000) {
    e.lastScan = now;
    scan(e);
  }
  const t = (now - e.t0) / 1000;
  const reduced = Boolean(e.mq?.matches);
  const groups = new Map<string, Dest[]>();
  e.dests.forEach((d) => {
    if (!d.S) return;
    const still = d.state === 'still' || reduced;
    if (still ? d.drawn : !(e.io ? e.vis.has(d.el) : true)) return;
    const key = `${d.state}|${d.size}|${d.S}|${d.bg}|${d.el.width}`;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  });
  groups.forEach((ds) => {
    const d0 = ds[0]!;
    const still = d0.state === 'still' || reduced;
    const work = d0.state === 'work' && !reduced;
    const full = d0.el.width;
    const glow = d0.bg === 'surf' ? [1, 1, 1, 0.9] : [0.941, 0.69, 0.749, 0.55];
    // The big orb runs at 45% speed; the small ones keep their pace.
    const sp = d0.size >= 100 ? 0.45 : 1;
    const ok = render(e, d0.S, full, still ? 7 : 7 + t * (work ? 5 : 1) * sp, work ? 1 : 0, d0.size, glow);
    ds.forEach((d) => {
      blit(e, d, full, ok);
      d.drawn = true;
    });
  });
}

function attach(el: HTMLCanvasElement, size: number, state: OrbState, bg: OrbBackground) {
  const e = getEngine();
  const d: Dest = { el, size, state, bg, S: 0, drawn: false };
  e.dests.add(d);
  e.byEl.set(el, d);
  if (e.io) e.io.observe(el);
  scan(e);
  if (!e.raf) e.raf = requestAnimationFrame(frame);
  return () => {
    e.dests.delete(d);
    e.byEl.delete(el);
    e.vis.delete(el);
    if (e.io) e.io.unobserve(el);
  };
}

export function Orb({
  size,
  state = 'rest',
  bg = 'page',
  className,
  title,
}: {
  size: number;
  state?: OrbState;
  bg?: OrbBackground;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attach(el, size, state, bg);
  }, [size, state, bg]);
  const pad = orbPad(size);
  const full = size + 2 * pad;
  return (
    <canvas
      ref={ref}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: 'block', flex: 'none', width: full, height: full, margin: -pad }}
    />
  );
}
