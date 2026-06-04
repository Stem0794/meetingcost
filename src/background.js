/**
 * Background service worker.
 *
 * Centralizes all calls to the Everhour API so the API key lives in one place
 * and CORS/host-permission handling is consistent. Options/popup pages talk to
 * it via chrome.runtime.sendMessage.
 */

const EVERHOUR_USERS_URL = "https://api.everhour.com/team/users";

/**
 * Fetch the team roster from Everhour.
 * Everhour returns monetary fields ("rate" = bill rate, "cost" = cost rate) as
 * integers in cents, so we divide by 100. Returns a normalized array.
 */
async function fetchEverhourUsers(apiKey) {
  const res = await fetch(EVERHOUR_USERS_URL, {
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

  const users = await res.json();
  if (!Array.isArray(users)) {
    throw new Error("Unexpected Everhour response.");
  }

  return users.map((u) => ({
    id: u.id,
    name: u.name || "",
    email: (u.email || "").trim().toLowerCase(),
    rate: typeof u.rate === "number" ? u.rate / 100 : null,
    cost: typeof u.cost === "number" ? u.cost / 100 : null,
  }));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "everhour:users") return false;

  fetchEverhourUsers(message.apiKey)
    .then((users) => sendResponse({ ok: true, users }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));

  // Return true to keep the message channel open for the async response.
  return true;
});
