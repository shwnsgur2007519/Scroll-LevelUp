// 확장 전용 localStorage['slu_store'] 관리

function readAll() {
  try { return JSON.parse(localStorage.getItem("slu_store") || "{}"); }
  catch { return {}; }
}
function writeAll(obj) {
  localStorage.setItem("slu_store", JSON.stringify(obj || {}));
}
function pick(all, keys) {
  if (!keys) return all;
  const out = {}; for (const k of keys) out[k] = all[k]; return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg.type === "LS_GET") {
      const all = readAll();
      sendResponse(pick(all, msg.keys));
      return;
    }
    if (msg.type === "LS_SET") {
      const cur = readAll();
      writeAll({ ...cur, ...(msg.payload || {}) });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "LS_MERGE") {
      const cur = readAll();
      const { path, key, value } = msg;
      if (path === "scrollHistory") {
        const map = cur.scrollHistory || {};
        map[key] = { ...(map[key] || {}), ...(value || {}) };
        cur.scrollHistory = map;
      } else {
        cur[path] = { ...(cur[path] || {}), ...(value || {}) };
      }
      writeAll(cur);
      sendResponse({ ok: true });
      return;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
});
