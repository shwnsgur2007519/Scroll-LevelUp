// MV3 Service Worker (module)

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["IFRAME_SCRIPTING"],
    justification: "Use extension-scoped localStorage as fast, consistent store."
  });
}

chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ensureOffscreen();

    // ▼ 추가: 배지 토글 브로드캐스트
    if (msg?.type === "BADGE_TOGGLE") {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (!t.id) continue;
        try {
          await chrome.tabs.sendMessage(t.id, { type: "BADGE_TOGGLE", value: !!msg.value });
        } catch (_) { /* 탭에 컨텐츠 없을 수도 있음 */ }
      }
      sendResponse({ ok: true });
      return;
    }

    // (나머지 LS_GET / LS_SET / LS_MERGE 분기는 기존 그대로)
    if (msg?.type === "LS_GET" || msg?.type === "LS_SET" || msg?.type === "LS_MERGE") {
      chrome.runtime.sendMessage(msg, sendResponse);
      return;
    }
    sendResponse({ ok: true });
  })();
  return true;
});
