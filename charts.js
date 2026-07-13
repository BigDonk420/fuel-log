/*
 * charts.js — dependency-free SVG visualizations. Every chart is a pure
 * function returning an SVG string, themed through CSS custom properties so it
 * follows the app's light/dark palette.
 */
window.Charts = (function () {
  "use strict";

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function arcPath(cx, cy, r, startDeg, endDeg) {
    const [x1, y1] = polar(cx, cy, r, startDeg);
    const [x2, y2] = polar(cx, cy, r, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  // Macro donut: proportions by ENERGY (kcal), with total calories in the centre.
  function macroDonut(macros, calories) {
    const kcal = {
      protein: macros.protein * 4,
      carbs: macros.carbs * 4,
      fat: macros.fat * 9,
    };
    const total = kcal.protein + kcal.carbs + kcal.fat || 1;
    const segs = [
      { v: kcal.carbs, cls: "seg-carb" },
      { v: kcal.protein, cls: "seg-protein" },
      { v: kcal.fat, cls: "seg-fat" },
    ];
    const cx = 90, cy = 90, r = 68;
    let deg = 0;
    let paths = "";
    segs.forEach((s) => {
      const sweep = (s.v / total) * 360;
      if (sweep > 0.5) {
        paths += `<path d="${arcPath(cx, cy, r, deg, deg + sweep)}" class="${s.cls}" fill="none" stroke-width="20" stroke-linecap="butt"/>`;
      }
      deg += sweep;
    });
    return `<svg viewBox="0 0 180 180" class="chart-donut" role="img" aria-label="macro split">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="20"/>
      ${paths}
      <text x="${cx}" y="${cy - 4}" class="donut-num" text-anchor="middle">${calories}</text>
      <text x="${cx}" y="${cy + 16}" class="donut-lbl" text-anchor="middle">kcal / day</text>
    </svg>`;
  }

  // Energy-availability gauge: 0..60 kcal/kg FFM with the three REDs zones.
  function eaGauge(value) {
    const cx = 100, cy = 100, r = 78;
    const min = 0, max = 60;
    const toDeg = (v) => -90 + (Math.min(max, Math.max(min, v)) / max) * 180;
    const zone = (a, b, cls) =>
      `<path d="${arcPath(cx, cy, r, toDeg(a), toDeg(b))}" class="${cls}" fill="none" stroke-width="16"/>`;
    const [nx, ny] = polar(cx, cy, r - 4, toDeg(value));
    return `<svg viewBox="0 0 200 130" class="chart-gauge" role="img" aria-label="energy availability">
      ${zone(0, 30, "ea-danger")}
      ${zone(30, 45, "ea-warn")}
      ${zone(45, 60, "ea-ok")}
      <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" class="gauge-needle"/>
      <circle cx="${cx}" cy="${cy}" r="5" class="gauge-hub"/>
      <text x="${cx}" y="${cy - 22}" class="gauge-num" text-anchor="middle">${value}</text>
      <text x="${cx}" y="${cy - 6}" class="gauge-lbl" text-anchor="middle">kcal/kg FFM</text>
    </svg>`;
  }

  // Weekly bars: training load per day with today highlighted, plus each day's
  // carbohydrate target as dots — the periodization made visible.
  function weekLoad(days) {
    const W = 520, H = 200, padL = 34, padB = 34, padT = 16;
    const plotH = H - padB - padT;
    const maxLoad = Math.max(...days.map((d) => d.load), 1);
    const maxCarb = Math.max(...days.map((d) => d.carbG), 1);
    const bw = (W - padL - 10) / days.length;
    let bars = "", dots = "", labels = "";
    days.forEach((d, i) => {
      const x = padL + i * bw;
      const bh = (d.load / maxLoad) * plotH;
      const y = padT + plotH - bh;
      bars += `<rect x="${x + bw * 0.18}" y="${y}" width="${bw * 0.64}" height="${bh}" rx="4" class="${d.isToday ? "bar-today" : "bar"}"/>`;
      const cy = padT + plotH - (d.carbG / maxCarb) * plotH;
      dots += `<circle cx="${x + bw / 2}" cy="${cy}" r="3.5" class="carb-dot"/>`;
      labels += `<text x="${x + bw / 2}" y="${H - 12}" class="axis-lbl ${d.isToday ? "axis-today" : ""}" text-anchor="middle">${d.label}</text>`;
    });
    // connect carb dots with a faint line
    let line = "";
    days.forEach((d, i) => {
      const x = padL + i * bw + bw / 2;
      const cy = padT + plotH - (d.carbG / maxCarb) * plotH;
      line += `${i === 0 ? "M" : "L"} ${x} ${cy} `;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="chart-week" role="img" aria-label="weekly training load and carbohydrate targets">
      <path d="${line}" class="carb-line" fill="none"/>
      ${bars}${dots}${labels}
    </svg>`;
  }

  // Hydration ring: filled glasses out of the day's sweat-adjusted goal.
  function hydrationRing(filled, goal) {
    const cx = 70, cy = 70, r = 54, circ = 2 * Math.PI * r;
    const pct = Math.min(1, filled / goal);
    return `<svg viewBox="0 0 140 140" class="chart-hydro" role="img" aria-label="hydration progress">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="12"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" class="hydro-arc" stroke-width="12"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"
        transform="rotate(-90 ${cx} ${cy})" stroke-linecap="round"/>
      <text x="${cx}" y="${cy - 2}" class="hydro-num" text-anchor="middle">${filled}/${goal}</text>
      <text x="${cx}" y="${cy + 16}" class="hydro-lbl" text-anchor="middle">glasses</text>
    </svg>`;
  }

  return { macroDonut, eaGauge, weekLoad, hydrationRing };
})();
