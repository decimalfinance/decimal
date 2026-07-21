import { useEffect, useRef } from 'react';

// Canvas-based "wall of code" — single DOM element, pre-rendered base grid,
// only active glow cells are redrawn per frame. Avoids thousands of animated
// DOM nodes (which is what locked up the page).

const COLS = 200;
const ROWS = 70;
const CHAR_H = 22;
const FONT_PX = 13;
const LETTER_SPACING_PX = 4;
const FONT = `${FONT_PX}px "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace`;
const HEX = '0123456789abcdef';

const RANDOM_GLOWS = 460;

// Glow animation parameters.
type Glow = {
  row: number;
  col: number;
  delay: number; // seconds
  period: number; // seconds (full cycle)
  peakHalfWidth: number; // fraction of period that lights up per side of peak
  peakAmp: number; // max alpha at peak
};

function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

type State = { grid: string[][]; glows: Glow[] };

function buildWall(): State {
  const rand = mulberry32(0xa51c);
  const grid: string[][] = [];
  for (let y = 0; y < ROWS; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < COLS; x += 1) row.push(HEX[Math.floor(rand() * 16)]);
    grid.push(row);
  }

  const glows: Glow[] = [];
  const used = new Set<number>();
  const key = (r: number, c: number) => r * 1000 + c;

  // Scattered random glows. Faster cycle + narrower peak so individual cells
  // blink briefly and the next starts soon after.
  const PERIOD = 3.5;
  let remaining = RANDOM_GLOWS;
  let tries = 0;
  while (remaining > 0 && tries < RANDOM_GLOWS * 3) {
    tries += 1;
    const r = Math.floor(rand() * ROWS);
    const c = Math.floor(rand() * COLS);
    const k = key(r, c);
    if (used.has(k)) continue;
    used.add(k);
    glows.push({
      row: r,
      col: c,
      // Uniformly distributed phase so start/stop staggers across all cells.
      delay: rand() * PERIOD,
      period: PERIOD,
      peakHalfWidth: 0.08,
      peakAmp: 0.5,
    });
    remaining -= 1;
  }

  return { grid, glows };
}

function computeAlpha(t: number, g: Glow): number {
  let cycle = ((t - g.delay) % g.period + g.period) / g.period;
  if (cycle >= 1) cycle -= 1;
  const dist = Math.abs(cycle - 0.5);
  if (dist > g.peakHalfWidth) return 0;
  return (1 - dist / g.peakHalfWidth) * g.peakAmp;
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function readAccentRgb(el: Element | null, fallback: string): string {
  if (!el) return fallback;
  const v = getComputedStyle(el).getPropertyValue('--ax-accent-rgb').trim();
  return v || fallback;
}

export function CodeWall() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const state = buildWall();

    // Backing canvas for the static base grid — drawn once per rebuild, then
    // copied into the visible canvas each frame with drawImage (cheap).
    const baseCanvas = document.createElement('canvas');
    const baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) return;
    const drawingCanvas = canvas;
    const drawingCtx = ctx;
    const staticCtx = baseCtx;

    let dpr = 1;
    let cssW = 0;
    let cssH = 0;
    let charW = 10;
    let offsetX = 0;
    let offsetY = 0;
    let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let startTime = performance.now();
    let rafId = 0;
    let visible = !document.hidden;

    function rebuild() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = window.innerWidth;
      cssH = window.innerHeight;

      drawingCanvas.width = cssW * dpr;
      drawingCanvas.height = cssH * dpr;
      drawingCanvas.style.width = `${cssW}px`;
      drawingCanvas.style.height = `${cssH}px`;
      drawingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawingCtx.font = FONT;
      drawingCtx.textBaseline = 'top';

      baseCanvas.width = cssW * dpr;
      baseCanvas.height = cssH * dpr;
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      staticCtx.font = FONT;
      staticCtx.textBaseline = 'top';

      charW = staticCtx.measureText('0').width + LETTER_SPACING_PX;

      const totalW = COLS * charW;
      const totalH = ROWS * CHAR_H;
      offsetX = (cssW - totalW) / 2;
      offsetY = (cssH - totalH) / 2;

      const isDark = currentTheme() === 'dark';
      staticCtx.clearRect(0, 0, cssW, cssH);
      staticCtx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';

      for (let y = 0; y < ROWS; y += 1) {
        const row = state.grid[y];
        const py = offsetY + y * CHAR_H;
        if (py < -CHAR_H || py > cssH + CHAR_H) continue;
        for (let x = 0; x < COLS; x += 1) {
          const px = offsetX + x * charW;
          if (px < -charW || px > cssW + charW) continue;
          staticCtx.fillText(row[x], px, py);
        }
      }
    }

    function draw() {
      if (!visible) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      const t = (performance.now() - startTime) / 1000;

      drawingCtx.shadowBlur = 0;
      drawingCtx.clearRect(0, 0, cssW, cssH);
      drawingCtx.drawImage(baseCanvas, 0, 0, cssW, cssH);

      const accentRgb = readAccentRgb(drawingCanvas, '74, 93, 46');

      drawingCtx.font = FONT;
      drawingCtx.textBaseline = 'top';

      if (reducedMotion) {
        drawingCtx.fillStyle = `rgba(${accentRgb},0.22)`;
        for (const g of state.glows) {
          drawingCtx.fillText(state.grid[g.row][g.col], offsetX + g.col * charW, offsetY + g.row * CHAR_H);
        }
      } else {
        drawingCtx.shadowColor = `rgb(${accentRgb})`;
        drawingCtx.shadowBlur = 4;
        for (const g of state.glows) {
          const alpha = computeAlpha(t, g);
          if (alpha < 0.02) continue;
          drawingCtx.fillStyle = `rgba(${accentRgb},${alpha.toFixed(3)})`;
          drawingCtx.fillText(state.grid[g.row][g.col], offsetX + g.col * charW, offsetY + g.row * CHAR_H);
        }
        drawingCtx.shadowBlur = 0;
      }

      rafId = requestAnimationFrame(draw);
    }

    rebuild();
    draw();

    const onResize = () => rebuild();
    const onVisibility = () => {
      visible = !document.hidden;
    };
    const themeObserver = new MutationObserver(() => rebuild());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onReduced = () => {
      reducedMotion = reducedMq.matches;
    };

    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    reducedMq.addEventListener('change', onReduced);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      themeObserver.disconnect();
      reducedMq.removeEventListener('change', onReduced);
    };
  }, []);

  return <canvas ref={canvasRef} className="lp-bg-wall" aria-hidden="true" />;
}
