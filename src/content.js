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

  // Matches a time range such as "11:00am – 12:00pm", "11 – 11:30am",
  // "1:00 PM to 2:30 PM". The dash may be a hyphen, en/em dash, or "to".
  const TIME_RANGE_RE =
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:–|—|-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]m))/i;

  // Cap how large a "popup" container can be, so we never mistake the whole
  // week/day grid (which also contains times + emails) for an event popup.
  const MAX_CONTAINER_TEXT = 5000;
  const MAX_CLIMB = 16;

  let cache = { settings: MC.DEFAULT_SETTINGS, rates: {} };
  let scheduled = false;

  /* ------------------------------------------------------------------ */
  /* Time parsing                                                        */
  /* ------------------------------------------------------------------ */

  function toMinutes(token, fallbackMeridiem) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(token);
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

    // The right side always carries an am/pm marker; parse it first, then use
    // its meridiem as the fallback for the (possibly bare) left side.
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

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Find event popup containers currently on screen. Strategy: every attendee
   * is rendered with a `data-email` attribute; for each one we climb up to the
   * nearest ancestor whose text contains a time range — that ancestor is the
   * event popup. Containers are de-duplicated.
   */
  function findPopups() {
    const emailEls = Array.from(
      document.querySelectorAll("[data-email]")
    ).filter(isVisible);

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

  function collectAttendees(container) {
    const seen = new Set();
    const attendees = [];
    container.querySelectorAll("[data-email]").forEach((el) => {
      const email = (el.getAttribute("data-email") || "").trim().toLowerCase();
      if (!email || !email.includes("@") || seen.has(email)) return;
      seen.add(email);
      const row =
        el.closest('[role="listitem"]') || el.parentElement || el;
      attendees.push({ email, name: guessName(el, row, email), row });
    });
    return attendees;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function clearInjected(container) {
    container
      .querySelectorAll(".mc-injected")
      .forEach((node) => node.remove());
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

  function buildEmailButton({ attendees, title, totalText }) {
    const recipients = attendees.map((a) => a.email).join(",");
    const subject = title ? `Re: ${title}` : "Re: our upcoming meeting";
    const body =
      `Hi,\n\nInstead of meeting` +
      (title ? ` about "${title}"` : "") +
      ` (estimated cost ${totalText}), could we sort this out over email?\n\n` +
      `Here's where things stand:\n\n`;
    const href =
      `mailto:${encodeURIComponent(recipients)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;

    const link = document.createElement("a");
    link.className = "mc-email-btn";
    link.href = href;
    link.textContent = "Send an Email Instead";
    // Open the user's mail client without navigating Calendar away.
    link.target = "_blank";
    link.rel = "noopener";
    return link;
  }

  function buildBanner({ totalText, total, knownCount, totalCount, attendees, title }) {
    const banner = document.createElement("div");
    banner.className = "mc-injected mc-banner";

    const icon = document.createElement("span");
    icon.className = "mc-banner-icon";
    icon.textContent = "$";

    const label = document.createElement("span");
    label.className = "mc-banner-label";
    label.textContent = `${totalText} cost of meeting`;

    banner.appendChild(icon);
    banner.appendChild(label);

    // "Costs too much? Send an email instead." Shown when the meeting cost
    // reaches the configured threshold (0 = always show, matching the mockup).
    const threshold = cache.settings.emailThreshold || 0;
    if (attendees.length && total >= threshold) {
      banner.appendChild(buildEmailButton({ attendees, title, totalText }));
    }

    if (knownCount < totalCount) {
      const note = document.createElement("span");
      note.className = "mc-banner-note";
      note.textContent = `(${knownCount}/${totalCount} rates known)`;
      note.title =
        "Some attendees don't have an hourly rate yet. Add them in the " +
        "extension options or set a default rate.";
      banner.appendChild(note);
    }
    return banner;
  }

  function annotateAttendee(attendee, rate) {
    const { row } = attendee;
    if (!row || row.querySelector(".mc-rate")) return;
    const span = document.createElement("span");
    span.className = "mc-injected mc-rate";
    span.textContent = ` (${MC.formatRate(rate, cache.settings)} per hour)`;
    row.appendChild(span);
  }

  function process(container) {
    const durationHours = parseDurationHours(container.textContent);
    const attendees = collectAttendees(container);
    if (attendees.length === 0) return;

    // Signature avoids re-rendering identical state on every mutation, but lets
    // us refresh when attendees, duration, or settings/rates change.
    const signature = JSON.stringify({
      d: durationHours,
      a: attendees.map((x) => x.email).sort(),
      v: cache.version,
    });
    if (container.dataset.mcSig === signature) return;
    container.dataset.mcSig = signature;

    clearInjected(container);

    let sumRates = 0;
    let knownCount = 0;
    for (const attendee of attendees) {
      const rate = MC.resolveRate(cache.rates, cache.settings, attendee);
      if (rate != null) {
        sumRates += rate;
        knownCount += 1;
        annotateAttendee(attendee, rate);
      }
    }

    if (durationHours == null || knownCount === 0) return;

    const total = sumRates * durationHours;
    const banner = buildBanner({
      totalText: MC.formatMoney(total, cache.settings),
      total,
      knownCount,
      totalCount: attendees.length,
      attendees,
      title: getMeetingTitle(container),
    });

    // Insert just above the attendee list when we can find it, otherwise drop
    // the banner at the top of the popup.
    const firstRow = attendees[0].row;
    const list =
      (firstRow && firstRow.closest('ul, [role="list"]')) || firstRow;
    if (list && list.parentElement) {
      list.parentElement.insertBefore(banner, list);
    } else {
      container.insertBefore(banner, container.firstChild);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                          */
  /* ------------------------------------------------------------------ */

  function run() {
    scheduled = false;
    if (!cache.settings.enabled) return;
    try {
      findPopups().forEach(process);
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
    const data = await MC.getAll();
    cache = {
      settings: data.settings,
      rates: data.rates,
      // bump a version token so process() knows to re-render on changes
      version: (cache.version || 0) + 1,
    };
  }

  async function init() {
    await refreshCache();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (!changes.settings && !changes.rates) return;
      await refreshCache();
      // Force re-render of any open popups.
      document
        .querySelectorAll("[data-mc-sig]")
        .forEach((el) => delete el.dataset.mcSig);
      schedule();
    });

    schedule();
  }

  init();
})();
