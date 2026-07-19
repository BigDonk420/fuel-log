/*
 * app.js — store, training-data provider, and UI wiring.
 * No framework, no build step: classic scripts + localStorage.
 * Profiles are entered in US/imperial units; everything is stored in metric
 * internally (the science engine is metric) and displayed back in imperial.
 */
(function () {
  "use strict";

  /* ---------- unit conversions (imperial <-> metric) ---------- */
  const U = {
    lbsToKg: (l) => l * 0.453592,
    kgToLbs: (k) => k / 0.453592,
    inToCm: (i) => i * 2.54,
    cmToIn: (c) => c / 2.54,
    miToKm: (m) => m * 1.609344,
    mlToOz: (m) => m / 29.5735,
  };
  function cmToFtIn(cm) {
    const totIn = U.cmToIn(cm);
    let ft = Math.floor(totIn / 12);
    let inch = Math.round(totIn - ft * 12);
    if (inch === 12) { ft += 1; inch = 0; }
    return { ft, inch };
  }
  function ageFromBirth(bd) {
    if (!bd) return null;
    const d = new Date(bd + "T00:00:00");
    const n = new Date();
    let a = n.getFullYear() - d.getFullYear();
    const m = n.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && n.getDate() < d.getDate())) a--;
    return a;
  }
  // A model-ready copy of a user: metric fields + a freshly computed age.
  function decorate(user) {
    return Object.assign({}, user, { age: ageFromBirth(user.birthDate) || 30 });
  }

  /* ---------- store: profiles live in SQLite via the /api, shared across
   * devices. An in-memory cache (PROFILES) keeps UI reads synchronous; writes
   * update the cache optimistically and persist to the server. Only "which
   * profile is selected" stays device-local (localStorage). No passwords. */
  const KEY_CURRENT = "nutri.currentUserId";
  let PROFILES = [];
  const API = {
    async list() {
      const r = await fetch("/api/profiles");
      if (!r.ok) { const e = new Error("load " + r.status); e.status = r.status; throw e; }
      return r.json();
    },
    async save(u) {
      const r = await fetch("/api/profiles/" + u.id, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u),
      });
      if (!r.ok) throw new Error("save " + r.status);
      return r.json();
    },
    async remove(id) {
      const r = await fetch("/api/profiles/" + id, { method: "DELETE" });
      if (!r.ok) throw new Error("delete " + r.status);
    },
  };
  const Store = {
    users() { return PROFILES; },
    async reload() { PROFILES = await API.list(); },
    async upsert(user) {
      const i = PROFILES.findIndex((u) => u.id === user.id);
      if (i >= 0) PROFILES[i] = user; else PROFILES.push(user);
      await API.save(user);
    },
    async remove(id) {
      PROFILES = PROFILES.filter((u) => u.id !== id);
      if (Store.currentId() === id) localStorage.removeItem(KEY_CURRENT);
      await API.remove(id);
    },
    currentId() { return localStorage.getItem(KEY_CURRENT); },
    setCurrent(id) { localStorage.setItem(KEY_CURRENT, id); },
    current() {
      const id = Store.currentId();
      return PROFILES.find((u) => u.id === id) || PROFILES[0] || null;
    },
  };

  /* ---------- training-data provider ----------
   * Real intervals.icu data flows through the local proxy in server.py
   * (browsers can't call intervals.icu directly — CORS). We pull the trailing
   * 7 days of actual activities; if no key/athlete or the call fails, we fall
   * back to a realistic sample week so the app always works.
   */
  const MICROCYCLE = {
    0: { type: "easy", durationMin: 50, label: "Sun" },
    1: { type: "rest", durationMin: 0, label: "Mon" },
    2: { type: "easy", durationMin: 45, label: "Tue" },
    3: { type: "tempo", durationMin: 60, label: "Wed" },
    4: { type: "easy", durationMin: 40, label: "Thu" },
    5: { type: "recovery", durationMin: 30, label: "Fri" },
    6: { type: "long", durationMin: 110, label: "Sat" },
  };
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function eeeFor(session, weightKg) {
    const perMin = { rest: 0, recovery: 8, easy: 10, tempo: 13, quality: 13, long: 11, race: 12 };
    return Math.round((perMin[session.type] || 0) * session.durationMin * (weightKg / 70));
  }
  function tssFor(session) {
    const perMin = { rest: 0, recovery: 0.6, easy: 0.8, tempo: 1.4, quality: 1.5, long: 1.0, race: 1.6 };
    return Math.round((perMin[session.type] || 0) * session.durationMin);
  }
  // Trailing 7 days ending today.
  function windowDates() {
    const out = [];
    const today = new Date();
    for (let off = -6; off <= 0; off++) {
      const d = new Date(today);
      d.setDate(today.getDate() + off);
      out.push(d);
    }
    return out;
  }
  function sampleWeek(user) {
    return windowDates().map((d) => {
      const s = MICROCYCLE[d.getDay()];
      return {
        date: d.toISOString().slice(0, 10),
        type: s.type, durationMin: s.durationMin, label: s.label,
        eeeKcal: eeeFor(s, user.weightKg), tss: tssFor(s),
        isToday: d.toISOString().slice(0, 10) === todayKey(),
      };
    });
  }
  // Classify a real training day into our band/sweat categories.
  function classify(dur, tss) {
    if (!dur) return "rest";
    if (dur >= 90) return "long";
    const ratio = tss / Math.max(dur, 1);
    if (ratio >= 1.2) return "tempo";
    if (dur <= 30) return "recovery";
    return "easy";
  }
  function buildDaysFromActivities(acts, user) {
    const byDate = {};
    (acts || []).forEach((a) => {
      const key = (a.start_date_local || a.start_date || "").slice(0, 10);
      if (!key) return;
      const b = (byDate[key] = byDate[key] || { sec: 0, load: 0, cal: 0 });
      b.sec += a.moving_time || a.elapsed_time || 0;
      b.load += a.icu_training_load || a.training_load || 0;
      b.cal += a.calories || 0;
    });
    return windowDates().map((d) => {
      const date = d.toISOString().slice(0, 10);
      const b = byDate[date] || { sec: 0, load: 0, cal: 0 };
      const durationMin = Math.round(b.sec / 60);
      const tss = Math.round(b.load);
      return {
        date, durationMin, tss, eeeKcal: Math.round(b.cal),
        type: classify(durationMin, tss), label: DOW[d.getDay()],
        isToday: date === todayKey(),
      };
    });
  }

  const Provider = {
    async getWeek(user) {
      const dates = windowDates();
      const oldest = dates[0].toISOString().slice(0, 10);
      const newest = dates[dates.length - 1].toISOString().slice(0, 10);
      if (user.intervalsApiKey && user.intervalsAthleteId) {
        try {
          const res = await fetch(
            `/intervals/activities?athlete=${encodeURIComponent(user.intervalsAthleteId)}&oldest=${oldest}&newest=${newest}`,
            { headers: { "X-Intervals-Key": user.intervalsApiKey } }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "proxy " + res.status);
          }
          const acts = await res.json();
          return { source: "intervals.icu (live)", days: buildDaysFromActivities(acts, user) };
        } catch (e) {
          return { source: "sample — live import failed: " + (e.message || "error"), days: sampleWeek(user) };
        }
      }
      return { source: "sample week (add your intervals.icu key + athlete ID for live data)", days: sampleWeek(user) };
    },
  };

  /* ---------- DOM helpers ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, html) => {
    const n = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (html != null) n.innerHTML = html;
    return n;
  };
  const uid = () => "u" + Math.random().toString(36).slice(2, 9);
  const todayKey = () => new Date().toISOString().slice(0, 10);

  /* ---------- onboarding / edit form ---------- */
  function raceRow(r) {
    r = r || {};
    return `<div class="race-row">
      <input class="r-name" placeholder="Race name" value="${r.name || ""}"/>
      <input class="r-date" type="date" value="${r.date || ""}"/>
      <input class="r-dist" type="number" step="0.1" placeholder="miles" value="${r.distanceMi || ""}"/>
      <select class="r-kind">
        ${["road", "trail", "track", "ultra"].map((k) => `<option ${r.kind === k ? "selected" : ""}>${k}</option>`).join("")}
      </select>
      <button type="button" class="btn-ghost r-del" aria-label="remove">✕</button>
    </div>`;
  }

  function renderForm(existing) {
    const u = existing || {};
    const g = u.goal || { type: "maintain" };
    const h = u.heightCm ? cmToFtIn(u.heightCm) : { ft: "", inch: "" };
    const lbs = u.weightKg != null ? Math.round(U.kgToLbs(u.weightKg) * 10) / 10 : "";
    const rateLb = g.rateKgPerWeek ? Math.round(U.kgToLbs(g.rateKgPerWeek) * 10) / 10 : "";
    const app = $("#app");
    app.innerHTML = `
      <div class="screen">
        <div class="onboard card">
          <h1>${existing ? "Edit profile" : "Welcome — set up your profile"}</h1>
          <p class="sub">Everything is used to tailor your fuelling. No password, nothing sensitive stored.</p>
          <form id="profileForm">
            <div class="grid2">
              <label>Name<input name="name" required value="${u.name || ""}"/></label>
              <label>Sex
                <select name="sex">
                  <option value="male" ${u.sex === "male" ? "selected" : ""}>Male</option>
                  <option value="female" ${u.sex === "female" ? "selected" : ""}>Female</option>
                </select>
              </label>
              <label>Birthdate<input name="birthDate" type="date" required value="${u.birthDate || ""}"/></label>
              <label>Height
                <div class="ht-row">
                  <input name="ft" type="number" min="3" max="8" placeholder="ft" required value="${h.ft}"/>
                  <input name="inch" type="number" min="0" max="11" placeholder="in" required value="${h.inch}"/>
                </div>
              </label>
              <label>Weight (lb)<input name="weightLb" type="number" step="0.1" min="70" max="450" required value="${lbs}"/></label>
              <label>Body fat % <span class="hint">optional</span><input name="bodyFatPct" type="number" step="0.1" min="4" max="50" value="${u.bodyFatPct != null ? u.bodyFatPct : ""}"/></label>
            </div>

            <fieldset>
              <legend>Goal</legend>
              <div class="grid2">
                <label>Weight goal
                  <select name="goalType">
                    <option value="maintain" ${g.type === "maintain" ? "selected" : ""}>Maintain</option>
                    <option value="lose" ${g.type === "lose" ? "selected" : ""}>Lose weight</option>
                    <option value="gain" ${g.type === "gain" ? "selected" : ""}>Gain weight</option>
                  </select>
                </label>
                <label>Rate (lb / week) <span class="hint">if losing</span>
                  <input name="rateLb" type="number" step="0.1" min="0" max="2" value="${rateLb}"/></label>
              </div>
            </fieldset>

            <fieldset>
              <legend>Upcoming races</legend>
              <div id="races">${(u.races || []).map(raceRow).join("")}</div>
              <button type="button" class="btn-ghost" id="addRace">+ Add race</button>
            </fieldset>

            <fieldset>
              <legend>intervals.icu — live training data</legend>
              <div class="grid2">
                <label>API key <span class="hint">Settings → Developer on intervals.icu</span>
                  <input name="intervalsApiKey" value="${u.intervalsApiKey || ""}"/></label>
                <label>Athlete ID <span class="hint">e.g. i123456, from your intervals URL</span>
                  <input name="intervalsAthleteId" value="${u.intervalsAthleteId || ""}"/></label>
              </div>
              <label>Notes / anything else the model should know
                <textarea name="notes" rows="2">${u.notes || ""}</textarea></label>
            </fieldset>

            <div class="form-actions">
              ${existing ? '<button type="button" class="btn-ghost" id="cancelEdit">Cancel</button>' : ""}
              <button type="submit" class="btn-primary">${existing ? "Save" : "Create profile"}</button>
            </div>
          </form>
        </div>
      </div>`;

    $("#addRace").addEventListener("click", () => $("#races").insertAdjacentHTML("beforeend", raceRow()));
    app.addEventListener("click", (e) => {
      if (e.target.classList.contains("r-del")) e.target.closest(".race-row").remove();
    });
    if (existing) $("#cancelEdit").addEventListener("click", () => renderDashboard());

    $("#profileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const races = [...$("#races").querySelectorAll(".race-row")]
        .map((row) => ({
          name: $(".r-name", row).value.trim(),
          date: $(".r-date", row).value,
          distanceMi: parseFloat($(".r-dist", row).value) || null,
          kind: $(".r-kind", row).value,
        }))
        .filter((r) => r.name && r.date);
      const bf = parseFloat(f.bodyFatPct.value);
      const heightCm = U.inToCm(parseInt(f.ft.value, 10) * 12 + parseInt(f.inch.value || 0, 10));
      const user = {
        id: u.id || uid(),
        name: f.name.value.trim(),
        sex: f.sex.value,
        birthDate: f.birthDate.value,
        heightCm: Math.round(heightCm * 10) / 10,
        weightKg: Math.round(U.lbsToKg(parseFloat(f.weightLb.value)) * 10) / 10,
        bodyFatPct: isNaN(bf) ? null : bf,
        goal: { type: f.goalType.value, rateKgPerWeek: U.lbsToKg(parseFloat(f.rateLb.value) || 0.9) },
        races,
        intervalsApiKey: f.intervalsApiKey.value.trim(),
        intervalsAthleteId: f.intervalsAthleteId.value.trim(),
        notes: f.notes.value.trim(),
        water: u.water || {},
        createdAt: u.createdAt || Date.now(),
      };
      Store.setCurrent(user.id);
      try { await Store.upsert(user); } catch (err) { alert("Couldn't save profile: " + err.message); }
      renderDashboard();
    });
  }

  /* ---------- top bar with user switcher ---------- */
  function topBar(current) {
    const users = Store.users();
    const options = users
      .map((u) => `<option value="${u.id}" ${u.id === current.id ? "selected" : ""}>${u.name}</option>`)
      .join("");
    const bar = el("header", { class: "topbar" });
    bar.innerHTML = `
      <div class="brand"><span class="dot"></span> Fuel<span class="brand-2">Log</span></div>
      <div class="user-switch">
        <select id="userSelect" aria-label="switch user">${options}</select>
        <button class="btn-ghost" id="editUser" title="Edit profile">Edit</button>
        <button class="btn-ghost" id="newUser" title="New profile">+ New</button>
        <button class="btn-ghost danger" id="delUser" title="Delete profile">Delete</button>
      </div>`;
    bar.querySelector("#userSelect").addEventListener("change", (e) => { Store.setCurrent(e.target.value); renderDashboard(); });
    bar.querySelector("#newUser").addEventListener("click", () => renderForm(null));
    bar.querySelector("#editUser").addEventListener("click", () => renderForm(Store.current()));
    bar.querySelector("#delUser").addEventListener("click", async () => {
      if (confirm("Delete this profile?")) { await Store.remove(current.id); route(); }
    });
    return bar;
  }

  /* ---------- dashboard ---------- */
  function daysUntil(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return Math.ceil((d - new Date(todayKey() + "T00:00:00")) / 86400000);
  }
  function nextRace(user) {
    return (user.races || [])
      .filter((r) => daysUntil(r.date) >= 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  }
  function typeLabel(t) {
    return { rest: "Rest day", recovery: "Recovery", easy: "Easy run", tempo: "Tempo", quality: "Quality", long: "Long run", race: "Race" }[t] || t;
  }

  async function saveTodayPlan(session) {
    const u = Store.current();
    u.plans = u.plans || {};
    if (session) u.plans[todayKey()] = session;
    else delete u.plans[todayKey()];
    try { await Store.upsert(u); } catch (e) { console.error("plan save failed", e); }
    renderDashboard();
  }

  async function renderDashboard() {
    const stored = Store.current();
    if (!stored) return route();
    const user = decorate(stored);
    const { source, days } = await Provider.getWeek(user);
    const todayIdx = days.findIndex((d) => d.isToday);
    const idx = todayIdx >= 0 ? todayIdx : days.length - 1;

    // A manually planned session for today overrides the (currently empty)
    // intervals data, so targets, energy availability and the timeline all
    // reflect what you're about to do.
    const planned = stored.plans && stored.plans[todayKey()];
    if (planned && planned.type) {
      days[idx] = Object.assign({}, days[idx], {
        type: planned.type,
        durationMin: planned.durationMin || 0,
        startTime: planned.startTime || "",
        eeeKcal: eeeFor(planned, user.weightKg),
        tss: tssFor(planned),
      });
    }

    const weekPlans = days.map((d) => NutriModel.dayPlan(user, d));
    const plan = weekPlans[idx];
    const today = days[idx];
    const session = today.type && today.type !== "rest"
      ? { type: today.type, durationMin: today.durationMin, startTime: today.startTime || "" }
      : null;

    // 7-day rolling energy availability.
    const eaVals = weekPlans.map((p) => p.energyAvailability.value);
    const eaAvg = Math.round(eaVals.reduce((a, b) => a + b, 0) / eaVals.length);
    const eaZone = NutriModel.eaZone(eaAvg);

    const app = $("#app");
    app.innerHTML = "";
    app.appendChild(topBar(stored));
    const main = el("main", { class: "dash" });
    app.appendChild(main);

    const race = nextRace(user);
    const raceHtml = race
      ? `<div class="race-chip"><strong>${race.name}</strong> · ${race.distanceMi || "?"} mi ${race.kind} · <span class="cd">${daysUntil(race.date)} days</span></div>`
      : `<div class="race-chip muted">No upcoming race set</div>`;
    main.appendChild(
      el("div", { class: "dash-head" },
        `<div><h2>Hi ${stored.name.split(" ")[0]}</h2>
           <div class="src-note">Training data: ${source}</div></div>
         ${raceHtml}`)
    );

    // --- Today plan: the hero. What to do right now to fuel the work. ---
    const todayCard = el("div", { class: "card wide today-card" });
    main.appendChild(todayCard);
    window.TodayPlan.mount(todayCard, {
      user, plan, session, profileId: stored.id, date: todayKey(),
      savePlan: saveTodayPlan, refresh: renderDashboard,
    });

    // flags: model flags + rolling-EA flag on top
    // Only alarm when it's genuinely warranted: very low EA always, or a
    // dieter drifting low. Weight-stable athletes in the amber band aren't nagged.
    const flags = plan.flags.slice();
    const losing = stored.goal && stored.goal.type === "lose";
    if (eaZone.key === "danger")
      flags.unshift({ level: "danger", text: "7-day energy availability is very low (REDs risk) — increase intake before cutting further." });
    else if (losing && eaAvg < 40)
      flags.unshift({ level: "warn", text: "Energy availability is drifting low while dieting — consider easing the deficit." });
    if (flags.length) {
      const fl = el("div", { class: "flags" });
      flags.forEach((f) => fl.appendChild(el("div", { class: "flag " + f.level }, f.text)));
      main.appendChild(fl);
    }

    const row = el("div", { class: "card-row" });
    main.appendChild(row);

    // macros
    const mc = el("div", { class: "card" });
    mc.innerHTML = `<h3>Today's targets</h3>
      ${Charts.macroDonut(plan.macros, plan.calories)}
      <div class="macro-legend">
        <span><i class="sw carb"></i>Carbs <b>${plan.macros.carbs} g</b><small>${plan.macros.carbPerKg} g/kg · ${plan.carbBand.name}</small></span>
        <span><i class="sw protein"></i>Protein <b>${plan.macros.protein} g</b><small>${plan.macros.proteinPerKg} g/kg</small></span>
        <span><i class="sw fat"></i>Fat <b>${plan.macros.fat} g</b><small>remainder</small></span>
      </div>`;
    row.appendChild(mc);

    // energy availability (7-day rolling)
    const ffmLb = Math.round(U.kgToLbs(plan.ffm));
    const ea = el("div", { class: "card" });
    ea.innerHTML = `<h3>Energy availability · 7-day avg</h3>
      ${Charts.eaGauge(eaAvg)}
      <div class="ea-status ${eaZone.key}">${eaZone.label}</div>
      <div class="ea-detail">rolling avg over last 7 days · FFM ${ffmLb} lb · today burned ${plan.eee} kcal</div>`;
    row.appendChild(ea);

    // hydration (imperial: 8 oz glasses)
    const filled = (stored.water && stored.water[todayKey()]) || 0;
    const goal = plan.hydration.glasses;
    const oz = (ml) => Math.round(U.mlToOz(ml));
    const hy = el("div", { class: "card hydro-card" });
    hy.innerHTML = `<h3>Hydration</h3>
      ${Charts.hydrationRing(filled, goal)}
      <div class="glasses" id="glasses"></div>
      <div class="ea-detail">${oz(plan.hydration.totalMl)} oz goal · base ${oz(plan.hydration.baseMl)} + sweat ${oz(plan.hydration.sweatMl)} oz · 8 oz/glass</div>`;
    row.appendChild(hy);
    renderGlasses(hy.querySelector("#glasses"), stored, goal, hy);

    // week chart
    const weekDays = days.map((d, i) => ({
      label: d.label, load: d.tss, carbG: weekPlans[i].macros.carbs, isToday: d.isToday,
    }));
    const wk = el("div", { class: "card wide" });
    wk.innerHTML = `<h3>Last 7 days — training load <span class="lgd"><i class="sw bar"></i>load (TSS)</span> <span class="lgd"><i class="sw dot"></i>carb target (g)</span></h3>
      ${Charts.weekLoad(weekDays)}
      <p class="explain">Bars are each day's training stress; the dotted line is the carbohydrate target that flexes to match it — fuel for the work required.</p>`;
    main.appendChild(wk);

    // fuelling timing
    const dc = plan.duringCarb;
    const w = Math.round(user.weightKg);
    const tc = el("div", { class: "card wide" });
    tc.innerHTML = `<h3>Fuelling around today's session</h3>
      <div class="timing">
        <div class="t-col"><span class="t-h">Before</span><p>1–4 g/kg carbs, 1–4 h prior (${w}–${w * 2} g).</p></div>
        <div class="t-col"><span class="t-h">During</span><p>${dc ? `${dc.low}–${dc.high} g/h${dc.ceiling ? ` (up to ${dc.ceiling} if gut-trained)` : ""} — ${dc.note}.` : "Not needed for sessions under ~60 min."}</p></div>
        <div class="t-col"><span class="t-h">After</span><p>~0.3 g/kg protein (${Math.round(user.weightKg * 0.3)} g) + carbs; refuel faster only if training again within 8 h.</p></div>
      </div>
      <div class="micro">Iron: aim ${plan.iron.mgPerDay} mg/day, ferritin ≥ ${plan.iron.ferritinTarget} ng/mL${plan.iron.female ? " (screen each season; take iron in the morning, away from the 3–6 h post-run window)." : "."}</div>`;
    main.appendChild(tc);

    // food logging — targets vs. what's actually been eaten today
    const foodCard = el("div", { class: "card wide" });
    main.appendChild(foodCard);
    window.FoodLog.mount(foodCard, {
      profileId: stored.id,
      date: todayKey(),
      target: { calories: plan.calories, protein: plan.macros.protein, carbs: plan.macros.carbs, fat: plan.macros.fat },
    });

    // floating scan button (CSS shows it on mobile only) — the phone's main job
    // is logging food, so keep it one tap away from anywhere on the page
    const fab = el("button", { class: "fab", "aria-label": "Scan a barcode" }, "▣");
    fab.addEventListener("click", () => window.FoodLog.openScanner());
    app.appendChild(fab);
  }

  function renderGlasses(container, storedUser, goal, card) {
    const filled = (storedUser.water && storedUser.water[todayKey()]) || 0;
    container.innerHTML = "";
    for (let i = 0; i < goal; i++) {
      const g = el("button", { class: "glass" + (i < filled ? " on" : ""), "aria-label": "glass " + (i + 1) }, "");
      g.addEventListener("click", () => {
        const cur = (storedUser.water && storedUser.water[todayKey()]) || 0;
        const next = i < cur ? i : i + 1;
        storedUser.water = storedUser.water || {};
        storedUser.water[todayKey()] = next;
        Store.upsert(storedUser).catch((e) => console.error("water save failed", e));
        card.querySelector(".chart-hydro").outerHTML = Charts.hydrationRing(next, goal);
        renderGlasses(container, storedUser, goal, card);
      });
      container.appendChild(g);
    }
  }

  /* ---------- PIN gate ---------- */
  function renderUnlock(msg) {
    $("#app").innerHTML = `<div class="screen">
      <div class="onboard card unlock">
        <div class="brand big"><span class="dot"></span> Fuel<span class="brand-2">Log</span></div>
        <p class="sub">Enter the access PIN to continue.</p>
        <form id="pinForm">
          <input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off"
                 class="pin-input" placeholder="• • •" aria-label="access PIN"/>
          <div class="form-actions"><button type="submit" class="btn-primary">Unlock</button></div>
          ${msg ? `<div class="pin-msg">${msg}</div>` : ""}
        </form>
      </div></div>`;
    const input = $("#pinForm").pin;
    input.focus();
    $("#pinForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await fetch("/api/unlock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: input.value.trim() }),
      });
      if (r.ok) return boot();
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        return renderUnlock("Too many attempts — try again in " + Math.ceil((j.retry_after || 60) / 60) + " min.");
      }
      renderUnlock("Wrong PIN. Try again.");
    });
  }

  /* ---------- routing ---------- */
  function route() {
    if (!Store.users().length) return renderForm(null);
    if (!Store.current()) Store.setCurrent(Store.users()[0].id);
    renderDashboard();
  }

  async function boot() {
    try {
      await Store.reload();
    } catch (e) {
      if (e.status === 401) return renderUnlock();
      $("#app").innerHTML = `<div class="screen"><div class="onboard card">
        <h1>Can't reach the server</h1>
        <p class="sub">The app couldn't load profiles from the API (${e.message}). Make sure the FuelLog server is running, then reload.</p>
      </div></div>`;
      return;
    }
    route();
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
