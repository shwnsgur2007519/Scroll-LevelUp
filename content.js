// ===== 설정 =====
const BASE_STEP_PX = 5000;    // 레벨1 요구치
const INCREMENT    = 2500;    // 레벨마다 추가 요구 픽셀(선형)
const SAVE_INTERVAL_MS = 100;

// ===== Store helpers =====
let contextInvalidated = false;

function extensionActive() {
  return !contextInvalidated && !!chrome.runtime?.id;
}

function sendToRuntime(message) {
  return Promise.resolve()
    .then(() => extensionActive() ? chrome.runtime.sendMessage(message) : null)
    .catch(error => {
      if (String(error).includes("Extension context invalidated")) {
        contextInvalidated = true;
        document.getElementById("sluBadge")?.remove();
        return null;
      }
      throw error;
    });
}

async function getStore(keys) {
  const result = await sendToRuntime({ type:"STORE_GET", keys });
  if (!result) return null;
  if (result?.error) throw new Error(result.error);
  return result;
}

// ===== 유틸/난이도 =====
const todayKey = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
function reqForLevel(n){ return BASE_STEP_PX + INCREMENT * Math.max(0,n-1); }
function cumForLevel(n){ if(n<=0) return 0; return (n*(2*BASE_STEP_PX+(n-1)*INCREMENT))/2; }
function levelFromTotalPx(T){ let lo=0,hi=100000; while(lo<hi){ const m=Math.floor((lo+hi+1)/2); if(cumForLevel(m)<=T) lo=m; else hi=m-1; } return lo; }
function progressInCurrentLevel(T){ const L=levelFromTotalPx(T); const base=cumForLevel(L); const need=reqForLevel(L+1); const prog=Math.max(0,T-base); const pct=Math.max(0,Math.min(1,prog/need)); return {level:L,needToNext:need,progressed:prog,pctInLevel:pct}; }
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

// ===== 상태 =====
const IS_TOP_FRAME = window === window.top;
let pagePosition = { x:window.scrollX||0, y:window.scrollY||0 };
const elementScrollPositions = new WeakMap();
const observedShadowRoots = new WeakSet();
let framePendingPx = 0;
let frameSendTimer = null;
let today = todayKey();
let pxToday = 0;
let totalPx = 0;
let totalLevel = 0;
let saveTimer = null;
const pendingScroll = [];
let flushing = null;
let badgeEnabled = true;
let suppressNextLevelUp = false; // 병합으로 레벨이 변한 직후 팝업 억제

// ===== 배지/팝업 =====
let badgeEl = null;
const BADGE_ID="sluBadge", FILL_ID="sluFill", LEVEL_ID="sluLevel";

function ensureBadge(){
  if(!badgeEnabled){ const ex=document.getElementById(BADGE_ID); if(ex) ex.remove(); return; }
  const exists=document.getElementById(BADGE_ID); if(exists){ badgeEl=exists; return; }
  badgeEl=document.createElement("div");
  badgeEl.id=BADGE_ID; badgeEl.className="slu-badge";
  badgeEl.innerHTML=`
    <div class="slu-liquid"></div>
    <div class="slu-badge__row"><div class="slu-badge__level" id="${LEVEL_ID}">Lv 0</div></div>
    <div class="slu-badge__bar"><div class="slu-badge__fill" id="${FILL_ID}" style="width:0%"></div></div>`;
  document.documentElement.appendChild(badgeEl);
}
function updateBadge(animate = true){
  if (!badgeEnabled) {
    const ex = document.getElementById(BADGE_ID);
    if (ex) ex.remove();
    return;
  }
  if(!badgeEnabled) return; ensureBadge();
  const elLevel=document.getElementById(LEVEL_ID);
  const elFill=document.getElementById(FILL_ID);
  if(!elLevel||!elFill) return;
  const cur=progressInCurrentLevel(totalPx);
  elLevel.textContent=`Lv ${cur.level}`;
  if (!animate) elFill.style.transition = "none";
  elFill.style.width=`${Math.round(cur.pctInLevel*100)}%`;
  if (!animate) {
    void elFill.offsetWidth;
    elFill.style.transition = "";
  }
}
function showLevelUpAnimation(newLevel){
  const old=document.getElementById("sluOverlay"); if(old) old.remove();
  const overlay=document.createElement("div"); overlay.id="sluOverlay"; overlay.className="slu-overlay";
  overlay.innerHTML=`<div class="slu-pop"><div class="slu-pop__title">LEVEL UP!</div><div class="slu-pop__level">Lv ${newLevel}</div><div class="slu-pop__sparkles">✨🎉🚀</div></div>`;
  document.documentElement.appendChild(overlay);
  setTimeout(()=>overlay.remove(),2200);
}

// ===== 로드/세이브 =====
function pendingTotal(day) {
  return pendingScroll.reduce((sum, item) => sum + (day && item.day !== day ? 0 : item.px), 0);
}

function flushScroll() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!extensionActive()) return Promise.resolve();
  if (flushing) return flushing;
  if (!pendingScroll.length) return Promise.resolve();

  flushing = (async () => {
    while (pendingScroll.length) {
      const item = { ...pendingScroll[0] };
      const result = await sendToRuntime({
        type: "STORE_ADD", dayKey: item.day, px: item.px
      });
      if (!result) return;
      if (result?.error) throw new Error(result.error);
      pendingScroll[0].px -= item.px;
      if (!pendingScroll[0].px) pendingScroll.shift();
      totalPx = result.totalPx + pendingTotal();
      if (item.day === today) pxToday = result.pxToday + pendingTotal(today);
      const level = progressInCurrentLevel(totalPx).level;
      if (level > totalLevel) suppressNextLevelUp = true;
      totalLevel = level;
      updateBadge();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(flushScroll, SAVE_INTERVAL_MS);
}

function sendFrameScroll(direct = false) {
  if (frameSendTimer) clearTimeout(frameSendTimer);
  frameSendTimer = null;
  if (!framePendingPx) return;
  const px = framePendingPx;
  framePendingPx = 0;
  if (!extensionActive()) return;
  if (direct) {
    sendToRuntime({ type:"STORE_ADD", dayKey:todayKey(), px });
  } else {
    sendToRuntime({ type:"SCROLL_DELTA", dy:px });
  }
}

async function loadState(){
  const key=todayKey();
  const obj=await getStore(["scrollHistory","totalPx","badgeEnabled"]);
  if (!obj) return;
  const map=obj.scrollHistory||{}; const rec=map[key]||{px:0};
  pxToday=(rec.px||0)+pendingTotal(key);
  totalPx=(obj.totalPx||0)+pendingTotal();
  totalLevel=progressInCurrentLevel(totalPx).level;
  today=key; badgeEnabled=obj.badgeEnabled!==false;
  updateBadge(false);
}

// ===== 이벤트 =====
function recordScroll(dy){
  if (!dy) return;
  if (!extensionActive()) {
    document.getElementById(BADGE_ID)?.remove();
    return;
  }
  if (!IS_TOP_FRAME) {
    framePendingPx+=dy;
    if (!frameSendTimer) frameSendTimer=setTimeout(sendFrameScroll, SAVE_INTERVAL_MS);
    return;
  }
  const key = todayKey();
  if (key !== today) {
    today = key;
    pxToday = pendingTotal(key);
    loadState();
  }
  pxToday+=dy; totalPx+=dy;
  const last = pendingScroll[pendingScroll.length-1];
  if (last?.day === key) last.px += dy;
  else pendingScroll.push({ day:key, px:dy });
  const cur=progressInCurrentLevel(totalPx);
  if(cur.level>totalLevel){
    if(suppressNextLevelUp){ totalLevel=cur.level; suppressNextLevelUp=false; }
    else { totalLevel=cur.level; showLevelUpAnimation(totalLevel); }
  }
  updateBadge();
  scheduleSave();
}

function onScroll(event){
  const target=event.target;
  const isPage=target===document || target===window || target===document.documentElement;
  const position=isPage
    ? { x:window.scrollX||0, y:window.scrollY||0 }
    : { x:target.scrollLeft, y:target.scrollTop };
  const previous=isPage ? pagePosition : elementScrollPositions.get(target) ?? position;
  if(isPage) pagePosition=position;
  else elementScrollPositions.set(target,position);
  recordScroll(Math.abs(position.x-previous.x)+Math.abs(position.y-previous.y));
}

function rememberScrollPositions(event){
  const targets=[];
  for (const target of event.composedPath()) {
    if (target instanceof Element && target!==document.documentElement) {
      if (!elementScrollPositions.has(target)) {
        elementScrollPositions.set(target,{ x:target.scrollLeft, y:target.scrollTop });
      }
      targets.push(target);
    }
    if (target instanceof ShadowRoot && !observedShadowRoots.has(target)) {
      target.addEventListener("scroll", onScroll, { capture:true, passive:true });
      observedShadowRoots.add(target);
    }
  }
  if (event.type==="wheel" || event.type==="touchmove") {
    requestAnimationFrame(()=>{
      for (const target of targets) onScroll({ target });
      onScroll({ target:document });
    });
  }
}

async function onVisibilityChange(){
  if (!extensionActive()) {
    document.getElementById(BADGE_ID)?.remove();
    return;
  }
  if (document.hidden) {
    await flushScroll();
  } else {
    await flushScroll();
    await loadState();
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SCROLL_DELTA" && IS_TOP_FRAME && Number.isFinite(msg.dy) && msg.dy>0) {
      recordScroll(msg.dy);
      if (document.hidden) flushScroll();
      return;
    }
  });
}
// ===== 초기화 =====
(async function init(){
  for (const type of ["wheel","pointerdown","touchstart","touchmove","keydown"]) {
    document.addEventListener(type, rememberScrollPositions, { capture:true, passive:true });
  }
  document.addEventListener("scroll", onScroll, { capture:true, passive:true });
  if (!IS_TOP_FRAME) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) sendFrameScroll(true);
    });
    window.addEventListener("pagehide", () => sendFrameScroll(true), { capture:true });
    return;
  }
  if (!document.documentElement) {
    await new Promise(resolve=>document.addEventListener("DOMContentLoaded", resolve, { once:true }));
  }
  ensureBadge();              // 문서 루트가 준비되면 배지 표시
  await loadState();          // 최신값 로드
  updateBadge();

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("blur", flushScroll);
  window.addEventListener("focus", onVisibilityChange);
  window.addEventListener("pagehide", flushScroll, { capture:true });
  window.addEventListener("beforeunload", flushScroll, { capture:true });

  setInterval(()=>{ pagePosition={ x:window.scrollX||0, y:window.scrollY||0 }; }, 1500); // SPA 보정
  setInterval(flushScroll, 5000);                              // 주기 백업
})();
