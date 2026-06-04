/* Options page logic: load/save settings, edit the rates table, sync Everhour. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $("enabled"),
    currency: $("currency"),
    currencyPosition: $("currencyPosition"),
    defaultRate: $("defaultRate"),
    emailThreshold: $("emailThreshold"),
    everhourApiKey: $("everhourApiKey"),
    everhourRateType: $("everhourRateType"),
    syncEverhour: $("syncEverhour"),
    everhourStatus: $("everhourStatus"),
    addRow: $("addRow"),
    ratesBody: $("ratesBody"),
    ratesEmpty: $("ratesEmpty"),
    save: $("save"),
    saveStatus: $("saveStatus"),
  };

  function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  /* ----------------------------- rates table ----------------------------- */

  function addRateRow(email = "", name = "", rate = "", source = "manual") {
    const tr = document.createElement("tr");
    tr.dataset.source = source;

    const mkInput = (value, type, ph) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = type;
      input.value = value;
      if (ph) input.placeholder = ph;
      if (type === "number") {
        input.min = "0";
        input.step = "0.01";
      }
      td.appendChild(input);
      tr.appendChild(td);
      return input;
    };

    mkInput(email, "text", "email@company.com").classList.add("col-email");
    mkInput(name, "text", "Full name").classList.add("col-name");
    mkInput(rate, "number", "0.00").classList.add("col-rate");

    const srcTd = document.createElement("td");
    srcTd.className = "src";
    srcTd.textContent = source;
    tr.appendChild(srcTd);

    const delTd = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn link";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      tr.remove();
      updateEmpty();
    });
    delTd.appendChild(del);
    tr.appendChild(delTd);

    els.ratesBody.appendChild(tr);
    updateEmpty();
    return tr;
  }

  function updateEmpty() {
    els.ratesEmpty.style.display = els.ratesBody.children.length
      ? "none"
      : "block";
  }

  function readRatesFromTable() {
    const rates = {};
    for (const tr of els.ratesBody.children) {
      const email = tr.querySelector(".col-email").value.trim().toLowerCase();
      const name = tr.querySelector(".col-name").value.trim();
      const rateVal = tr.querySelector(".col-rate").value;
      if (!email) continue;
      const rate = parseFloat(rateVal);
      if (Number.isNaN(rate)) continue;
      rates[email] = { name, rate, source: tr.dataset.source || "manual" };
    }
    return rates;
  }

  function renderRates(rates) {
    els.ratesBody.innerHTML = "";
    const emails = Object.keys(rates).sort();
    for (const email of emails) {
      const r = rates[email];
      addRateRow(email, r.name || "", r.rate, r.source || "manual");
    }
    updateEmpty();
  }

  /* ------------------------------- Everhour ------------------------------ */

  function syncEverhour() {
    const apiKey = els.everhourApiKey.value.trim();
    if (!apiKey) {
      setStatus(els.everhourStatus, "Enter your API key first.", "err");
      return;
    }
    setStatus(els.everhourStatus, "Syncing…", null);
    els.syncEverhour.disabled = true;

    chrome.runtime.sendMessage({ type: "everhour:users", apiKey }, (resp) => {
      els.syncEverhour.disabled = false;
      if (chrome.runtime.lastError) {
        setStatus(els.everhourStatus, chrome.runtime.lastError.message, "err");
        return;
      }
      if (!resp || !resp.ok) {
        setStatus(els.everhourStatus, (resp && resp.error) || "Sync failed.", "err");
        return;
      }
      mergeEverhourUsers(resp.users);
    });
  }

  function mergeEverhourUsers(users) {
    const field = els.everhourRateType.value; // "cost" | "rate"
    const fieldLabel = field === "cost" ? "cost" : "bill";
    const existing = readRatesFromTable();
    let applied = 0;
    let missing = 0;

    for (const u of users) {
      if (!u.email) continue;
      const value = u[field];
      if (typeof value !== "number") {
        missing += 1;
        continue;
      }
      existing[u.email] = {
        name: u.name || (existing[u.email] && existing[u.email].name) || "",
        rate: value,
        source: "everhour",
      };
      applied += 1;
    }

    renderRates(existing);
    let msg = `Synced ${applied} ${applied === 1 ? "person" : "people"} from Everhour.`;
    if (missing) msg += ` ${missing} had no ${fieldLabel} rate set in Everhour.`;
    msg += " Remember to Save.";
    setStatus(els.everhourStatus, msg, "ok");
  }

  /* ------------------------------ load/save ------------------------------ */

  async function load() {
    const { settings, rates } = await MC.getAll();
    els.enabled.checked = settings.enabled;
    els.currency.value = settings.currency;
    els.currencyPosition.value = settings.currencyPosition;
    els.defaultRate.value = settings.defaultRate || "";
    els.emailThreshold.value = settings.emailThreshold || "";
    els.everhourApiKey.value = settings.everhourApiKey || "";
    els.everhourRateType.value = settings.everhourRateType || "rate";
    renderRates(rates);

    if (settings.lastSync) {
      const when = new Date(settings.lastSync).toLocaleString();
      setStatus(els.everhourStatus, `Last synced ${when}.`, null);
    }
  }

  async function save() {
    const settings = {
      enabled: els.enabled.checked,
      currency: els.currency.value.trim() || "$",
      currencyPosition: els.currencyPosition.value,
      defaultRate: parseFloat(els.defaultRate.value) || 0,
      emailThreshold: parseFloat(els.emailThreshold.value) || 0,
      everhourApiKey: els.everhourApiKey.value.trim(),
      everhourRateType: els.everhourRateType.value,
    };
    const hasEverhour = Object.values(readRatesFromTable()).some(
      (r) => r.source === "everhour"
    );
    if (hasEverhour) settings.lastSync = Date.now();

    await MC.saveSettings(settings);
    await MC.saveRates(readRatesFromTable());
    setStatus(els.saveStatus, "Saved.", "ok");
    setTimeout(() => setStatus(els.saveStatus, "", null), 2500);
  }

  /* ------------------------------- wire up ------------------------------- */

  els.addRow.addEventListener("click", () => {
    const tr = addRateRow();
    tr.querySelector(".col-email").focus();
  });
  els.syncEverhour.addEventListener("click", syncEverhour);
  els.save.addEventListener("click", save);

  load();
})();
