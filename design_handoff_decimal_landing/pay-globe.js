/* <pay-globe> — d3 orthographic globe with geodesic payment arcs, light DOM so page keyframes (gbArcN, gbDotN) apply */
(function () {
  const FLAG_BASE = 'width:16px;height:16px;border-radius:99px;object-fit:cover;flex:none;display:inline-block;box-shadow:0 1px 2px rgba(0,0,0,.18)';
  const CC = { US: 'us', US1: 'us', US2: 'us', UK: 'gb', BR: 'br', MX: 'mx', CA: 'ca', IS: 'is' };
  const FLAGS = Object.fromEntries(Object.entries(CC).map(([k, c]) => [k, `<img src="https://flagcdn.com/w80/${c}.png" alt="" style="${FLAG_BASE}">`]));
  const PTS = { origin: [-74.0, 40.7], UK: [-0.13, 51.5], CA: [-123.12, 49.28], IS: [-21.9, 64.15], BR: [-46.63, -23.55], MX: [-99.13, 19.43], US1: [-87.63, 41.88], US2: [-97.74, 30.27] };
  const ARCS = [['UK', '£5,089'], ['BR', 'R$69,918'], ['MX', 'MX$115,506'], ['CA', 'C$25,235'], ['IS', 'kr4,657,500'], ['US1', '$29,743'], ['US2', '$2,940']];

  class PayGlobe extends HTMLElement {
    async connectedCallback() {
      if (this._done) return; this._done = true;
      while (!(window.d3 && window.topojson)) await new Promise(r => setTimeout(r, 60));
      let topo;
      try {
        topo = await (await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json')).json();
      } catch (e) { this.innerHTML = '<div style="padding:20px;font-size:11px;color:#999">globe data unavailable</div>'; return; }
      const countries = topojson.feature(topo, topo.objects.countries);
      const W = 400, H = 410;
      const projection = d3.geoOrthographic().rotate([45, -20]).fitExtent([[10, 10], [W - 10, H - 10]], { type: 'Sphere' });
      const path = d3.geoPath(projection);
      const dl = `-${Math.round(document.timeline.currentTime % 16000)}ms`;
      const arcPaths = ARCS.map((a, k) =>
        `<path d="${path({ type: 'LineString', coordinates: [PTS.origin, PTS[a[0]]] })}" pathLength="100" fill="none" stroke="var(--ink)" stroke-width="1.7" stroke-linecap="round" stroke-dasharray="100 100" style="animation:gbArc${k} 16s linear infinite;animation-delay:${dl};opacity:0"></path>`).join('');
            const CHIP = {
        UK: 'right:calc(100% + 3px);top:50%;transform:translateY(-50%)',
        CA: 'right:calc(100% + 3px);top:50%;transform:translateY(-50%)',
        IS: 'left:50%;bottom:calc(100% + 3px);transform:translateX(-50%)',
        MX: 'right:calc(100% + 3px);top:50%;transform:translateY(-50%)',
        US1: 'right:calc(100% + 3px);top:50%;transform:translateY(-50%)',
        US2: 'right:calc(100% + 3px);top:50%;transform:translateY(-50%)',
        CH: 'left:50%;top:calc(100% + 3px);transform:translateX(-50%)',
      };
      const node = (c, k, label, isOrigin) => {
        const p = projection(PTS[c]);
        const anim = isOrigin ? '' : `animation:gbDot${k} 16s linear infinite;animation-delay:${dl};opacity:0;`;
        const chipPos = (!isOrigin && CHIP[c]) || 'left:50%;top:calc(100% + 3px);transform:translateX(-50%)';
        const chip = isOrigin
          ? ''
          : `<span style="position:absolute;${chipPos};font-family:var(--font-mono);font-size:8.5px;font-weight:600;background:var(--bg-surface);border:1px solid var(--border);padding:1px 6px;white-space:nowrap">${label}</span>`;
        return `<span style="position:absolute;left:${(p[0] - 8).toFixed(1)}px;top:${(p[1] - 8).toFixed(1)}px;${anim}">${isOrigin ? '<span style="position:absolute;left:4px;top:4px;width:8px;height:8px;border-radius:99px;background:var(--ink);box-shadow:0 0 0 3px color-mix(in srgb, var(--ink) 18%, transparent)"></span>' : FLAGS[c]}${chip}</span>`;
      };
      this.innerHTML = `<div style="position:relative;width:${W}px;height:${H}px">
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="position:absolute;inset:0;overflow:visible">
          <path d="${path({ type: 'Sphere' })}" fill="color-mix(in srgb, var(--ink) 3%, transparent)" stroke="color-mix(in srgb, var(--ink) 35%, transparent)" stroke-width="1.2"></path>
          <path d="${path(d3.geoGraticule10())}" fill="none" stroke="color-mix(in srgb, var(--ink) 9%, transparent)" stroke-width="0.7"></path>
          <path d="${path(countries)}" fill="color-mix(in srgb, var(--ink) 14%, transparent)" stroke="var(--bg-surface)" stroke-width="0.4"></path>
          ${arcPaths}
        </svg>
        ${node('origin', 0, '', true)}
        ${ARCS.map((a, k) => node(a[0], k, a[1], false)).join('')}
      </div>`;
    }
  }
  customElements.define('pay-globe', PayGlobe);
})();
