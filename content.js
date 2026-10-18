// ===== 설정 =====
const BASE_STEP_PX = 5000;    // 레벨1 요구치
const INCREMENT    = 2500;    // 레벨마다 추가 요구 픽셀(선형)
const DAILY_GOAL_PX = 50000;  // 오늘 목표(팝업 링)
const SAVE_DEBOUNCE_MS = 400;
const BIG_JUMP_SAVE_THRESHOLD = 1500;

// ===== Runtime/Queue & 캐시 =====
function hasRuntime() {
  return typeof chrome !== "undefined"
    && chrome.runtime && chrome.runtime.id
    && typeof chrome.runtime.sendMessage === "function";
}
const PENDING_KEY = "slu_pending";
const CACHE_KEY   = "slu_cache";
function readJSON(key){ try{return JSON.parse(localStorage.getItem(key)||"{}");}catch{return{};} }
function writeJSON(key,obj){ localStorage.setItem(key,JSON.stringify(obj||{})); }
function merge(o,p){ return { ...(o||{}), ...(p||{}) }; }
function pick(all,keys){ if(!keys) return all; const out={}; for(const k of keys) out[k]=all[k]; return out; }

// ===== Store helpers : 항상 오프스크린 localStorage 사용(없으면 대기열) =====
async function getStore(keys) {
  if (hasRuntime()) {
    const pending = readJSON(PENDING_KEY);
    if (Object.keys(pending).length) {
      await chrome.runtime.sendMessage({ type:"LS_SET", payload: pending });
      writeJSON(PENDING_KEY, {});
    }
    const fresh = await chrome.runtime.sendMessage({ type:"LS_GET", keys });
    const cache = readJSON(CACHE_KEY);
    writeJSON(CACHE_KEY, merge(cache, fresh));
    return fresh;
  }
  const cache = readJSON(CACHE_KEY);
  const pending = readJSON(PENDING_KEY);
  return pick(merge(cache, pending), keys);
}
async function setStore(payload) {
  if (hasRuntime()) {
    const cache = readJSON(CACHE_KEY);
    writeJSON(CACHE_KEY, merge(cache, payload));
    return await chrome.runtime.sendMessage({ type:"LS_SET", payload });
  }
  const pending = readJSON(PENDING_KEY);
  writeJSON(PENDING_KEY, merge(pending, payload));
  const cache = readJSON(CACHE_KEY);
  writeJSON(CACHE_KEY, merge(cache, payload));
  return { ok:true, offline:true };
}
async function mergeScrollHistory(dayKey, record) {
  if (hasRuntime()) {
    const cache = readJSON(CACHE_KEY);
    const map = cache.scrollHistory || {};
    map[dayKey] = { ...(map[dayKey]||{}), ...record };
    writeJSON(CACHE_KEY, { ...cache, scrollHistory: map });
    return await chrome.runtime.sendMessage({ type:"LS_MERGE", path:"scrollHistory", key:dayKey, value:record });
  }
  const pending = readJSON(PENDING_KEY);
  const map = pending.scrollHistory || {};
  map[dayKey] = { ...(map[dayKey]||{}), ...record };
  pending.scrollHistory = map; writeJSON(PENDING_KEY, pending);
  const cache = readJSON(CACHE_KEY);
  const map2 = cache.scrollHistory || {};
  map2[dayKey] = { ...(map2[dayKey]||{}), ...record };
  writeJSON(CACHE_KEY, { ...cache, scrollHistory: map2 });
  return { ok:true, offline:true };
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
let lastSavedPx = 0;
let saveTimer = null;
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
function updateBadge(){
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
  elFill.style.width=`${Math.round(cur.pctInLevel*100)}%`;
}
function showLevelUpAnimation(newLevel){
  const old=document.getElementById("sluOverlay"); if(old) old.remove();
  const overlay=document.createElement("div"); overlay.id="sluOverlay"; overlay.className="slu-overlay";
  overlay.innerHTML=`<div class="slu-pop"><div class="slu-pop__title">LEVEL UP!</div><div class="slu-pop__level">Lv ${newLevel}</div><div class="slu-pop__sparkles">✨🎉🚀</div></div>`;
  document.documentElement.appendChild(overlay);
  setTimeout(()=>overlay.remove(),2200);
}

// ===== 로드/세이브 =====
async function readAndMerge(){
  const key=todayKey();
  const remote=await getStore(["scrollHistory","totalPx"]);
  const map=remote.scrollHistory||{};
  const rec=map[key]||{};
  const mergedPxToday=Math.max(rec.px||0, pxToday);
  const mergedTotalPx=Math.max(remote.totalPx||0, totalPx);
  map[key]={ ...rec, px: mergedPxToday, goal: DAILY_GOAL_PX, step: BASE_STEP_PX, updatedAt: Date.now() };
  return { map, mergedPxToday, mergedTotalPx, key };
}
async function saveStateDebounced(){ if(saveTimer) clearTimeout(saveTimer); saveTimer=setTimeout(saveStateNow, SAVE_DEBOUNCE_MS); }

let _saving=false,_saveAgain=false;
async function saveStateNow(){
  if(_saving){ _saveAgain=true; return; }
  _saving=true;
  try{
    const { map, mergedPxToday, mergedTotalPx } = await readAndMerge();
    await setStore({ scrollHistory: map, totalPx: mergedTotalPx });
    pxToday=mergedPxToday; totalPx=mergedTotalPx;

    const mergedLevel=progressInCurrentLevel(totalPx).level;
    if(mergedLevel>totalLevel){
      totalLevel=mergedLevel;
      suppressNextLevelUp=true; // 병합발 상승은 팝업 억제
      updateBadge();
    }
    lastSavedPx=pxToday;
  }catch(e){ console.debug("saveStateNow() deferred/failed:", e); }
  finally{ _saving=false; if(_saveAgain){ _saveAgain=false; saveStateNow(); } }
}

async function loadState(){
  const key=todayKey();
  const obj=await getStore(["scrollHistory","totalPx","badgeEnabled"]);
  const map=obj.scrollHistory||{}; const rec=map[key]||{px:0};
  pxToday=rec.px||0; totalPx=obj.totalPx||0; totalLevel=progressInCurrentLevel(totalPx).level;
  today=key; badgeEnabled=obj.badgeEnabled!==false;
  updateBadge();
}

// ===== 이벤트 =====
function recordScroll(dy){
  if (!dy) return;
  if (!IS_TOP_FRAME) {
    framePendingPx+=dy;
    if (!frameSendTimer) {
      frameSendTimer=setTimeout(()=>{
        chrome.runtime.sendMessage({ type:"SCROLL_DELTA", dy:framePendingPx });
        framePendingPx=0;
        frameSendTimer=null;
      }, 100);
    }
    return;
  }
  pxToday+=dy; totalPx+=dy;
  const cur=progressInCurrentLevel(totalPx);
  if(cur.level>totalLevel){
    if(suppressNextLevelUp){ totalLevel=cur.level; suppressNextLevelUp=false; }
    else { totalLevel=cur.level; showLevelUpAnimation(totalLevel); }
  }
  updateBadge();
  if(dy>=BIG_JUMP_SAVE_THRESHOLD) saveStateNow();
  else saveStateDebounced();
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

function onVisibilityChange(){
  if(!document.hidden){
    const key=todayKey();
    if(key!==today) loadState();
  } else {
    saveStateNow(); // 가려질 때 즉시 저장
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SCROLL_DELTA" && IS_TOP_FRAME && Number.isFinite(msg.dy) && msg.dy>0) {
      recordScroll(msg.dy);
      return;
    }
    if (msg && msg.type === "BADGE_TOGGLE" && IS_TOP_FRAME) {
      badgeEnabled = !!msg.value;
      if (!badgeEnabled) {
        const ex = document.getElementById(BADGE_ID);
        if (ex) ex.remove();
      } else {
        updateBadge();
      }
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
    return;
  }
  if (!document.documentElement) {
    await new Promise(resolve=>document.addEventListener("DOMContentLoaded", resolve, { once:true }));
  }
  ensureBadge();              // 문서 루트가 준비되면 배지 표시
  await loadState();          // 최신값 로드
  updateBadge();

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", ()=>{ saveStateNow(); }, { capture:true });
  window.addEventListener("beforeunload", ()=>{ saveStateNow(); }, { capture:true });

  setInterval(()=>{ pagePosition={ x:window.scrollX||0, y:window.scrollY||0 }; }, 1500); // SPA 보정
  setInterval(()=>{ saveStateNow(); }, 5000);                  // 주기 백업
})();
