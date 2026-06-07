/* global React */
/* ============================================================
   DECIMAL — Globe hero. Solid shaded sphere + continents + arcs.
   ============================================================ */
const { useRef, useEffect } = React;
const A3 = "landing/assets/";

const Ic3 = {
  arrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  bolt:  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>,
};

function Chrome3() {
  return (
    <React.Fragment>
      <div className="hnav">
        <a className="hbrand" href="#"><img src={A3 + "decimal-logo.png"} alt="" /><span>Decimal</span></a>
        <div className="hlinks"><a href="#sec-payments">Payments</a><a href="#sec-xborder">Cross-border</a><a href="#sec-security">Security</a><a href="#sec-faq">FAQ</a></div>
        <div className="hnav-right"><a className="signin" href="#">Sign in</a><a className="nav-pill" href="#">Get started</a></div>
      </div>
      <div className="h-col">
        <h1 className="dsp">Hand AI the <em>work,</em><br />not the <em>keys.</em></h1>
        <p className="sub">AI-powered accounts payable for teams that pay vendors worldwide, automating every bill from capture and coding to approval, payment, and reconciliation.</p>
        <div className="cta-row">
          <a className="btn-primary" href="#">Get started {Ic3.arrow}</a>
          <a className="btn-secondary" href="#">See it in action</a>
        </div>
      </div>
    </React.Fragment>
  );
}

/* sphere + dot/arc color presets */
const PRESETS = {
  black:   { hi: "#2b2b2b", base: "#121212", limb: "#000000", rim: "rgba(255,255,255,.10)",
             dot: "255,255,255", dotBase: 0.34, dotRange: 0.5, arc: "230,0,92", accent: "230,0,92", hub: "255,255,255" },
  magenta: { hi: "#ff5298", base: "#e6005c", limb: "#9c0040", rim: "rgba(255,255,255,.20)",
             dot: "255,255,255", dotBase: 0.52, dotRange: 0.46, arc: "255,255,255", accent: "255,255,255", hub: "255,255,255" },
  ivory:   { hi: "#ffffff", base: "#f1efea", limb: "#d6d2c9", rim: "rgba(0,0,0,.06)",
             dot: "0,0,0", dotBase: 0.46, dotRange: 0.5, arc: "230,0,92", accent: "230,0,92", hub: "16,16,16" },
};

const D2R = Math.PI / 180;
function llToVec(latDeg, lonDeg) {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  return { x: Math.cos(lat) * Math.cos(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lon) };
}
const rotY = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }; };
const rotX = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c }; };
function slerp(a, b, t) {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z;
  dot = Math.max(-1, Math.min(1, dot));
  const om = Math.acos(dot), so = Math.sin(om);
  if (so < 1e-6) return { x: a.x, y: a.y, z: a.z };
  const k0 = Math.sin((1 - t) * om) / so, k1 = Math.sin(t * om) / so;
  return { x: a.x * k0 + b.x * k1, y: a.y * k0 + b.y * k1, z: a.z * k0 + b.z * k1 };
}

function Globe({ width = 600, height = 840, cx = 340, cy = 432, R = 318, preset = "black" }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const P = PRESETS[preset] || PRESETS.black;
    const ctx = canvas.getContext("2d");
    const DPR = Math.min(2, window.devicePixelRatio || 1.5);
    canvas.width = width * DPR; canvas.height = height * DPR;
    canvas.style.width = width + "px"; canvas.style.height = height + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    const M = window.GLOBE_MASK, raw = M ? atob(M.bits) : null;
    const isLand = (lat, lon) => {
      if (!raw) return true;
      const u = (lon + 180) / 360, v = (90 - lat) / 180;
      const ix = Math.min(M.w - 1, Math.max(0, Math.floor(u * M.w)));
      const iy = Math.min(M.h - 1, Math.max(0, Math.floor(v * M.h)));
      const bit = iy * M.w + ix;
      return (raw.charCodeAt(bit >> 3) >> (bit & 7)) & 1;
    };

    const CAND = 15000, golden = Math.PI * (3 - Math.sqrt(5)), dots = [];
    for (let i = 0; i < CAND; i++) {
      const y = 1 - (i / (CAND - 1)) * 2;
      const rad = Math.sqrt(1 - y * y), th = golden * i;
      const x = Math.cos(th) * rad, z = Math.sin(th) * rad;
      const lat = Math.asin(y) / D2R, lon = Math.atan2(z, x) / D2R;
      if (isLand(lat, lon)) dots.push({ x, y, z, tw: Math.random() * 6.28 });
    }

    const C = {
      ny: llToVec(40.7, -74), ln: llToVec(51.5, -0.1), lg: llToVec(6.5, 3.4),
      br: llToVec(52.5, 13.4), sg: llToVec(1.35, 103.8), sp: llToVec(-23.5, -46.6),
      dl: llToVec(28.6, 77.2), sy: llToVec(-33.9, 151.2), tk: llToVec(35.7, 139.7),
      db: llToVec(25.2, 55.3), mx: llToVec(19.4, -99.1), nb: llToVec(-1.3, 36.8),
    };
    // vertex-disjoint pairs — every city used once, so no point ever has two lines
    const pairList = [[C.ny, C.ln], [C.sp, C.lg], [C.br, C.dl], [C.sg, C.sy], [C.tk, C.mx], [C.db, C.nb]];
    const periods = [6.0, 5.2, 6.8, 5.6, 7.2, 6.4];
    const phases  = [0.0, 2.1, 3.6, 1.2, 4.4, 5.5];
    const SEG = 44;
    const routes = pairList.map(([a, b], i) => {
      const chord = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const arcH = 0.04 + chord * 0.20, pts = [];
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG, p = slerp(a, b, t), lift = 1 + arcH * Math.sin(Math.PI * t);
        pts.push({ x: p.x * lift, y: p.y * lift, z: p.z * lift });
      }
      return { pts, start: a, end: b, period: periods[i], phase: phases[i] };
    });
    const ACT = 0.74;                                  // fraction of period the line is alive (rest = gap)
    const easeOut = (x) => 1 - Math.pow(1 - x, 3);
    const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

    const TILT = -20 * D2R;
    const project = (v) => ({ sx: cx + v.x * R, sy: cy - v.y * R, z: v.z });
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf, angle = -1.7, last = null;

    function drawSphere() {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283);
      ctx.shadowColor = "rgba(20,18,16,0.20)"; ctx.shadowBlur = 50; ctx.shadowOffsetY = 26;
      ctx.fillStyle = P.base; ctx.fill();
      ctx.restore();
      const g = ctx.createRadialGradient(cx - R * 0.36, cy - R * 0.42, R * 0.06, cx, cy, R * 1.18);
      g.addColorStop(0, P.hi); g.addColorStop(0.55, P.base); g.addColorStop(1, P.limb);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, R - 0.5, 0, 6.283); ctx.lineWidth = 1; ctx.strokeStyle = P.rim; ctx.stroke();
    }

    function render(now) {
      ctx.clearRect(0, 0, width, height);
      const tsec = now / 1000;
      drawSphere();

      // front-facing land dots
      for (const d of dots) {
        const v = rotX(rotY(d, angle), TILT);
        const p = project(v);
        if (p.z <= 0.015) continue;
        const tw = 0.82 + 0.18 * Math.sin(tsec * 1.6 + d.tw);
        const edge = Math.min(1, p.z * 4);                 // fade near the limb
        const op = (P.dotBase + p.z * P.dotRange) * tw * edge;
        ctx.fillStyle = "rgba(" + P.dot + "," + op.toFixed(3) + ")";
        ctx.fillRect(p.sx - 0.85, p.sy - 0.85, 1.7, 1.7);
      }

      // payment routes — draw on A->B, hold, then erase A->B (Stripe-style)
      for (const rt of routes) {
        const u = ((tsec + rt.phase) % rt.period) / rt.period;
        if (u >= ACT) continue;                          // gap between cycles
        const p = u / ACT;                               // 0..1 while alive
        let head, tail;
        if (p < 0.30) { head = easeOut(p / 0.30); tail = 0; }          // draw on
        else if (p < 0.60) { head = 1; tail = 0; }                     // hold
        else { head = 1; tail = easeInOut((p - 0.60) / 0.40); }        // erase from A
        const N = rt.pts.length - 1;
        const hIdx = Math.round(head * N), tIdx = Math.round(tail * N);
        const endFade = p > 0.93 ? Math.max(0, 1 - (p - 0.93) / 0.07) : 1;
        for (let s = tIdx; s < hIdx; s++) {
          const a = project(rotX(rotY(rt.pts[s], angle), TILT));
          const b = project(rotX(rotY(rt.pts[s + 1], angle), TILT));
          const zf = (a.z + b.z) / 2;
          if (zf <= 0.0) continue;
          const segVis = Math.min(1, 0.4 + zf);
          ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
          ctx.strokeStyle = "rgba(" + P.arc + "," + (0.85 * segVis).toFixed(3) + ")";
          ctx.lineWidth = 1.4; ctx.stroke();
        }
        if (head < 1) {                                   // leading pulse while drawing
          const hp = project(rotX(rotY(rt.pts[hIdx], angle), TILT));
          if (hp.z > 0.0) {
            ctx.beginPath(); ctx.arc(hp.sx, hp.sy, 2.5, 0, 6.283);
            ctx.fillStyle = "rgba(" + P.accent + ",1)";
            ctx.shadowColor = "rgba(" + P.accent + ",0.9)"; ctx.shadowBlur = 9; ctx.fill(); ctx.shadowBlur = 0;
          }
        }
        if (tail < 0.04) {                                // origin dot, until the line erases past it
          const sv = project(rotX(rotY(rt.start, angle), TILT));
          if (sv.z > 0.0) {
            ctx.beginPath(); ctx.arc(sv.sx, sv.sy, 2.4, 0, 6.283);
            ctx.fillStyle = "rgba(" + P.accent + ",0.85)"; ctx.fill();
          }
        }
        if (head > 0.98) {                                // destination pulse once arrived
          const ev = project(rotX(rotY(rt.end, angle), TILT));
          if (ev.z > 0.0) {
            const pr = 2.6 + 1.4 * (0.5 + 0.5 * Math.sin(tsec * 3 + rt.phase * 6));
            ctx.beginPath(); ctx.arc(ev.sx, ev.sy, pr + 4, 0, 6.283);
            ctx.fillStyle = "rgba(" + P.accent + "," + (0.13 * endFade).toFixed(3) + ")"; ctx.fill();
            ctx.beginPath(); ctx.arc(ev.sx, ev.sy, 2.8, 0, 6.283);
            ctx.fillStyle = "rgba(" + P.accent + "," + endFade.toFixed(3) + ")";
            ctx.shadowColor = "rgba(" + P.accent + ",0.9)"; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
          }
        }
      }
    }

    function loop(now) {
      if (last == null) last = now;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!reduce) angle += dt * 0.07;
      render(now);
      if (!reduce) raf = requestAnimationFrame(loop);
    }
    render(performance.now());
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [width, height, cx, cy, R, preset]);

  return <canvas ref={ref} className="globe-canvas" />;
}

function GlobeHeroSphere({ preset, full }) {
  const geo = full ? { cx: 300, cy: 430, R: 256 } : {};
  return (
    <div className="hero">
      <Chrome3 />
      <div className="block light">
        <Globe preset={preset} {...geo} />
      </div>
    </div>
  );
}

Object.assign(window, { GlobeHeroSphere, Globe });
