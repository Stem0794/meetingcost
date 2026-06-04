/* Toolbar popup: quick enable/disable toggle + summary + link to settings. */
(function () {
  "use strict";

  const enabledEl = document.getElementById("enabled");
  const summaryEl = document.getElementById("summary");
  const openOptionsEl = document.getElementById("openOptions");

  async function load() {
    const { settings, rates } = await MC.getAll();
    enabledEl.checked = settings.enabled;

    const count = Object.keys(rates).length;
    if (count === 0) {
      summaryEl.textContent = "No rates configured yet.";
    } else {
      summaryEl.textContent =
        `${count} ${count === 1 ? "rate" : "rates"} configured.` +
        (settings.lastSync
          ? ` Last Everhour sync ${new Date(settings.lastSync).toLocaleDateString()}.`
          : "");
    }
  }

  enabledEl.addEventListener("change", async () => {
    await MC.saveSettings({ enabled: enabledEl.checked });
  });

  openOptionsEl.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("src/options.html"));
    }
  });

  load();
})();
