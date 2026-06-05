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
 *       domainWhitelist: string,     // comma/newline-separated allowed email domains
 *       defaultRate: number,         // used for attendees without a known rate (0 = ignore)
 *       emailThreshold: number,      // show "Send an Email Instead" at/above this cost (0 = always)
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
    domainWhitelist: "",
    defaultRate: 0,
    emailThreshold: 0,
    everhourApiKey: "",
    everhourRateType: "rate",
    lastSync: null,
  };

  const PUBLIC_SETTINGS_KEYS = [
    "enabled",
    "currency",
    "currencyPosition",
    "domainWhitelist",
    "defaultRate",
    "emailThreshold",
    "everhourRateType",
    "lastSync",
  ];

  const MC = {
    DEFAULT_SETTINGS,
    PUBLIC_SETTINGS_KEYS,

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

    sanitizeSettings(settings) {
      const merged = Object.assign({}, DEFAULT_SETTINGS, settings || {});
      const publicSettings = {};
      for (const key of PUBLIC_SETTINGS_KEYS) {
        publicSettings[key] = merged[key];
      }
      return publicSettings;
    },

    toPublicState(data) {
      const safeData = data || {};
      return {
        publicSettings: this.sanitizeSettings(safeData.settings),
        publicRates: safeData.rates || {},
      };
    },

    async getPublicData() {
      if (chrome.storage.session) {
        const data = await chrome.storage.session.get(["publicSettings", "publicRates"]);
        if (data.publicSettings || data.publicRates) {
          return {
            settings: Object.assign({}, DEFAULT_SETTINGS, data.publicSettings || {}),
            rates: data.publicRates || {},
          };
        }
      }

      const data = await this.getAll();
      return {
        settings: this.sanitizeSettings(data.settings),
        rates: data.rates,
      };
    },

    normalizeDomainList(raw) {
      return String(raw || "")
        .split(/[\s,;]+/)
        .map((domain) => domain.trim().toLowerCase().replace(/^@+/, ""))
        .filter(Boolean);
    },

    emailMatchesDomainWhitelist(email, settings) {
      const domains = this.normalizeDomainList(settings.domainWhitelist);
      if (domains.length === 0) return true;
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const atIndex = normalizedEmail.lastIndexOf("@");
      if (atIndex === -1) return false;
      const emailDomain = normalizedEmail.slice(atIndex + 1);
      return domains.some(
        (domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`)
      );
    },

    /**
     * Resolve an hourly rate for an attendee.
     * Matches by email first, then by (case-insensitive) name, then falls back
     * to the configured default rate. Returns a number or null if unknown.
     */
    resolveRate(rates, settings, { email, name }) {
      if (email) {
        const key = email.trim().toLowerCase();
        if (!this.emailMatchesDomainWhitelist(key, settings)) {
          return 0;
        }
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
