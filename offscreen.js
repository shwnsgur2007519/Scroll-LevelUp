// 확장 전용 localStorage['slu_store'] 관리

function readAll() {
  return JSON.parse(localStorage.getItem("slu_store") || "{}");
}
function writeAll(obj) {
  localStorage.setItem("slu_store", JSON.stringify(obj));
}
function pick(all, keys) {
  if (!keys) return all;
  const out = {};
  for (const key of keys) out[key] = all[key];
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "LS_GET") {
    sendResponse(pick(readAll(), msg.keys));
    return;
  }
  if (msg?.type === "LS_SET") {
    writeAll({ ...readAll(), ...msg.payload });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === "LS_ADD") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.dayKey) || !Number.isFinite(msg.px) || msg.px <= 0) {
      throw new Error("Invalid scroll increment");
    }
    const store = readAll();
    const history = store.scrollHistory || {};
    const old = history[msg.dayKey] || {};
    const pxToday = (old.px || 0) + msg.px;
    const totalPx = (store.totalPx || 0) + msg.px;
    history[msg.dayKey] = {
      ...old, px: pxToday, goal: old.goal ?? 50000,
      step: old.step ?? 5000, updatedAt: Date.now()
    };
    writeAll({ ...store, scrollHistory: history, totalPx });
    sendResponse({ pxToday, totalPx });
  }
});
