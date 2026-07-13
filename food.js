/*
 * food.js — food logging: Open Food Facts lookup/search, a barcode camera
 * scanner, and the "today's food vs. targets" panel. Persists to /api/food.
 *
 * Open Food Facts allows direct browser calls (CORS), so lookups need no proxy.
 * The camera scanner uses html5-qrcode (loaded in index.html), which decodes
 * EAN/UPC barcodes on iOS Safari and Android alike.
 */
window.FoodLog = (function () {
  "use strict";

  const OFF = "https://world.openfoodfacts.org";
  const uid = () => "f" + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  let CTX = null;      // { profileId, date, target: {calories, protein, carbs, fat} }
  let LOGS = [];
  let root = null;

  /* ---------- persistence ---------- */
  async function apiList() {
    const r = await fetch(`/api/food?profile=${encodeURIComponent(CTX.profileId)}&date=${CTX.date}`);
    return r.ok ? r.json() : [];
  }
  async function apiSave(entry) {
    await fetch("/api/food/" + entry.id, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry),
    });
  }
  async function apiDelete(id) {
    await fetch("/api/food/" + id, { method: "DELETE" });
  }

  /* ---------- Open Food Facts ---------- */
  async function lookupBarcode(code) {
    const r = await fetch(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,brands,nutriments,serving_size`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.status === 1 ? j.product : null;
  }
  async function search(q) {
    const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&json=1&page_size=15&fields=code,product_name,brands,nutriments,serving_size`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.products || []).filter((p) => p.product_name);
  }
  function per100(product) {
    const n = product.nutriments || {};
    const kcal = n["energy-kcal_100g"] != null ? n["energy-kcal_100g"]
      : n["energy_100g"] != null ? n["energy_100g"] / 4.184 : 0;
    return {
      kcal: Math.round(kcal),
      protein: Math.round(n["proteins_100g"] || 0),
      carbs: Math.round(n["carbohydrates_100g"] || 0),
      fat: Math.round(n["fat_100g"] || 0),
    };
  }
  function servingGrams(product) {
    const m = /([\d.]+)\s*g/i.exec(product.serving_size || "");
    return m ? Math.round(parseFloat(m[1])) : 100;
  }

  /* ---------- totals + render ---------- */
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
    const t = totals();
    const tg = CTX.target;
    const items = LOGS.length
      ? LOGS.map((e) => `<li class="fitem">
          <span class="fi-name">${esc(e.name)}<small>${e.grams} g</small></span>
          <span class="fi-macros">${e.kcal} kcal · ${e.protein}p ${e.carbs}c ${e.fat}f</span>
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

    root.querySelectorAll(".fi-del").forEach((b) =>
      b.addEventListener("click", () => removeItem(b.dataset.id)));
    root.querySelector("#fScan").addEventListener("click", openScanner);
    root.querySelector("#fLookup").addEventListener("click", runQuery);
    root.querySelector("#fQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });
  }

  async function runQuery() {
    const q = root.querySelector("#fQuery").value.trim();
    if (!q) return;
    const res = root.querySelector("#fResults");
    res.innerHTML = `<p class="explain">Searching…</p>`;
    if (/^\d{6,14}$/.test(q)) {
      const p = await lookupBarcode(q);
      return showResults(p ? [p] : [], "No product found for that barcode.");
    }
    showResults(await search(q), "No matches found.");
  }

  function showResults(products, emptyMsg) {
    const res = root.querySelector("#fResults");
    if (!products.length) { res.innerHTML = `<p class="explain">${emptyMsg}</p>`; return; }
    res.innerHTML = products.map((p, i) => {
      const m = per100(p);
      return `<div class="fresult" data-i="${i}">
        <div class="fr-info"><b>${esc(p.product_name)}</b><small>${esc(p.brands || "")} · ${m.kcal} kcal/100g</small></div>
        <button class="btn-ghost fr-pick" data-i="${i}">Add</button>
      </div>`;
    }).join("");
    res.querySelectorAll(".fr-pick").forEach((b) =>
      b.addEventListener("click", () => pickProduct(products[+b.dataset.i])));
  }

  function pickProduct(product) {
    const res = root.querySelector("#fResults");
    const g = servingGrams(product);
    const m = per100(product);
    res.innerHTML = `<div class="fpick">
      <b>${esc(product.product_name)}</b>
      <div class="fpick-row">
        <label>Amount (g)<input id="fGrams" type="number" value="${g}" min="1"/></label>
        <div class="fpick-macros" id="fPickMacros"></div>
      </div>
      <div class="form-actions">
        <button class="btn-ghost" id="fCancel">Cancel</button>
        <button class="btn-primary" id="fConfirm">Add to today</button>
      </div>
    </div>`;
    const gramsInput = res.querySelector("#fGrams");
    const macrosEl = res.querySelector("#fPickMacros");
    const paint = () => {
      const grams = parseFloat(gramsInput.value) || 0;
      const s = grams / 100;
      macrosEl.textContent = `${Math.round(m.kcal * s)} kcal · ${Math.round(m.protein * s)}p ${Math.round(m.carbs * s)}c ${Math.round(m.fat * s)}f`;
    };
    gramsInput.addEventListener("input", paint); paint();
    res.querySelector("#fCancel").addEventListener("click", () => { res.innerHTML = ""; });
    res.querySelector("#fConfirm").addEventListener("click", () => {
      const grams = parseFloat(gramsInput.value) || 0;
      const s = grams / 100;
      addEntry({
        id: uid(), profileId: CTX.profileId, date: CTX.date, time: new Date().toISOString(),
        name: product.product_name, barcode: product.code || "", grams: Math.round(grams),
        kcal: Math.round(m.kcal * s), protein: Math.round(m.protein * s),
        carbs: Math.round(m.carbs * s), fat: Math.round(m.fat * s),
      });
    });
  }

  async function addEntry(entry) {
    LOGS.push(entry);
    render();
    apiSave(entry).catch((e) => console.error("food save failed", e));
  }
  async function removeItem(id) {
    LOGS = LOGS.filter((e) => e.id !== id);
    render();
    apiDelete(id).catch((e) => console.error("food delete failed", e));
  }

  /* ---------- barcode scanner (html5-qrcode) ---------- */
  function openScanner() {
    if (typeof Html5Qrcode === "undefined") {
      alert("Scanner library didn't load. Use search or type the barcode number instead.");
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "scan-overlay";
    overlay.innerHTML = `<div class="scan-box">
      <div class="scan-head"><span>Point at a barcode</span><button id="scanClose" class="btn-ghost">✕</button></div>
      <div id="reader"></div>
      <div class="scan-msg" id="scanMsg"></div>
    </div>`;
    document.body.appendChild(overlay);
    const scanner = new Html5Qrcode("reader");
    const close = async () => {
      try { await scanner.stop(); } catch (e) { /* already stopped */ }
      overlay.remove();
    };
    overlay.querySelector("#scanClose").addEventListener("click", close);
    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 260, height: 160 } },
      async (text) => {
        overlay.querySelector("#scanMsg").textContent = "Looking up " + text + "…";
        const p = await lookupBarcode(text);
        await close();
        if (p) pickProduct(p);
        else { root.querySelector("#fQuery").value = text; showResults([], "No product found — try search instead."); }
      },
      () => {}
    ).catch((err) => {
      overlay.querySelector("#scanMsg").textContent = "Camera error: " + err;
    });
  }

  /* ---------- mount ---------- */
  async function mount(container, ctx) {
    CTX = ctx; root = container;
    LOGS = await apiList();
    render();
  }

  return { mount };
})();
