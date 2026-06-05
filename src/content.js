/**
 * Content script for Google Calendar.
 *
 * Watches the page for event detail popups, figures out the meeting duration
 * and the list of attendees, looks up each attendee's hourly rate, and injects:
 *   - a "$X cost of meeting" banner near the top of the popup, and
 *   - a "($rate per hour)" annotation next to each attendee.
 *
 * Google Calendar's DOM is heavily obfuscated and changes over time, so this
 * uses resilient heuristics (attribute + text-pattern matching) rather than
 * brittle class selectors. If Google changes their markup, the selectors and
 * the time-range regex below are the things most likely to need updating.
 */
(function () {
  "use strict";

  // A single clock time. To avoid matching stray numbers (dates, phone numbers)
  // we require either a ":"/"h" minutes separator or an am/pm marker. Supports:
  //   12-hour:  "11am", "1:30 PM"
  //   24-hour:  "16:15"            (French / most of the world)
  //   French h: "16h15", "16h"
  const TIME_TOKEN =
    "\\d{1,2}\\s?h\\s?\\d{2}|\\d{1,2}\\s?h|\\d{1,2}:\\d{2}(?:\\s?[ap]m)?|\\d{1,2}\\s?[ap]m";

  // The start time may be a bare hour ("11 – 11:30am"): Google drops ":00" in
  // 12-hour locales and lets the end time carry the am/pm. We only allow this on
  // the left; the end token must still have a real indicator so that plain
  // number ranges ("5 – 6") never match.
  const START_TOKEN = `${TIME_TOKEN}|\\d{1,2}`;

  // Matches a time range, e.g. "11:00am – 12:00pm", "16:15 – 16:45",
  // "16h15 à 16h45". Separator may be a hyphen, en/em dash, "to"/"until"/"à".
  const TIME_RANGE_RE = new RegExp(
    `(${START_TOKEN})\\s*(?:–|—|-|to|until|à)\\s*(${TIME_TOKEN})`,
    "i"
  );

  // Cap how large a "popup" container can be, so we never mistake the whole
  // week/day grid (which also contains times) for an event popup. The event
  // editor is fairly text-heavy, so this is generous.
  const MAX_CONTAINER_TEXT = 8000;
  const MAX_CLIMB = 16;

  let cache = { settings: MC.DEFAULT_SETTINGS, rates: {} };
  let scheduled = false;

  /* ------------------------------------------------------------------ */
  /* Time parsing                                                        */
  /* ------------------------------------------------------------------ */

  function toMinutes(token, fallbackMeridiem) {
    // Normalize the French "16h15" / "16h" forms to "16:15" / "16:00".
    const normalized = token
      .toLowerCase()
      .replace(/(\d)\s*h\s*(\d{2})/, "$1:$2")
      .replace(/(\d)\s*h(?!\d)/, "$1:00");
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(normalized);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    const meridiem = m[3] ? m[3].toLowerCase() : fallbackMeridiem || null;
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    return { minutes: hours * 60 + mins, meridiem };
  }

  /** Returns the meeting length in hours, or null if not parseable. */
  function parseDurationHours(text) {
    const m = TIME_RANGE_RE.exec(text.replace(/ /g, " "));
    if (!m) return null;

    // In 12-hour locales the end time carries the am/pm marker, so parse it
    // first and use its meridiem as the fallback for the (possibly bare) start
    // time. In 24-hour locales there is no meridiem and this is a no-op.
    const right = toMinutes(m[2]);
    const left = toMinutes(m[1], right ? right.meridiem : null);
    if (!left || !right) return null;

    let start = left.minutes;
    let end = right.minutes;
    // Handle crossing noon / midnight where the bare side was mis-inferred.
    let guard = 0;
    while (end <= start && guard < 2) {
      end += 12 * 60;
      guard += 1;
    }
    const hours = (end - start) / 60;
    return hours > 0 && hours <= 24 ? hours : null;
  }

  /* ------------------------------------------------------------------ */
  /* DOM discovery                                                       */
  /* ------------------------------------------------------------------ */

  // Google renders attendees with an email either in `data-email` (read-only
  // event popup) or in `data-hovercard-id` (the event editor's guest chips).
  const ATTENDEE_SELECTOR = "[data-email], [data-hovercard-id]";

  function emailOf(el) {
    const raw =
      el.getAttribute("data-email") || el.getAttribute("data-hovercard-id") || "";
    const email = raw.trim().toLowerCase();
    return email.includes("@") ? email : "";
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Find event popup/editor containers currently on screen. Strategy: every
   * attendee is rendered with an email-bearing attribute; for each one we climb
   * up to the nearest ancestor whose text contains a time range — that ancestor
   * is the event popup or editor. Containers are de-duplicated.
   */
  function findPopups() {
    const emailEls = Array.from(
      document.querySelectorAll(ATTENDEE_SELECTOR)
    ).filter((el) => emailOf(el) && isVisible(el));

    const containers = new Set();
    for (const el of emailEls) {
      let node = el.parentElement;
      let steps = 0;
      while (node && steps < MAX_CLIMB) {
        const text = node.textContent || "";
        if (text.length < MAX_CONTAINER_TEXT && TIME_RANGE_RE.test(text)) {
          containers.add(node);
          break;
        }
        node = node.parentElement;
        steps += 1;
      }
    }
    return Array.from(containers);
  }

  function guessName(el, row, email) {
    const candidates = [
      el.getAttribute("aria-label"),
      el.getAttribute("data-name"),
      el.getAttribute("title"),
      el.getAttribute("alt"),
      row && row !== el ? row.textContent : null,
      el.textContent,
    ];
    for (const c of candidates) {
      if (!c) continue;
      // Strip our own annotation and the email, keep the leading name part.
      let name = c
        .replace(/\(.*?per hour\)/gi, "")
        .replace(email, "")
        .split(/[,\n]/)[0]
        .trim();
      if (name && !/@/.test(name)) return name;
    }
    return "";
  }

  // Meeting rooms / resources are not people. Their addresses live under
  // *.calendar.google.com (resource & group calendars), and in the editor they
  // show up labelled "Salle disponible :" / "Room available:".
  function isResource(email, name) {
    if (/calendar\.google\.com$/i.test(email)) return true;
    const n = (name || "").trim().toLowerCase();
    return /^(salle disponible|room available|available room)\b/.test(n);
  }

  function collectAttendees(container) {
    const seen = new Set();
    const attendees = [];
    container.querySelectorAll(ATTENDEE_SELECTOR).forEach((el) => {
      const email = emailOf(el);
      if (!email || seen.has(email)) return;
      seen.add(email);
      const row =
        el.closest('[role="listitem"]') || el.parentElement || el;
      const name = guessName(el, row, email);
      if (isResource(email, name)) return; // skip meeting rooms / resources
      attendees.push({ email, name, row });
    });
    return attendees;
  }

  /** Best-effort extraction of the event title for the email subject. */
  function getMeetingTitle(container) {
    const heading =
      container.querySelector('[role="heading"]') ||
      container.querySelector("h1, h2, h3");
    if (heading) {
      const text = heading.textContent.trim();
      if (text) return text;
    }
    return "";
  }

  /* ------------------------------------------------------------------ */
  /* Localization                                                        */
  /* ------------------------------------------------------------------ */

  const isFrench = (document.documentElement.lang || "")
    .toLowerCase()
    .startsWith("fr");

  const L = isFrench
    ? {
        cost: "coût de la réunion",
        perHour: "/ h",
        email: "Envoyer un e-mail à la place",
        noRates: "Aucun tarif défini — ouvrez les réglages de l'extension",
        ratesKnown: (k, t) => `${k}/${t} tarifs connus`,
        unknown: "tarif inconnu",
        more: (n) => `+ ${n} autre${n > 1 ? "s" : ""}`,
        emailSubject: (title) => (title ? `Re : ${title}` : "Re : notre réunion"),
        emailBody: (title, totalText) =>
          `Bonjour,\n\nPlutôt qu'une réunion` +
          (title ? ` au sujet de « ${title} »` : "") +
          ` (coût estimé ${totalText}), pourrions-nous régler cela par e-mail ?\n\n`,
      }
    : {
        cost: "cost of meeting",
        perHour: "/ hr",
        email: "Send an Email Instead",
        noRates: "No rates set — open the extension settings",
        ratesKnown: (k, t) => `${k}/${t} rates known`,
        unknown: "rate unknown",
        more: (n) => `+ ${n} more`,
        emailSubject: (title) => (title ? `Re: ${title}` : "Re: our meeting"),
        emailBody: (title, totalText) =>
          `Hi,\n\nInstead of meeting` +
          (title ? ` about "${title}"` : "") +
          ` (estimated cost ${totalText}), could we sort this out over email?\n\n`,
      };

  /* ------------------------------------------------------------------ */
  /* Overlay rendering                                                   */
  /*                                                                     */
  /* Google Calendar runs a virtual-DOM reconciler that deletes any      */
  /* foreign node inserted into its managed subtree. To survive that we  */
  /* never touch Google's DOM: we render our own card in a Shadow DOM    */
  /* attached to <html>, and position it next to the event popup.        */
  /* ------------------------------------------------------------------ */

  const MAX_LISTED_ATTENDEES = 12;
  let host = null;
  let card = null;
  let anchor = null; // the popup container the card is currently pinned to

  const CARD_STYLES = `
    :host { all: initial; }
    .card {
      font-family: "Google Sans", Roboto, Arial, sans-serif;
      width: 250px;
      background: #fff;
      border: 1px solid #dadce0;
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(60,64,67,0.25);
      padding: 14px 16px;
      color: #202124;
      box-sizing: border-box;
    }
    .total { display: flex; align-items: baseline; gap: 8px; }
    .amount { font-size: 18px; font-weight: 700; color: #d93025; }
    .label { font-size: 13px; color: #5f6368; }
    .note { margin-top: 2px; font-size: 11px; color: #80868b; }
    .people { margin: 10px 0 0; padding: 0; list-style: none;
              border-top: 1px solid #f1f3f4; }
    .people li { display: flex; justify-content: space-between; gap: 10px;
                 font-size: 12px; padding: 5px 0; border-bottom: 1px solid #f1f3f4; }
    .people li:last-child { border-bottom: none; }
    .pname { color: #3c4043; overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; }
    .prate { color: #5f6368; white-space: nowrap; }
    .prate.missing { color: #c5221f; }
    .empty { font-size: 12px; color: #5f6368; }
    .email-btn {
      display: inline-block; margin-top: 12px; padding: 7px 14px;
      background: #1a73e8; color: #fff; font-size: 13px; font-weight: 600;
      border-radius: 8px; text-decoration: none; cursor: pointer;
      border: none; font-family: inherit;
    }
    .email-btn:hover { background: #1765cc; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "mc-cost-host";
    host.style.cssText =
      "position:fixed;top:0;left:0;z-index:2147483647;display:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CARD_STYLES;
    card = document.createElement("div");
    card.className = "card";
    shadow.appendChild(style);
    shadow.appendChild(card);
    // Attach to <html>, outside Google's reconciled <body> subtree.
    document.documentElement.appendChild(host);
  }

  function hideCard() {
    anchor = null;
    if (host) host.style.display = "none";
  }

  function gmailComposeUrl(attendees, title, totalText) {
    const to = attendees.map((a) => a.email).join(",");
    return (
      "https://mail.google.com/mail/?view=cm&fs=1" +
      `&to=${encodeURIComponent(to)}` +
      `&su=${encodeURIComponent(L.emailSubject(title))}` +
      `&body=${encodeURIComponent(L.emailBody(title, totalText))}`
    );
  }

  function renderCard(data) {
    ensureHost();
    card.textContent = "";

    if (data.knownCount === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = L.noRates;
      card.appendChild(empty);
    } else {
      const total = document.createElement("div");
      total.className = "total";
      const amount = document.createElement("span");
      amount.className = "amount";
      amount.textContent = data.totalText;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = L.cost;
      total.appendChild(amount);
      total.appendChild(label);
      card.appendChild(total);

      if (data.knownCount < data.attendees.length) {
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = L.ratesKnown(data.knownCount, data.attendees.length);
        card.appendChild(note);
      }
    }

    // Per-attendee breakdown.
    const list = document.createElement("ul");
    list.className = "people";
    const shown = data.attendees.slice(0, MAX_LISTED_ATTENDEES);
    for (const a of shown) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = a.name || a.email;
      const rate = document.createElement("span");
      rate.className = "prate" + (a.rate == null ? " missing" : "");
      rate.textContent =
        a.rate == null
          ? L.unknown
          : `${MC.formatRate(a.rate, cache.settings)} ${L.perHour}`;
      li.appendChild(name);
      li.appendChild(rate);
      list.appendChild(li);
    }
    if (data.attendees.length > shown.length) {
      const li = document.createElement("li");
      li.className = "pname";
      li.textContent = L.more(data.attendees.length - shown.length);
      list.appendChild(li);
    }
    card.appendChild(list);

    // "Costs too much? Send an email instead."
    const threshold = cache.settings.emailThreshold || 0;
    if (data.knownCount > 0 && data.total >= threshold) {
      const composeUrl = gmailComposeUrl(data.attendees, data.title, data.totalText);
      const btn = document.createElement("button");
      btn.className = "email-btn";
      btn.type = "button";
      btn.textContent = L.email;
      btn.addEventListener("click", () => {
        // Ask the background worker to focus an existing Gmail tab or open one.
        chrome.runtime.sendMessage({ type: "gmail:compose", url: composeUrl });
      });
      card.appendChild(btn);
    }

    host.style.display = "block";
  }

  /** Pin the card just outside the popup (to the right, or left if no room). */
  function positionCard() {
    if (!host || !anchor || !anchor.isConnected) {
      hideCard();
      return;
    }
    const r = anchor.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      hideCard();
      return;
    }
    const margin = 8;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    let left = r.right + margin;
    if (left + w > window.innerWidth - margin) left = r.left - w - margin;
    if (left < margin) left = margin;
    let top = r.top;
    if (top + h > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - h - margin);
    }
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  /* ------------------------------------------------------------------ */
  /* Processing                                                          */
  /* ------------------------------------------------------------------ */

  function buildData(container) {
    const durationHours = parseDurationHours(container.textContent);
    if (durationHours == null) return null;
    const rawAttendees = collectAttendees(container);
    if (rawAttendees.length === 0) return null;

    let sumRates = 0;
    let knownCount = 0;
    const attendees = rawAttendees.map((a) => {
      const rate = MC.resolveRate(cache.rates, cache.settings, a);
      if (rate != null) {
        sumRates += rate;
        knownCount += 1;
      }
      return { name: a.name, email: a.email, rate, row: a.row };
    });
    // Known rates first, so the visible (capped) list is the useful one.
    attendees.sort((x, y) => (x.rate == null ? 1 : 0) - (y.rate == null ? 1 : 0));

    const total = sumRates * durationHours;
    return {
      container,
      durationHours,
      attendees,
      knownCount,
      total,
      totalText: MC.formatMoney(total, cache.settings),
      title: getMeetingTitle(container),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Legacy inline cleanup                                               */
  /*                                                                     */
  /* Older versions injected rates into the page DOM. We now keep all    */
  /* sensitive values inside an extension-owned closed shadow tree, but  */
  /* still remove stale inline nodes after upgrades.                     */
  /* ------------------------------------------------------------------ */

  const THRASH_WINDOW_MS = 2000;
  const THRASH_LIMIT = 8; // re-inserts within the window before giving up
  const THRASH_COOLDOWN_MS = 30000;
  let injectTimes = [];
  let inlineDisabledUntil = 0;

  // Dedicated observer that watches only the banner's immediate parent so we
  // can re-inject in ~20 ms instead of 150 ms when Google's reconciler removes
  // just our node. This makes the flicker imperceptible rather than visible.
  let bannerObserver = null;
  let trackedBanner = null;
  let quickScheduled = false;

  function scheduleQuick() {
    if (quickScheduled || scheduled) return;
    quickScheduled = true;
    setTimeout(() => { quickScheduled = false; run(); }, 20);
  }

  function watchBanner(banner) {
    if (bannerObserver) bannerObserver.disconnect();
    trackedBanner = banner;
    const parent = banner.parentElement;
    if (!parent) return;
    bannerObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node === trackedBanner) {
            scheduleQuick();
            return;
          }
        }
      }
    });
    bannerObserver.observe(parent, { childList: true });
  }

  function stopWatchingBanner() {
    if (bannerObserver) { bannerObserver.disconnect(); bannerObserver = null; }
    trackedBanner = null;
  }

  function inlineBannerLabel(data) {
    return data.knownCount === 0
      ? L.noRates
      : `${data.totalText} ${L.cost}` +
          (data.knownCount < data.attendees.length
            ? `  ·  ${L.ratesKnown(data.knownCount, data.attendees.length)}`
            : "");
  }

  function buildInlineBanner(data) {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-mc-banner", "1");
    wrap.style.cssText =
      "display:flex;align-items:center;gap:10px;margin:6px 0;padding:4px 24px;" +
      "font-family:inherit;";

    const icon = document.createElement("span");
    icon.textContent = cache.settings.currency || "€";
    icon.style.cssText =
      "flex:0 0 auto;width:18px;text-align:center;font-weight:700;color:#5f6368;";

    const label = document.createElement("span");
    label.setAttribute("data-mc-label", "1");
    label.style.cssText =
      "font-weight:700;font-size:14px;color:" +
      (data.knownCount === 0 ? "#5f6368" : "#d93025") +
      ";";
    label.textContent = inlineBannerLabel(data);

    wrap.appendChild(icon);
    wrap.appendChild(label);

    const threshold = cache.settings.emailThreshold || 0;
    if (data.knownCount > 0 && data.total >= threshold) {
      const composeUrl = gmailComposeUrl(
        data.attendees,
        data.title,
        data.totalText
      );
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("data-mc-email", "1");
      btn.textContent = L.email;
      btn.style.cssText =
        "margin-left:auto;padding:6px 14px;background:#1a73e8;color:#fff;" +
        "border:none;border-radius:8px;font-size:13px;font-weight:600;" +
        "font-family:inherit;cursor:pointer;";
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "gmail:compose", url: composeUrl });
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  /** Append "(rate / h)" next to each attendee. Returns nothing. */
  function annotateRows(attendees) {
    for (const a of attendees) {
      if (!a.row || !a.row.isConnected) continue;
      let span = a.row.querySelector("[data-mc-rate]");
      if (a.rate == null) {
        if (span) span.remove();
        continue;
      }
      const text = ` (${MC.formatRate(a.rate, cache.settings)} ${L.perHour})`;
      if (!span) {
        span = document.createElement("span");
        span.setAttribute("data-mc-rate", "1");
        span.style.cssText = "color:#5f6368;white-space:nowrap;";
        a.row.appendChild(span);
      }
      if (span.textContent !== text) span.textContent = text;
    }
  }

  function removeInline(root) {
    stopWatchingBanner();
    (root || document)
      .querySelectorAll("[data-mc-banner],[data-mc-rate]")
      .forEach((n) => n.remove());
  }

  function inlineSignature(data) {
    return (
      data.attendees.map((a) => a.email).sort().join(",") + "|" + data.totalText
    );
  }

  /** Returns true if injection is holding, false if it's thrashing. */
  function renderInline(data) {
    const container = data.container;
    annotateRows(data.attendees);

    const sig = inlineSignature(data);
    let banner = container.querySelector("[data-mc-banner]");
    if (banner && banner.getAttribute("data-mc-sig") === sig) {
      return true; // up to date
    }
    if (banner) banner.remove(); // stale (DOM reused for another event)

    // (Re)insert it, ideally just above the attendee list.
    banner = buildInlineBanner(data);
    banner.setAttribute("data-mc-sig", sig);
    const firstRow = data.attendees.find((a) => a.row && a.row.isConnected);
    const list = firstRow
      ? firstRow.row.closest('ul, [role="list"]') || firstRow.row
      : null;
    if (list && list.parentElement) {
      list.parentElement.insertBefore(banner, list);
    } else {
      container.insertBefore(banner, container.firstChild);
    }

    watchBanner(banner);

    // Track re-insertion rate to detect Google fighting us.
    const now = Date.now();
    injectTimes.push(now);
    injectTimes = injectTimes.filter((t) => now - t < THRASH_WINDOW_MS);
    return injectTimes.length < THRASH_LIMIT;
  }

  function run() {
    scheduled = false;
    if (!cache.settings.enabled) {
      removeInline();
      hideCard();
      return;
    }
    try {
      const candidates = findPopups()
        .map(buildData)
        .filter(Boolean)
        // Prefer the tightest (most specific) container.
        .sort(
          (a, b) =>
            a.container.textContent.length - b.container.textContent.length
        );

      const best = candidates[0];
      if (!best) {
        removeInline();
        hideCard();
        return;
      }
      removeInline();
      anchor = best.container;
      renderCard(best);
      positionCard();
    } catch (err) {
      // Never let a parsing hiccup break the page.
      console.debug("[MeetingCost] processing error", err);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // Debounce bursts of mutations from Google Calendar's reactive UI.
    setTimeout(run, 150);
  }

  async function refreshCache() {
    const resp = await chrome.runtime.sendMessage({ type: "state:get" });
    if (!resp || !resp.ok || !resp.data) {
      throw new Error((resp && resp.error) || "Unable to read extension state.");
    }
    const data = resp.data;
    cache = {
      settings: data.settings,
      rates: data.rates,
      version: (cache.version || 0) + 1,
    };
  }

  async function init() {
    await refreshCache();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    // Keep the card pinned to the popup as the user scrolls or resizes.
    window.addEventListener("scroll", positionCard, true);
    window.addEventListener("resize", positionCard);

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "session") return;
      if (!changes.publicSettings && !changes.publicRates) return;
      await refreshCache();
      schedule();
    });

    schedule();
  }

  init();
})();
