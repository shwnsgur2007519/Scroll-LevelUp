const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("increments from separate tabs accumulate in the stored record", () => {
  const data = new Map();
  data.set("slu_store", JSON.stringify({
    scrollHistory: { "2026-10-19": { px: 100, goal: 60000 } },
    totalPx: 500
  }));
  let onMessage;
  const context = {
    localStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value)
    },
    chrome: { runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } },
    Date
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8"), context);

  function send(message) {
    let response;
    onMessage(message, {}, value => { response = value; });
    return response;
  }

  send({ type: "LS_ADD", dayKey: "2026-10-19", px: 20 });
  send({ type: "LS_ADD", dayKey: "2026-10-19", px: 30 });
  const stored = JSON.parse(data.get("slu_store"));
  assert.equal(stored.scrollHistory["2026-10-19"].px, 150);
  assert.equal(stored.scrollHistory["2026-10-19"].goal, 60000);
  assert.equal(stored.totalPx, 550);
  assert.equal(send({ type: "LS_GET", keys: ["totalPx"] }).totalPx, 550);
});

test("hiding a tab flushes pending scroll and returning reloads stored progress", async () => {
  const store = { scrollHistory: {}, totalPx: 0 };
  const document = {
    hidden: false,
    documentElement: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { innerHTML: "" }; }
  };
  const window = { scrollX: 0, scrollY: 0, addEventListener() {} };
  window.top = window;
  const context = vm.createContext({
    window, document, Date, Promise, WeakMap, WeakSet,
    setTimeout, clearTimeout, setInterval() {},
    chrome: { runtime: {
      id: "test-extension",
      onMessage: { addListener() {} },
      async sendMessage(message) {
        if (message.type === "STORE_GET") return { ...store };
        if (message.type === "STORE_ADD") {
          const record = store.scrollHistory[message.dayKey] || { px: 0 };
          record.px += message.px;
          store.scrollHistory[message.dayKey] = record;
          store.totalPx += message.px;
          return { pxToday: record.px, totalPx: store.totalPx };
        }
        throw new Error(`Unexpected message: ${message.type}`);
      }
    } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));

  vm.runInContext("recordScroll(40)", context);
  document.hidden = true;
  await vm.runInContext("onVisibilityChange()", context);
  assert.equal(store.totalPx, 40);

  const day = vm.runInContext("todayKey()", context);
  store.scrollHistory[day].px += 25;
  store.totalPx += 25;
  store.badgeEnabled = false;
  document.hidden = false;
  await vm.runInContext("onVisibilityChange()", context);
  assert.equal(vm.runInContext("pxToday", context), 65);
  assert.equal(vm.runInContext("totalPx", context), 65);
  assert.equal(vm.runInContext("badgeEnabled", context), false);

  context.chrome.runtime.id = undefined;
  vm.runInContext("recordScroll(10)", context);
  await vm.runInContext("onVisibilityChange()", context);
  assert.equal(store.totalPx, 65);

  context.chrome.runtime.id = "test-extension";
  context.chrome.runtime.sendMessage = async () => {
    throw new Error("Extension context invalidated.");
  };
  vm.runInContext("recordScroll(5)", context);
  await vm.runInContext("flushScroll()", context);
  assert.equal(vm.runInContext("contextInvalidated", context), true);
  assert.equal(store.totalPx, 65);
});

test("simultaneous storage requests create one offscreen document", async () => {
  let onMessage;
  let creations = 0;
  const forwarded = [];
  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://test/${file}`,
      getContexts: async () => [],
      sendMessage: async message => {
        forwarded.push(message.type);
        return { totalPx: 10 };
      },
      onMessage: { addListener: listener => { onMessage = listener; } }
    },
    offscreen: {
      createDocument: async options => {
        creations++;
        assert.equal(options.reasons[0], "LOCAL_STORAGE");
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "service_worker.js"), "utf8"), { chrome });
  const send = message => new Promise(resolve => onMessage(message, {}, resolve));
  const results = await Promise.all([
    send({ type: "STORE_GET" }),
    send({ type: "STORE_ADD", dayKey: "2026-10-19", px: 10 })
  ]);
  assert.equal(creations, 1);
  assert.deepEqual(forwarded, ["LS_GET", "LS_ADD"]);
  assert.equal(results[1].totalPx, 10);
});
