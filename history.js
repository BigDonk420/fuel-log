/*
 * history.js — the "History" tab: look back over past days.
 *
 * For each day it shows the effective bodyweight, the day's training, the
 * macros actually eaten, and the net caloric balance (consumed minus that day's
 * maintenance = BMR·activity + exercise, straight from the science engine).
 * Bodyweight is logged per day; a day with no entry carries the last one
 * forward (read-time gap-fill), so the weight line is always continuous.
 */
window.History = (function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const DAYS = 30;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const TYPE_LABEL = { rest: "Rest", recovery: "Recovery", easy: "Easy run", tempo: "Tempo", quality: "Quality", long: "Long run", race: "Race" };

  let CTX = null, root = null;

  const todayKey = () => new Date().toISOString().slice(0, 10);
  function fmtDate(d) {
    const dt = new Date(d + "T00:00:00");
    return `${DOW[dt.getDay()]} · ${MON[dt.getMonth()]} ${dt.getDate()}`;
  }

  // Most recent bodyweight logged on or before `date`; if none precede it, the
  // earliest known; if the athlete has never logged, the profile weight.
  function effectiveWeightKg(weights, date, fallbackKg) {
    const keys = Object.keys(weights || {}).sort();
    if (!keys.length) return fallbackKg;
    let val = null;
    for (const k of keys) {
      if (k <= date) val = weights[k]; else break;
    }
    return val != null ? val : weights[keys[0]];
  }

  function sparkline(series) {
    if (series.length < 2) return "";
    const lb = series.map((s) => CTX.kgToLb(s.kg));
    const min = Math.min(...lb), max = Math.max(...lb);
    const w = 280, h = 46, pad = 5, span = (max - min) || 1;
    const pts = lb.map((v, i) => {
      const x = pad + (i / (lb.length - 1)) * (w - 2 * pad);
      const y = pad + (1 - (v - min) / span) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg class="wt-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
  }

  function dayRow(date, weights, foodByDate, training) {
    const wKg = effectiveWeightKg(weights, date, CTX.stored.weightKg);
    const measured = weights && weights[date] != null;
    const lb = Math.round(CTX.kgToLb(wKg));
    const tr = training[date] || { type: "rest", durationMin: 0, eeeKcal: 0 };
    const exLabel = tr.type && tr.type !== "rest"
      ? `${TYPE_LABEL[tr.type] || tr.type}${tr.durationMin ? " · " + tr.durationMin + " min" : ""}${tr.eeeKcal ? " · " + tr.eeeKcal + " kcal" : ""}`
      : "Rest day";

    const food = foodByDate[date];
    const perDayUser = Object.assign({}, CTX.user, { weightKg: wKg });
    const plan = CTX.model.dayPlan(perDayUser, { type: tr.type, durationMin: tr.durationMin, eeeKcal: tr.eeeKcal });

    let netHtml = `<div class="hd-net none">—</div>`;
    let calHtml = `<span class="hd-cal muted">no food logged</span><span class="hd-mac"></span>`;
    if (food && food.kcal > 0) {
      const net = Math.round(food.kcal - plan.maintenance);
      const cls = net < 0 ? "deficit" : "surplus";
      const word = net < 0 ? "deficit" : "surplus";
      netHtml = `<div class="hd-net ${cls}">${net > 0 ? "+" : "−"}${Math.abs(net)} kcal<small>${word}</small></div>`;
      calHtml = `<span class="hd-cal">${food.kcal} kcal</span><span class="hd-mac">${food.carbs}c · ${food.protein}p · ${food.fat}f</span>`;
    }

    const items = (food && food.items || [])
      .slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""))
      .map((i) => `<div class="hd-item"><span>${esc(i.name)}</span><span class="hd-imac">${i.kcal} kcal · ${i.carbs}c ${i.protein}p ${i.fat}f</span></div>`)
      .join("");
    const itemsHtml = items
      ? `<div class="hd-items" hidden><div class="hd-tgt">day's target ${plan.calories} kcal · maintenance ${plan.maintenance} kcal</div>${items}</div>`
      : "";

    return `<div class="hd" data-date="${date}">
      <button class="hd-top" aria-expanded="false">
        <div class="hd-date">${fmtDate(date)}${date === todayKey() ? ' <span class="hd-tag">today</span>' : ""}</div>
        ${netHtml}
      </button>
      <div class="hd-stats">
        <span class="hd-w ${measured ? "meas" : "carry"}" title="${measured ? "measured" : "carried forward"}">${lb} lb${measured ? "" : " ~"}</span>
        <span class="hd-ex">${esc(exLabel)}</span>
        ${calHtml}
      </div>
      ${itemsHtml}
    </div>`;
  }

  function render(dates, food, training) {
    const weights = CTX.stored.weights || {};
    const foodByDate = {};
    (food || []).forEach((d) => { foodByDate[d.date] = d; });

    // Which days are worth showing: this is a diet history, so a day only
    // earns a row if food was logged or a weight was recorded (plus today,
    // always, so the athlete can log into it). A day you trained but logged
    // no food carries no macros/net and would just be noise.
    const shown = dates.filter((d) =>
      d === todayKey() || foodByDate[d] || weights[d] != null);

    const series = dates.map((d) => ({ date: d, kg: effectiveWeightKg(weights, d, CTX.stored.weightKg) }));
    const nowLb = Math.round(CTX.kgToLb(series[series.length - 1].kg));
    const startLb = CTX.kgToLb(series[0].kg);
    const delta = Math.round((CTX.kgToLb(series[series.length - 1].kg) - startLb) * 10) / 10;
    const deltaCls = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    const hasWeights = Object.keys(weights).length > 0;

    root.innerHTML = `
      <h3>History · last ${DAYS} days</h3>
      <div class="hist-head">
        <div class="wt-summary">
          <div class="wt-now"><b>${nowLb}</b> lb<small>current</small></div>
          ${hasWeights ? `<div class="wt-delta ${deltaCls}"><b>${delta > 0 ? "+" : ""}${delta}</b> lb<small>${DAYS}-day</small></div>` : ""}
        </div>
        ${hasWeights ? sparkline(series) : `<div class="wt-empty">Log your weight to start tracking the trend.</div>`}
        <form class="wt-form" id="wtForm">
          <input type="date" id="wtDate" value="${todayKey()}" max="${todayKey()}" aria-label="weight date"/>
          <input type="number" id="wtLb" step="0.1" min="70" max="450" placeholder="lb" aria-label="weight in pounds"/>
          <button type="submit" class="btn-primary">Log weight</button>
        </form>
      </div>
      <div class="hist-list">
        ${shown.length ? shown.slice().reverse().map((d) => dayRow(d, weights, foodByDate, training)).join("")
          : `<div class="hist-empty">Nothing logged in the last ${DAYS} days yet.</div>`}
      </div>`;

    root.querySelector("#wtForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const date = root.querySelector("#wtDate").value || todayKey();
      const lb = parseFloat(root.querySelector("#wtLb").value);
      if (!lb || lb <= 0) return;
      await CTX.saveWeight(date, CTX.lbToKg(lb));
      CTX.refresh();
    });
    root.querySelectorAll(".hd-top").forEach((b) => b.addEventListener("click", () => {
      const items = b.parentElement.querySelector(".hd-items");
      if (!items) return;
      const open = !items.hidden;
      items.hidden = open;
      b.setAttribute("aria-expanded", String(!open));
    }));
  }

  async function mount(container, ctx) {
    CTX = ctx; root = container;
    root.innerHTML = `<div class="hist-loading">Loading history…</div>`;
    const today = new Date();
    const dates = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const from = dates[0], to = dates[dates.length - 1];
    try {
      const [food, training] = await Promise.all([
        fetch(`/api/history?profile=${encodeURIComponent(CTX.profileId)}&from=${from}&to=${to}`).then((r) => (r.ok ? r.json() : [])),
        CTX.getRange(dates),
      ]);
      render(dates, food, training);
    } catch (e) {
      root.innerHTML = `<div class="hist-empty">Couldn't load history: ${esc(e.message)}</div>`;
    }
  }

  return { mount };
})();
