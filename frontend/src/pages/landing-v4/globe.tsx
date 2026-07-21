// Port of the handoff's pay-globe.js: d3 orthographic globe with geodesic payment
// arcs firing from NYC to each vendor country. Keyframes (gbArcN/gbDotN) live in
// landing4.css; every animated element carries animation-delay = -(now % 16000)ms
// so the globe stays phase-locked with the payment-run panel (same trick as the
// design file — both sides align to the document timeline mod 16s).
import { useEffect, useState } from 'react';
import { geoOrthographic, geoPath, geoGraticule10 } from 'd3';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

const W = 400;
const H = 410;
const PTS: Record<string, [number, number]> = {
  origin: [-74.0, 40.7], UK: [-0.13, 51.5], CA: [-123.12, 49.28], IS: [-21.9, 64.15],
  BR: [-46.63, -23.55], MX: [-99.13, 19.43], US1: [-87.63, 41.88], US2: [-97.74, 30.27],
};
const ARCS: Array<[string, string]> = [
  ['UK', '£5,089'], ['BR', 'R$69,918'], ['MX', 'MX$115,506'], ['CA', 'C$25,235'],
  ['IS', 'kr4,657,500'], ['US1', '$29,743'], ['US2', '$2,940'],
];
const FLAG: Record<string, string> = { UK: 'gb', CA: 'ca', IS: 'is', BR: 'br', MX: 'mx', US1: 'us', US2: 'us' };
// Chip anchor per destination (mirrors the design's CHIP map; default = below).
const CHIP: Record<string, CSSPropertiesText> = {
  UK: { right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' },
  CA: { right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' },
  IS: { left: '50%', bottom: 'calc(100% + 3px)', transform: 'translateX(-50%)' },
  MX: { right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' },
  US1: { right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' },
  US2: { right: 'calc(100% + 3px)', top: '50%', transform: 'translateY(-50%)' },
};
type CSSPropertiesText = { left?: string; right?: string; top?: string; bottom?: string; transform?: string };

export function PayGlobe({ gbd }: { gbd: string }) {
  const [world, setWorld] = useState<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/landing4/countries-110m.json')
      .then((r) => r.json())
      .then((topo: Topology<{ countries: GeometryCollection }>) => {
        if (alive) setWorld(feature(topo, topo.objects.countries) as unknown as GeoJSON.FeatureCollection);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!world) return <div style={{ width: W, height: H }} />;

  const projection = geoOrthographic().rotate([45, -20]).fitExtent([[10, 10], [W - 10, H - 10]], { type: 'Sphere' });
  const path = geoPath(projection);

  const node = (c: string, k: number, label: string, isOrigin: boolean) => {
    const p = projection(PTS[c]);
    if (!p) return null;
    const chipPos = (!isOrigin && CHIP[c]) || { left: '50%', top: 'calc(100% + 3px)', transform: 'translateX(-50%)' };
    return (
      <span
        key={isOrigin ? 'origin' : c}
        style={{
          position: 'absolute', left: p[0] - 8, top: p[1] - 8,
          ...(isOrigin ? {} : { animation: `gbDot${k} 16s linear infinite`, animationDelay: gbd, opacity: 0 }),
        }}
      >
        {isOrigin ? (
          <span style={{ position: 'absolute', left: 4, top: 4, width: 8, height: 8, borderRadius: 99, background: 'var(--ink)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--ink) 18%, transparent)' }} />
        ) : (
          <img
            src={`/landing4/flags/${FLAG[c]}.png`} alt=""
            style={{ width: 16, height: 16, borderRadius: 99, objectFit: 'cover', flex: 'none', display: 'inline-block', boxShadow: '0 1px 2px rgba(0,0,0,.18)' }}
          />
        )}
        {!isOrigin && (
          <span style={{ position: 'absolute', ...chipPos, fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, background: 'var(--bg-surface)', border: '1px solid var(--border)', padding: '1px 6px', whiteSpace: 'nowrap' }}>
            {label}
          </span>
        )}
      </span>
    );
  };

  return (
    <div style={{ position: 'relative', width: W, height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <path d={path({ type: 'Sphere' }) ?? undefined} fill="color-mix(in srgb, var(--ink) 3%, transparent)" stroke="color-mix(in srgb, var(--ink) 35%, transparent)" strokeWidth="1.2" />
        <path d={path(geoGraticule10()) ?? undefined} fill="none" stroke="color-mix(in srgb, var(--ink) 9%, transparent)" strokeWidth="0.7" />
        <path d={path(world) ?? undefined} fill="color-mix(in srgb, var(--ink) 14%, transparent)" stroke="var(--bg-surface)" strokeWidth="0.4" />
        {ARCS.map((a, k) => (
          <path
            key={a[0]}
            d={path({ type: 'LineString', coordinates: [PTS.origin, PTS[a[0]]] }) ?? undefined}
            pathLength={100} fill="none" stroke="var(--ink)" strokeWidth="1.7" strokeLinecap="round"
            strokeDasharray="100 100"
            style={{ animation: `gbArc${k} 16s linear infinite`, animationDelay: gbd, opacity: 0 }}
          />
        ))}
      </svg>
      {node('origin', 0, '', true)}
      {ARCS.map((a, k) => node(a[0], k, a[1], false))}
    </div>
  );
}
