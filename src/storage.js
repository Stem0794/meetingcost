/**
 * Shared storage + formatting helpers.
 *
 * This file is loaded both as a content script (before content.js) and via a
 * <script> tag on the options/popup pages, so it exposes everything on a single
 * global namespace (`MC`) rather than using ES modules.
 *
 * Data shape stored in chrome.storage.local:
 *   {
 *     settings: {
 *       enabled: boolean,
 *       currency: string,            // e.g. "$"
 *       currencyPosition: "before" | "after",
 *       defaultRate: number,         // used for attendees without a known rate (0 = ignore)
 *       everhourApiKey: string,
 *       everhourRateType: "cost" | "rate",  // which Everhour field to use
 *       lastSync: number | null      // epoch ms of last Everhour sync
 *     },
 *     rates: {
 *       "email@example.com": { name: string, rate: number, source: "manual" | "everhour" }
 *     }
 *   }
 */
(function (root) {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    currency: "$",
    currencyPosition: "before",
    defaultRate: 0,
    everhourApiKey: "",
    everhourRateType: "cost",
    lastSync: null,
  };

  const MC = {
    DEFAULT_SETTINGS,

    /** Read the whole store, merged with defaults. */
    async getAll() {
      const data = await chrome.storage.local.get(["settings", "rates"]);
      return {
        settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
        rates: data.rates || {},
      };
    },

    async getSettings() {
      return (await this.getAll()).settings;
    },

    async saveSettings(settings) {
      const current = await this.getSettings();
      await chrome.storage.local.set({
        settings: Object.assign({}, current, settings),
      });
    },

    async getRates() {
      return (await this.getAll()).rates;
    },

    async saveRates(rates) {
      await chrome.storage.local.set({ rates });
    },

    /**
     * Resolve an hourly rate for an attendee.
     * Matches by email first, then by (case-insensitive) name, then falls back
     * to the configured default rate. Returns a number or null if unknown.
     */
    resolveRate(rates, settings, { email, name }) {
      if (email) {
        const key = email.trim().toLowerCase();
        if (rates[key] && typeof rates[key].rate === "number") {
          return rates[key].rate;
        }
      }
      if (name) {
        const wanted = name.trim().toLowerCase();
        for (const entry of Object.values(rates)) {
          if (entry.name && entry.name.trim().toLowerCase() === wanted) {
            return entry.rate;
          }
        }
      }
      if (settings.defaultRate && settings.defaultRate > 0) {
        return settings.defaultRate;
      }
      return null;
    },

    /** Format a money amount with a fixed number of decimals (default 2). */
    formatMoney(amount, settings, decimals = 2) {
      const s = settings || DEFAULT_SETTINGS;
      const value = Number(amount).toFixed(decimals);
      return s.currencyPosition === "after"
        ? `${value}${s.currency}`
        : `${s.currency}${value}`;
    },

    /** Format an hourly rate, trimming trailing zeros (e.g. 84.30 -> "$84.3"). */
    formatRate(amount, settings) {
      const s = settings || DEFAULT_SETTINGS;
      let value = Number(amount).toFixed(2);
      value = value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
      return s.currencyPosition === "after"
        ? `${value}${s.currency}`
        : `${s.currency}${value}`;
    },
  };

  root.MC = MC;
})(typeof self !== "undefined" ? self : this);
