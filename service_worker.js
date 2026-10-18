// MV3 Service Worker (module)

let creatingOffscreen;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["LOCAL_STORAGE"],
      justification: "Store scroll progress in extension localStorage."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SCROLL_DELTA" && sender.tab?.id && sender.frameId > 0) {
    chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 })
      .then(() => sendResponse({ ok: true }), error => sendResponse({ error: String(error) }));
    return true;
  }

  const types = { STORE_GET: "LS_GET", STORE_SET: "LS_SET", STORE_ADD: "LS_ADD" };
  if (!types[msg?.type]) return;

  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ ...msg, type: types[msg.type] }))
    .then(sendResponse, error => sendResponse({ error: String(error) }));
  return true;
});
