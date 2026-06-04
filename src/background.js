/**
 * Background service worker.
 *
 * Centralizes all calls to the Everhour API so the API key lives in one place
 * and CORS/host-permission handling is consistent. Options/popup pages talk to
 * it via chrome.runtime.sendMessage.
 */

const EVERHOUR_USERS_URL = "https://api.everhour.com/team/users";

// Everhour list endpoints paginate with a default page size of 50. We request
// larger pages and walk through them so teams bigger than 50 sync completely.
const PAGE_SIZE = 250;
const MAX_PAGES = 50; // safety cap (covers up to 12.5k members)

/** Convert an Everhour cents value (possibly under several field names) to a number. */
function toRate(...candidates) {
  for (const v of candidates) {
    if (typeof v === "number") return v / 100;
  }
  return null;
}

function normalizeUser(u) {
  return {
    id: u.id,
    name: u.name || "",
    email: (u.email || "").trim().toLowerCase(),
    // "rate" / "billRate" = bill rate (the members page "default hourly rate"),
    // "cost" / "costRate" = internal cost rate.
    rate: toRate(u.rate, u.billRate, u.billingRate),
    cost: toRate(u.cost, u.costRate),
  };
}

async function fetchPage(apiKey, page) {
  const url = `${EVERHOUR_USERS_URL}?limit=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body && body.message ? `: ${body.message}` : "";
    } catch (_) {
      /* ignore non-JSON error bodies */
    }
    if (res.status === 401) {
      throw new Error("Invalid Everhour API key (401 Unauthorized).");
    }
    throw new Error(`Everhour API error ${res.status}${detail}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Everhour response.");
  }
  return data;
}

/**
 * Fetch the full team roster from Everhour, paging through results so we don't
 * stop at the API's default page size. Returns a normalized, de-duplicated array.
 */
async function fetchEverhourUsers(apiKey) {
  const byId = new Map();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchPage(apiKey, page);
    if (batch.length === 0) break;

    let added = 0;
    for (const u of batch) {
      if (!byId.has(u.id)) {
        byId.set(u.id, normalizeUser(u));
        added += 1;
      }
    }

    // Last (partial) page, or the server ignored `page` and re-sent the same
    // set — either way there's nothing more to fetch.
    if (batch.length < PAGE_SIZE || added === 0) break;
  }

  return Array.from(byId.values());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "everhour:users") return false;

  fetchEverhourUsers(message.apiKey)
    .then((users) => sendResponse({ ok: true, users }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));

  // Return true to keep the message channel open for the async response.
  return true;
});
