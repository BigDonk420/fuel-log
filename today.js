/*
 * today.js — the "Today" plan: the home screen's answer to "what should I do
 * right now to fuel the work?"
 *
 * Deterministic only (the app computes; a later build lets Claude compose):
 *   - remaining-need engine: target (from model.js) minus what's been logged
 *   - a timeline of the day: meals eaten, the workout, and the fuelling windows
 *     around it, with the NEXT action highlighted
 *   - a readiness line tied to the day's session type
 *
 * Today's session comes from a manually planned session if set (profile.plans),
 * otherwise from intervals.icu. Everything degrades gracefully to a rest day.
 */
window.TodayPlan = (function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const TYPES = ["rest", "recovery", "easy", "tempo", "quality", "long"];
  const TYPE_LABEL = { rest: "Rest day", recovery: "Recovery run", easy: "Easy run", tempo: "Tempo run", quality: "Quality session", long: "Long run", race: "Race" };
  const HARD = { tempo: 1, quality: 1, long: 1, race: 1 };

  let CTX = null; // { user, plan, session, profileId, date, savePlan }
  let root = null;

  const api = {
    async logs() {
      const r = await fetch(`/api/food?profile=${encodeURIComponent(CTX.profileId)}&date=${CTX.date}`);
      return r.ok ? r.json() : [];
    },
  };

  /* ---------- time helpers ---------- */
  function at(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m || 0, 0, 0);
    return d;
  }
  function clock(d) {
    if (!d) return "";
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, "0")}${ap}`;
  }
  function mealName(d) {
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < 10.5) return "Breakfast";
    if (h < 12) return "Morning snack";
    if (h < 15) return "Lunch";
    if (h < 18) return "Afternoon snack";
    if (h < 21) return "Dinner";
    return "Evening snack";
  }

  /* ---------- group logged items into meals by time proximity ---------- */
  function toMeals(logs) {
    const items = logs
      .map((e) => ({ e, t: e.time ? new Date(e.time) : null }))
      .filter((x) => x.t)
      .sort((a, b) => a.t - b.t);
    const noTime = logs.filter((e) => !e.time);
    const meals = [];
    let cur = null;
    items.forEach(({ e, t }) => {
      if (!cur || t - cur.t > 90 * 60000) {
        cur = { t, items: [], kcal: 0, carbs: 0, protein: 0, fat: 0 };
        meals.push(cur);
      }
      cur.items.push(e.name);
      cur.kcal += e.kcal || 0; cur.carbs += e.carbs || 0;
      cur.protein += e.protein || 0; cur.fat += e.fat || 0;
      cur.t = t;
    });
    if (noTime.length) {
      const m = { t: null, items: noTime.map((e) => e.name), kcal: 0, carbs: 0, protein: 0, fat: 0 };
      noTime.forEach((e) => { m.kcal += e.kcal || 0; m.carbs += e.carbs || 0; m.protein += e.protein || 0; m.fat += e.fat || 0; });
      meals.push(m);
    }
    return meals;
  }

  /* ---------- build the day's timeline ---------- */
  function buildTimeline(meals, session, remaining) {
    const now = new Date();
    const w = Math.round(CTX.user.weightKg);
    const ev = [];

    meals.forEach((m) => ev.push({
      at: m.t, icon: "check", state: "done",
      title: (m.t ? mealName(m.t) : "Logged") + " — " + m.items.slice(0, 3).join(", ") + (m.items.length > 3 ? "…" : ""),
      sub: `${m.t ? clock(m.t) + " · " : ""}${Math.round(m.kcal)} kcal · ${Math.round(m.carbs)} g carbs`,
    }));

    if (session && session.type !== "rest") {
      const start = at(session.startTime);
      const label = TYPE_LABEL[session.type] || session.type;
      const dur = session.durationMin || 0;
      const dc = CTX.plan.duringCarb;

      if (start) {
        const pre = new Date(start.getTime() - 90 * 60000);
        ev.push({ at: pre, icon: "bolt", state: now < start ? "todo" : "done",
          title: "Pre-run fuel", sub: `~${clock(pre)} · ${w}–${w * 2} g carbs, 1–4 h before` });
      }
      ev.push({ at: start, icon: "run", state: start && now > new Date(start.getTime() + dur * 60000) ? "done" : "todo",
        title: label + (dur ? ` · ${dur} min` : ""), sub: start ? clock(start) + (dc ? ` · during: ${dc.low}–${dc.high} g/h` : "") : "today" });
      const post = start ? new Date(start.getTime() + dur * 60000) : null;
      ev.push({ at: post, icon: "clock", state: post && now > new Date(post.getTime() + 60 * 60000) ? "done" : "todo",
        title: "Recovery window", sub: `${post ? "by " + clock(new Date(post.getTime() + 60 * 60000)) + " · " : "within 1 h · "}${Math.round(w * 0.3)} g protein + carbs` });
    }

    if (remaining.kcal > 150) {
      ev.push({ at: null, icon: "plus", state: "todo",
        title: "Next meal", sub: `fill the gap · ${remaining.kcal} kcal · ${remaining.carbs} g carbs · ${remaining.protein} g protein` });
    }

    // sort: timed events chronologically, untimed to the end; mark the first
    // not-done event as the "next" action
    ev.sort((a, b) => (a.at ? a.at.getTime() : Infinity) - (b.at ? b.at.getTime() : Infinity));
    const next = ev.find((e) => e.state === "todo");
    if (next) next.state = "next";
    return ev;
  }

  const ICON = { check: "✓", bolt: "⚡", run: "🏃", clock: "◷", plus: "＋", moon: "☾" };

  function readiness(session, consumed, target) {
    const frac = consumed.carbs / Math.max(target.carbs, 1);
    const label = TYPE_LABEL[session ? session.type : "rest"];
    if (session && HARD[session.type]) {
      const ok = frac >= 0.5 || new Date().getHours() < 14;
      return ok
        ? { ok: true, text: `On track to fuel today's ${label.toLowerCase()}` }
        : { ok: false, text: `Behind on carbs for today's ${label.toLowerCase()}` };
    }
    if (session && session.type !== "rest") return { ok: true, text: `Fuelling an easy day` };
    return { ok: true, text: `Rest day — steady fuelling` };
  }

  /* ---------- render ---------- */
  function render(logs) {
    const meals = toMeals(logs);
    const consumed = meals.reduce((t, m) => ({
      kcal: t.kcal + m.kcal, carbs: t.carbs + m.carbs, protein: t.protein + m.protein, fat: t.fat + m.fat,
    }), { kcal: 0, carbs: 0, protein: 0, fat: 0 });
    const tg = { calories: CTX.plan.calories, carbs: CTX.plan.macros.carbs, protein: CTX.plan.macros.protein, fat: CTX.plan.macros.fat };
    const remaining = {
      kcal: Math.max(0, Math.round(tg.calories - consumed.kcal)),
      carbs: Math.max(0, Math.round(tg.carbs - consumed.carbs)),
      protein: Math.max(0, Math.round(tg.protein - consumed.protein)),
      fat: Math.max(0, Math.round(tg.fat - consumed.fat)),
    };
    const s = CTX.session;
    const rd = readiness(s, consumed, tg);
    const timeline = buildTimeline(meals, s, remaining);

    const sessionLine = s && s.type !== "rest"
      ? `${TYPE_LABEL[s.type]}${s.durationMin ? " · " + s.durationMin + " min" : ""}${s.startTime ? " · " + clock(at(s.startTime)) : ""}`
      : "No session planned today";

    root.innerHTML = `
      <div class="today-head">
        <div>
          <div class="today-date">${new Date().toLocaleDateString(undefined, { weekday: "long" })} · today</div>
          <div class="today-session"><span class="ts-ico">🏃</span>${esc(sessionLine)}</div>
        </div>
        <button class="btn-ghost" id="tPlan">${s && s.type !== "rest" ? "Edit" : "Plan"} session</button>
      </div>
      <div class="ready ${rd.ok ? "ok" : "warn"}">${esc(rd.text)}${s && HARD[s.type] ? " · carbs " + CTX.plan.carbBand.low + "–" + CTX.plan.carbBand.high + " g/kg" : ""}</div>

      <ul class="tline">
        ${timeline.map((e) => `<li class="tl ${e.state}">
          <span class="tl-ico">${ICON[e.icon] || "•"}</span>
          <div class="tl-body"><div class="tl-title">${esc(e.title)}</div><div class="tl-sub">${esc(e.sub)}</div></div>
        </li>`).join("")}
      </ul>

      <div class="rem-row">
        <div class="rem"><span>left today</span><b>${remaining.kcal}</b><small>kcal</small></div>
        <div class="rem"><span>carbs</span><b>${remaining.carbs}</b><small>g</small></div>
        <div class="rem"><span>protein</span><b>${remaining.protein}</b><small>g</small></div>
        <div class="rem"><span>fat</span><b>${remaining.fat}</b><small>g</small></div>
      </div>
      <div class="sg-bar"><button class="btn-suggest" id="tSuggest">✨ Suggest my next meal</button></div>
      <div id="tSuggestPanel"></div>
      <div id="tPlanForm"></div>`;

    root.querySelector("#tPlan").addEventListener("click", planForm);
    root.querySelector("#tSuggest").addEventListener("click", () => suggestMeal(remaining));
  }

  /* ---------- AI meal suggester (app computes, Claude composes) ---------- */
  async function suggestMeal(remaining) {
    const panel = root.querySelector("#tSuggestPanel");
    panel.innerHTML = `<div class="sg-loading">Composing a meal to fill the gap…</div>`;
    const h = new Date().getHours();
    const mealType = h < 10.5 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snack" : "dinner";
    const s = CTX.session;
    const body = {
      profileId: CTX.profileId, date: CTX.date, remaining, mealType,
      weightKg: CTX.user.weightKg,
      session: s ? { type: s.type, durationMin: s.durationMin } : null,
      prefs: CTX.user.notes || "",
      exclude: CTX.user.exclude || [],
    };
    try {
      const r = await fetch("/api/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || "error " + r.status);
      renderSuggestion(panel, res);
    } catch (e) {
      panel.innerHTML = `<div class="sg-err">${esc(e.message)}</div>`;
    }
  }

  function renderSuggestion(panel, res) {
    const t = res.totals || {}, tg = res.target || {};
    const items = (res.items || []).map((i) => `<div class="sg-item">
      <span class="sg-nm">${esc(i.name)}<small>${i.grams} g${i.source === "estimate" ? " · est." : ""}</small></span>
      <span class="sg-mac">${i.kcal} kcal · ${i.protein}p ${i.carbs}c ${i.fat}f</span>
      <button class="sg-ban" data-food="${esc(i.name)}" title="Never suggest this" aria-label="never suggest ${esc(i.name)}">🚫</button>
    </div>`).join("");
    panel.innerHTML = `<div class="sg-card">
      <div class="sg-head">✨ ${esc(res.meal || "Suggested meal")}</div>
      ${res.rationale ? `<div class="sg-why">${esc(res.rationale)}</div>` : ""}
      <div class="sg-items">${items}</div>
      <div class="sg-tot">
        <div><b>${Math.round(t.kcal || 0)}</b> kcal · ${Math.round(t.carbs || 0)}c · ${Math.round(t.protein || 0)}p · ${Math.round(t.fat || 0)}f</div>
        <div class="sg-target">fills your ${Math.round(tg.kcal || 0)} kcal · ${Math.round(tg.carbs || 0)}c · ${Math.round(tg.protein || 0)}p gap</div>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" id="sgAgain">Try again</button>
        <button class="btn-ghost" id="sgClose">Dismiss</button>
        <button class="btn-primary" id="sgLog">Log this meal</button>
      </div>
    </div>`;
    panel.querySelector("#sgClose").addEventListener("click", () => { panel.innerHTML = ""; });
    panel.querySelector("#sgAgain").addEventListener("click", () => suggestMeal(res.target));
    panel.querySelector("#sgLog").addEventListener("click", () => logSuggestion(res));
    panel.querySelectorAll(".sg-ban").forEach((b) => b.addEventListener("click", async () => {
      if (CTX.excludeFood) CTX.user.exclude = await CTX.excludeFood(b.dataset.food);
      suggestMeal(res.target);        // re-suggest without the banned food
    }));
  }

  async function logSuggestion(res) {
    const now = new Date().toISOString();
    for (const i of res.items || []) {
      const id = "f" + Math.random().toString(36).slice(2, 9);
      await fetch("/api/food/" + id, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id, profileId: CTX.profileId, date: CTX.date, time: now,
          name: i.name, barcode: "", per100: i.per100,
          unitGrams: i.grams, unitLabel: "serving", discrete: true, qty: 1,
          kcal: i.kcal, protein: i.protein, carbs: i.carbs, fat: i.fat,
        }),
      });
    }
    if (CTX.refresh) CTX.refresh();       // rebuild the whole dashboard with the new food
  }

  function planForm() {
    const s = CTX.session || {};
    const box = root.querySelector("#tPlanForm");
    box.innerHTML = `<div class="plan-form">
      <div class="pf-row">
        <label>Session
          <select id="pfType">${TYPES.map((t) => `<option value="${t}" ${s.type === t ? "selected" : ""}>${TYPE_LABEL[t]}</option>`).join("")}</select>
        </label>
        <label>Start time<input id="pfTime" type="time" value="${s.startTime || ""}"/></label>
        <label>Minutes<input id="pfDur" type="number" min="0" step="5" value="${s.durationMin || ""}"/></label>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" id="pfClear">Clear</button>
        <button class="btn-primary" id="pfSave">Save</button>
      </div>
    </div>`;
    box.querySelector("#pfSave").addEventListener("click", () => {
      const type = box.querySelector("#pfType").value;
      CTX.savePlan(type === "rest" ? null : {
        type, startTime: box.querySelector("#pfTime").value || "",
        durationMin: parseInt(box.querySelector("#pfDur").value, 10) || 0,
      });
    });
    box.querySelector("#pfClear").addEventListener("click", () => CTX.savePlan(null));
  }

  async function mount(container, ctx) {
    CTX = ctx; root = container;
    render(await api.logs());
  }

  return { mount };
})();
