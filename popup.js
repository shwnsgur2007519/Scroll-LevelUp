const CIRC = 339.292;
const DEFAULT_GOAL = 50000;
const BASE_STEP_PX = 5000;
const INCREMENT    = 2500;

// ===== Runtime/Queue & 캐시 (content와 동일) =====
function hasRuntime(){ return typeof chrome!=="undefined" && chrome.runtime && chrome.runtime.id && typeof chrome.runtime.sendMessage==="function"; }
const PENDING_KEY="slu_pending", CACHE_KEY="slu_cache";
function readJSON(k){ try{return JSON.parse(localStorage.getItem(k)||"{}");}catch{return{};} }
function writeJSON(k,o){ localStorage.setItem(k,JSON.stringify(o||{})); }
function merge(o,p){ return { ...(o||{}), ...(p||{}) }; }
function pick(all,keys){ if(!keys) return all; const out={}; for(const k of keys) out[k]=all[k]; return out; }

async function getStore(keys){
  if(hasRuntime()){
    const pending=readJSON(PENDING_KEY);
    if(Object.keys(pending).length){
      await chrome.runtime.sendMessage({type:"LS_SET",payload:pending});
      writeJSON(PENDING_KEY,{});
    }
    const fresh=await chrome.runtime.sendMessage({type:"LS_GET",keys});
    const cache=readJSON(CACHE_KEY); writeJSON(CACHE_KEY, merge(cache,fresh));
    return fresh;
  }
  const cache=readJSON(CACHE_KEY), pending=readJSON(PENDING_KEY);
  return pick(merge(cache,pending), keys);
}
async function setStore(payload){
  if(hasRuntime()){
    const cache=readJSON(CACHE_KEY); writeJSON(CACHE_KEY, merge(cache,payload));
    return await chrome.runtime.sendMessage({type:"LS_SET",payload});
  }
  const pending=readJSON(PENDING_KEY); writeJSON(PENDING_KEY, merge(pending,payload));
  const cache=readJSON(CACHE_KEY); writeJSON(CACHE_KEY, merge(cache,payload));
  return {ok:true,offline:true};
}

// ===== 난이도 유틸 =====
function reqForLevel(n){ return BASE_STEP_PX + INCREMENT * Math.max(0,n-1); }
function cumForLevel(n){ if(n<=0) return 0; return (n*(2*BASE_STEP_PX+(n-1)*INCREMENT))/2; }
function levelFromTotalPx(T){ let lo=0,hi=100000; while(lo<hi){ const m=Math.floor((lo+hi+1)/2); if(cumForLevel(m)<=T) lo=m; else hi=m-1; } return lo; }
function progressInCurrentLevel(T){ const L=levelFromTotalPx(T); const base=cumForLevel(L); const need=reqForLevel(L+1); const prog=Math.max(0,T-base); const pct=Math.max(0,Math.min(1,prog/need)); return {level:L,needToNext:need,progressed:prog,pctInLevel:pct}; }

const fmt=(n)=> (n||0).toLocaleString();
function todayKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }

async function render(){
  const key=todayKey();
  const { scrollHistory={}, totalPx=0, badgeEnabled=true } = await getStore(["scrollHistory","totalPx","badgeEnabled"]);
  const rec=scrollHistory[key]||{px:0,goal:DEFAULT_GOAL};
  const pxToday=rec.px||0; const goal=rec.goal||DEFAULT_GOAL;

  const cur=progressInCurrentLevel(totalPx);
  const levelTotal=cur.level;
  const intoLevel=cur.progressed;
  const pxToNext=Math.max(0, Math.round(cur.needToNext - intoLevel));

  setText("pxToday", fmt(Math.floor(pxToday)));
  setText("levelTotal", levelTotal);
  setText("pxTotal", fmt(Math.floor(totalPx)));
  setText("pxToNext", fmt(Math.floor(pxToNext)));
  setText("stepPx", fmt(cur.needToNext));
  setText("goalPx", fmt(goal));

  const p=Math.max(0,Math.min(100,Math.round((cur.pctInLevel)*100)));
  const ring=document.getElementById("ringFg"); if(ring) ring.style.strokeDashoffset=String(CIRC*(1-p/100));
  setText("progressText", `${p}%`);

  const toggle=document.getElementById("toggleBadge");
  if(toggle) toggle.checked=!!badgeEnabled;
}

// 액션
document.getElementById("resetToday")?.addEventListener("click", async ()=>{
  const key=todayKey();
  const st=await getStore(["scrollHistory"]);
  const map=st.scrollHistory||{}; const old=map[key]||{goal:DEFAULT_GOAL};
  map[key]={ ...old, px:0, goal: old.goal??DEFAULT_GOAL, step: BASE_STEP_PX, updatedAt: Date.now() };
  await setStore({ scrollHistory: map }); await render();
});

// 스토리지 변경 시 즉시 반영(가능한 경우)
if (typeof chrome!=="undefined" && chrome.storage && chrome.storage.onChanged){
  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area==="local" && (changes.scrollHistory || changes.totalPx || changes.badgeEnabled)) render();
  });
}

render();

document.getElementById("toggleBadge")?.addEventListener("change", async (e) => {
  const on = !!e.target.checked;
  await setStore({ badgeEnabled: on });

  // 컨텐츠 스크립트가 즉시 반영할 수 있게 브로드캐스트
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try { await chrome.runtime.sendMessage({ type: "BADGE_TOGGLE", value: on }); } catch {}
  }
});