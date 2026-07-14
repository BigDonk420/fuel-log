/*
 * food.js — food logging.
 *
 * Lookups go through the SERVER (/api/lookup, /api/search), which runs the
 * chain: your local corrections -> USDA FoodData Central -> Open Food Facts.
 * That means once you fix a bad entry, every future scan of that barcode is
 * corrected — for you and everyone on the app.
 *
 * The scanner is locked to UPC/EAN formats and requires two consistent reads
 * before accepting a code (unconstrained scanning produced misreads).
 */
window.FoodLog = (function () {
  "use strict";

  const uid = () => "f" + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const num = (v) => Math.max(0, parseFloat(v) || 0);

  let CTX = null;   // { profileId, date, target }
  let LOGS = [];
  let root = null;

  /* ---------- barcode validation ----------
   * Misreads are the enemy: a UPC-E symbol decoded as EAN-8 yields a code that
   * is WRONG but still passes an EAN-8 checksum, so "read it twice" can't catch
   * it. We therefore validate every scan as UPC-E / UPC-A / EAN-13 and reject
   * anything whose check digit doesn't hold. (EAN-8 is not used on US retail
   * products and is deliberately not accepted.)
   */
  function upcaCheckDigit(d11) {
    let odd = 0, even = 0;
    for (let i = 0; i < 11; i++) (i % 2 === 0 ? (odd += +d11[i]) : (even += +d11[i]));
    return (10 - (odd * 3 + even) % 10) % 10;
  }
  function ean13CheckDigit(d12) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += +d12[i] * (i % 2 === 0 ? 1 : 3);
    return (10 - s % 10) % 10;
  }
  function expandUpce(d8) {
    const n = d8[0], x = d8.slice(1, 7);
    // Number system MUST be 0. UPC-E technically allows 1, but it is
    // essentially unused on US retail goods — and "1" was the signature of
    // every misread we saw (14776649, 16901223) while the real Diet Mt Dew
    // code is 01216606. Rejecting 1 kills those without losing real products.
    if (n !== "0") return null;
    const last = x[5];
    let body;
    if ("012".includes(last)) body = n + x[0] + x[1] + last + "0000" + x[2] + x[3] + x[4];
    else if (last === "3") body = n + x[0] + x[1] + x[2] + "00000" + x[3] + x[4];
    else if (last === "4") body = n + x[0] + x[1] + x[2] + x[3] + "00000" + x[4];
    else body = n + x[0] + x[1] + x[2] + x[3] + x[4] + "0000" + last;
    return body + upcaCheckDigit(body);
  }
  function validBarcode(code) {
    const d = String(code || "").replace(/\D/g, "");
    if (d.length === 8) {                       // UPC-E: expand, then the UPC-A
      const e = expandUpce(d);                  // check digit must equal ours
      return !!e && e[11] === d[7];
    }
    if (d.length === 12) return upcaCheckDigit(d.slice(0, 11)) === +d[11];
    if (d.length === 13) return ean13CheckDigit(d.slice(0, 12)) === +d[12];
    return false;
  }

  /* ---------- api ---------- */
  const api = {
    async logs() {
      const r = await fetch(`/api/food?profile=${encodeURIComponent(CTX.profileId)}&date=${CTX.date}`);
      return r.ok ? r.json() : [];
    },
    saveLog: (e) => fetch("/api/food/" + e.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) }),
    delLog: (id) => fetch("/api/food/" + id, { method: "DELETE" }),
    async lookup(code) {
      const r = await fetch("/api/lookup?code=" + encodeURIComponent(code));
      return r.ok ? r.json() : null;
    },
    async search(q) {
      const r = await fetch("/api/search?q=" + encodeURIComponent(q));
      return r.ok ? r.json() : [];
    },
    saveFood: (f) => fetch("/api/foods/" + encodeURIComponent(f.barcode), {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f),
    }),
  };

  /* ---------- totals + main render ---------- */
  function totals() {
    return LOGS.reduce((t, e) => {
      t.kcal += e.kcal || 0; t.protein += e.protein || 0; t.carbs += e.carbs || 0; t.fat += e.fat || 0;
      return t;
    }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }
  function bar(label, have, target, cls) {
    const pct = target ? Math.min(100, Math.round((have / target) * 100)) : 0;
    return `<div class="fbar">
      <div class="fbar-top"><span>${label}</span><b>${Math.round(have)} / ${target}</b></div>
      <div class="fbar-track"><div class="fbar-fill ${cls}" style="width:${pct}%"></div></div>
    </div>`;
  }
  function render() {
    const t = totals(), tg = CTX.target;
    const items = LOGS.length
      ? LOGS.map((e) => `<li class="fitem">
          <span class="fi-name">${esc(e.name)}<small>${e.grams} g</small></span>
          <span class="fi-macros">${e.kcal} kcal · ${e.protein}p ${e.carbs}c ${e.fat}f</span>
          <button class="fi-edit" data-id="${e.id}" aria-label="edit">✎</button>
          <button class="fi-del" data-id="${e.id}" aria-label="remove">✕</button>
        </li>`).join("")
      : `<li class="fitem empty">No food logged yet today.</li>`;

    root.innerHTML = `<h3>Today's food — vs targets</h3>
      <div class="fbars">
        ${bar("Calories", t.kcal, tg.calories, "f-cal")}
        ${bar("Carbs (g)", t.carbs, tg.carbs, "f-carb")}
        ${bar("Protein (g)", t.protein, tg.protein, "f-protein")}
        ${bar("Fat (g)", t.fat, tg.fat, "f-fat")}
      </div>
      <ul class="flist">${items}</ul>
      <div class="fadd">
        <button class="btn-primary" id="fScan"><i>▣</i> Scan barcode</button>
        <input id="fQuery" placeholder="Search food, or type a barcode number"/>
        <button class="btn-ghost" id="fLookup">Look up</button>
      </div>
      <div id="fResults"></div>`;

    root.querySelectorAll(".fi-del").forEach((b) => b.addEventListener("click", () => removeItem(b.dataset.id)));
    root.querySelectorAll(".fi-edit").forEach((b) => b.addEventListener("click", () => editLoggedItem(b.dataset.id)));
    root.querySelector("#fScan").addEventListener("click", openScanner);
    root.querySelector("#fLookup").addEventListener("click", runQuery);
    root.querySelector("#fQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });
  }
  const results = () => root.querySelector("#fResults");

  /* ---------- lookup / search ---------- */
  async function runQuery() {
    const q = root.querySelector("#fQuery").value.trim();
    if (!q) return;
    results().innerHTML = `<p class="explain">Searching…</p>`;
    if (/^\d{6,14}$/.test(q)) {
      const f = await api.lookup(q);
      if (f) return showPick(f);
      return notFound(q);
    }
    const list = await api.search(q);
    if (!list.length) return notFound(null);
    results().innerHTML = list.map((f, i) => `<div class="fresult">
        <div class="fr-info"><b>${esc(f.name)}</b><small>${esc(f.brand)} · ${f.per100.kcal} kcal/100g · ${f.source}</small></div>
        <button class="btn-ghost fr-pick" data-i="${i}">Add</button>
      </div>`).join("");
    results().querySelectorAll(".fr-pick").forEach((b) =>
      b.addEventListener("click", () => showPick(list[+b.dataset.i])));
  }

  function notFound(barcode) {
    results().innerHTML = `<div class="fpick">
      <p class="explain">No product found${barcode ? " for barcode " + esc(barcode) : ""}.</p>
      <div class="form-actions"><button class="btn-primary" id="fManual">Create it manually</button></div>
    </div>`;
    results().querySelector("#fManual").addEventListener("click", () =>
      showEditor({ barcode: barcode || "custom-" + uid(), name: "", brand: "", per100: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, servings: [{ label: "100 g", grams: 100 }] }));
  }

  /* ---------- the add panel ---------- */
  function showPick(food) {
    const def = (food.servings && food.servings[0]) || { grams: 100 };
    const m = food.per100;
    const badge = food.source === "local" ? `<span class="fsrc local">your correction</span>`
      : `<span class="fsrc">${esc(food.source)}</span>`;
    results().innerHTML = `<div class="fpick">
      <div class="fpick-head"><b>${esc(food.name)}</b> ${badge}
        <button class="btn-ghost" id="fEdit">✎ Edit</button></div>
      <small>${esc(food.brand)} · ${m.kcal} kcal/100g</small>
      <div class="fpick-row">
        <label>Amount (g)<input id="fGrams" type="number" min="1" value="${def.grams}"/></label>
        <div class="fpick-macros" id="fPickMacros"></div>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" id="fCancel">Cancel</button>
        <button class="btn-primary" id="fConfirm">Add to today</button>
      </div>
    </div>`;
    const gi = results().querySelector("#fGrams");
    const paint = () => {
      const s = num(gi.value) / 100;
      results().querySelector("#fPickMacros").textContent =
        `${Math.round(m.kcal * s)} kcal · ${Math.round(m.protein * s)}p ${Math.round(m.carbs * s)}c ${Math.round(m.fat * s)}f`;
    };
    gi.addEventListener("input", paint); paint();
    results().querySelector("#fEdit").addEventListener("click", () => showEditor(food));
    results().querySelector("#fCancel").addEventListener("click", () => { results().innerHTML = ""; });
    results().querySelector("#fConfirm").addEventListener("click", () => {
      const grams = num(gi.value), s = grams / 100;
      addEntry({
        id: uid(), profileId: CTX.profileId, date: CTX.date, time: new Date().toISOString(),
        name: food.name, barcode: food.barcode || "", grams: Math.round(grams),
        kcal: Math.round(m.kcal * s), protein: Math.round(m.protein * s),
        carbs: Math.round(m.carbs * s), fat: Math.round(m.fat * s),
      });
      results().innerHTML = "";
    });
  }

  /* ---------- editor: fix a food, permanently ---------- */
  function showEditor(food) {
    const m = food.per100 || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    results().innerHTML = `<div class="fpick">
      <b>Edit food — saved corrections apply to all future scans</b>
      <div class="fedit-grid">
        <label>Name<input id="eName" value="${esc(food.name)}"/></label>
        <label>Brand<input id="eBrand" value="${esc(food.brand || "")}"/></label>
        <label>Calories /100g<input id="eKcal" type="number" min="0" value="${m.kcal}"/></label>
        <label>Protein /100g<input id="eP" type="number" min="0" value="${m.protein}"/></label>
        <label>Carbs /100g<input id="eC" type="number" min="0" value="${m.carbs}"/></label>
        <label>Fat /100g<input id="eF" type="number" min="0" value="${m.fat}"/></label>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" id="eCancel">Cancel</button>
        <button class="btn-primary" id="eSave">Save correction</button>
      </div>
    </div>`;
    results().querySelector("#eCancel").addEventListener("click", () => showPick(food));
    results().querySelector("#eSave").addEventListener("click", async () => {
      const fixed = {
        barcode: food.barcode,
        name: results().querySelector("#eName").value.trim() || food.name,
        brand: results().querySelector("#eBrand").value.trim(),
        per100: {
          kcal: num(results().querySelector("#eKcal").value),
          protein: num(results().querySelector("#eP").value),
          carbs: num(results().querySelector("#eC").value),
          fat: num(results().querySelector("#eF").value),
        },
        servings: food.servings || [{ label: "100 g", grams: 100 }],
        source: "local",
      };
      await api.saveFood(fixed);
      showPick(fixed);
    });
  }

  /* ---------- edit an already-logged item ---------- */
  function editLoggedItem(id) {
    const e = LOGS.find((x) => x.id === id);
    if (!e) return;
    results().innerHTML = `<div class="fpick">
      <b>Edit logged item</b>
      <div class="fedit-grid">
        <label>Name<input id="lName" value="${esc(e.name)}"/></label>
        <label>Amount (g)<input id="lG" type="number" min="0" value="${e.grams}"/></label>
        <label>Calories<input id="lKcal" type="number" min="0" value="${e.kcal}"/></label>
        <label>Protein<input id="lP" type="number" min="0" value="${e.protein}"/></label>
        <label>Carbs<input id="lC" type="number" min="0" value="${e.carbs}"/></label>
        <label>Fat<input id="lF" type="number" min="0" value="${e.fat}"/></label>
      </div>
      ${e.barcode ? `<label class="fchk"><input type="checkbox" id="lFix" checked/> Also save as a permanent correction for this barcode</label>` : ""}
      <div class="form-actions">
        <button class="btn-ghost" id="lCancel">Cancel</button>
        <button class="btn-primary" id="lSave">Save</button>
      </div>
    </div>`;
    results().querySelector("#lCancel").addEventListener("click", () => { results().innerHTML = ""; });
    results().querySelector("#lSave").addEventListener("click", async () => {
      const q = (sel) => results().querySelector(sel);
      e.name = q("#lName").value.trim() || e.name;
      e.grams = Math.round(num(q("#lG").value));
      e.kcal = Math.round(num(q("#lKcal").value));
      e.protein = Math.round(num(q("#lP").value));
      e.carbs = Math.round(num(q("#lC").value));
      e.fat = Math.round(num(q("#lF").value));
      api.saveLog(e).catch((err) => console.error(err));
      // propagate back to the food database so future scans are right
      const fix = q("#lFix");
      if (fix && fix.checked && e.barcode && e.grams > 0) {
        const s = 100 / e.grams;
        await api.saveFood({
          barcode: e.barcode, name: e.name, brand: "",
          per100: {
            kcal: Math.round(e.kcal * s), protein: Math.round(e.protein * s),
            carbs: Math.round(e.carbs * s), fat: Math.round(e.fat * s),
          },
          servings: [{ label: `${e.grams} g`, grams: e.grams }, { label: "100 g", grams: 100 }],
          source: "local",
        });
      }
      results().innerHTML = "";
      render();
    });
  }

  async function addEntry(entry) {
    LOGS.push(entry); render();
    api.saveLog(entry).catch((e) => console.error("food save failed", e));
  }
  async function removeItem(id) {
    LOGS = LOGS.filter((e) => e.id !== id); render();
    api.delLog(id).catch((e) => console.error("food delete failed", e));
  }

  /* ---------- scanner ---------- */
  function openScanner() {
    if (typeof Html5Qrcode === "undefined") {
      alert("Scanner didn't load. Use search or type the barcode number instead.");
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "scan-overlay";
    overlay.innerHTML = `<div class="scan-box">
      <div class="scan-head"><span>Point at a barcode</span><button id="scanClose" class="btn-ghost">✕</button></div>
      <div id="reader"></div>
      <div class="scan-msg" id="scanMsg">Hold steady…</div>
    </div>`;
    document.body.appendChild(overlay);

    // ONLY these three. EAN_8 is deliberately excluded: a UPC-E symbol decodes
    // as a checksum-valid but completely wrong EAN-8, which is exactly how a
    // Diet Mt Dew can read as "16901223". US retail doesn't use EAN-8 anyway.
    const F = window.Html5QrcodeSupportedFormats;
    const formats = F ? [F.UPC_A, F.UPC_E, F.EAN_13] : undefined;
    const scanner = new Html5Qrcode("reader", formats ? { formatsToSupport: formats } : undefined);

    let last = null, done = false, rejects = 0;
    const msg = overlay.querySelector("#scanMsg");
    const close = async () => {
      try { await scanner.stop(); } catch (e) { /* already stopped */ }
      overlay.remove();
    };
    overlay.querySelector("#scanClose").addEventListener("click", close);

    scanner.start(
      { facingMode: "environment" },
      {
        fps: 12,
        // wide, barcode-shaped window (a square QR box makes 1D codes slow to lock)
        qrbox: { width: 300, height: 120 },
        // high resolution + continuous autofocus: 1D barcodes need the detail
        videoConstraints: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" }],
        },
      },
      async (text) => {
        if (done) return;
        if (!validBarcode(text)) {          // reject misreads outright
          rejects++;
          msg.innerHTML = rejects < 6
            ? "Misread (" + text + ") — hold steady…"
            : `Struggling to read this one.<br/>Close and type the digits printed under the barcode.`;
          last = null;
          return;
        }
        if (text !== last) { last = text; return; }   // same valid code twice
        done = true;
        msg.textContent = "Looking up " + text + "…";
        const food = await api.lookup(text);
        await close();
        if (food) showPick(food);
        else { root.querySelector("#fQuery").value = text; notFound(text); }
      },
      () => {}
    ).catch((err) => {
      msg.textContent = "Camera error: " + err;
    });
  }

  async function mount(container, ctx) {
    CTX = ctx; root = container;
    LOGS = await api.logs();
    render();
  }

  return { mount };
})();
