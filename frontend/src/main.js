// Displays — output manager. UI is the Displays.html reference verbatim; only
// the data layer is swapped from a mock array to the Go backend.
//
// We talk to the backend through the runtime-injected globals (window.go /
// window.runtime) rather than static wailsjs imports, so the page also loads
// in a plain browser (for tests) where those globals can be stubbed.
const backend = () => (window.go && window.go.main && window.go.main.App) || null;
function GetMonitors(){
  const b = backend();
  if(!b) return Promise.reject(new Error('backend unavailable (window.go missing)'));
  return b.GetMonitors();
}
function Apply(m){
  const b = backend();
  if(!b) return Promise.reject(new Error('backend unavailable (window.go missing)'));
  return b.Apply(m);
}
function ConfirmApply(){
  const b = backend();
  if(!b) return Promise.reject(new Error('backend unavailable (window.go missing)'));
  return b.ConfirmApply();
}
function RevertApply(){
  const b = backend();
  if(!b) return Promise.reject(new Error('backend unavailable (window.go missing)'));
  return b.RevertApply();
}
function Quit(){ if(window.runtime && window.runtime.Quit) window.runtime.Quit(); }

// ===== monitor data (populated from the backend at startup) =====
let MONITORS = [];
const SCALES = [1, 1.25, 1.33, 1.5, 1.75, 2];

let selected = null;
let loadError = null;
let drag = null;
const GRID = 13;          // screen px per grid cell (matches CSS)
const SNAP = 11;          // edge-snap threshold, screen px

const $ = s => document.querySelector(s);
const canvas = $('#canvas'), list = $('#list');

// ---------- view (layout -> screen mapping; frozen during drag) ----------
let view = {scale:1, offX:0, offY:0, minX:0, minY:0, W:0, H:0};
function fitView(){
  if(!MONITORS.length) return;
  const W=canvas.clientWidth, H=canvas.clientHeight;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  MONITORS.forEach(m=>{ minX=Math.min(minX,m.x); minY=Math.min(minY,m.y);
    maxX=Math.max(maxX,m.x+lw(m)); maxY=Math.max(maxY,m.y+lh(m)); });
  const bw=maxX-minX, bh=maxY-minY;
  const scale=Math.min((W*0.74)/bw,(H*0.74)/bh);
  view={ scale, minX, minY, W, H, offX:(W-bw*scale)/2, offY:(H-bh*scale)/2 };
}
const toScreenX = lx => view.offX + (lx-view.minX)*view.scale;
const toScreenY = ly => view.offY + (ly-view.minY)*view.scale;
const toLayoutX = sx => Math.round(view.minX + (sx-view.offX)/view.scale);
const toLayoutY = sy => Math.round(view.minY + (sy-view.offY)/view.scale);

// ---------- adjacency (layout coords, integers) ----------
// Hyprland positions are logical pixels; an output occupies pixelSize/scale in
// the layout. All geometry below uses these logical dims, otherwise any output
// with scale != 1 would end up with real gaps/overlaps despite looking flush.
const lw = m => Math.round(m.w/(m.scale||1));
const lh = m => Math.round(m.h/(m.scale||1));

// The committed layout must stay gap-free: every active output edge-to-edge
// with the group, no overlaps, one connected cluster (GNOME model).
const xOverlap = (a,b) => Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x);
const yOverlap = (a,b) => Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
const overlaps = (a,b) => xOverlap(a,b)>0 && yOverlap(a,b)>0;
// Share an edge segment >= 1 layout px (corner-touch is not adjacency).
const touches = (a,b) =>
  (xOverlap(a,b)>0 && (a.y+a.h===b.y || b.y+b.h===a.y)) ||
  (yOverlap(a,b)>0 && (a.x+a.w===b.x || b.x+b.w===a.x));
function connected(rects){
  if(rects.length<=1) return true;
  const seen=new Set([0]), q=[0];
  while(q.length){
    const i=q.pop();
    rects.forEach((r,j)=>{ if(!seen.has(j) && touches(rects[i],r)){ seen.add(j); q.push(j); } });
  }
  return seen.size===rects.length;
}
const rect = m => ({x:m.x, y:m.y, w:lw(m), h:lh(m)});
const clampN = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

// Nearest gap-free placement of a w×h rect around fixed `others` (rects).
// Candidates: flush/aligned edges per neighbor (the same four values the live
// snap uses) plus the desired coordinate slid into each neighbor's span; the
// X×Y cross product lets a bridge output sit flush to different neighbors per
// axis. Returns {x,y} or null when no candidate keeps the group connected.
function resolvePlacement(w, h, desired, others){
  if(others.length===0) return {x:0, y:0};
  const xs=new Set([desired.x]), ys=new Set([desired.y]);
  others.forEach(o=>{
    [o.x+o.w, o.x-w, o.x, o.x+o.w-w, clampN(desired.x, o.x-w+1, o.x+o.w-1)].forEach(v=>xs.add(v));
    [o.y+o.h, o.y-h, o.y, o.y+o.h-h, clampN(desired.y, o.y-h+1, o.y+o.h-1)].forEach(v=>ys.add(v));
  });
  let best=null;
  xs.forEach(x=>ys.forEach(y=>{
    const r={x,y,w,h};
    if(others.some(o=>overlaps(r,o))) return;
    if(!others.some(o=>touches(r,o))) return;
    if(!connected([r,...others])) return;
    const d=(x-desired.x)**2 + (y-desired.y)**2;
    if(!best || d<best.d) best={x,y,d};
  }));
  return best && {x:best.x, y:best.y};
}

// Re-establish adjacency after size/scale/active changes, moving as little as
// possible: anchor stays put, the rest re-attach nearest-first.
function normalizeLayout(){
  const act=MONITORS.filter(m=>m.active);
  if(act.length===0) return;
  if(act.length===1){ act[0].x=0; act[0].y=0; return; }
  const rects=act.map(rect);
  const valid=rects.every((a,i)=>rects.every((b,j)=>i===j||!overlaps(a,b))) && connected(rects);
  if(valid) return;
  const anchor=act.find(m=>m.primary) ||
    act.reduce((p,c)=>(c.x*c.x+c.y*c.y < p.x*p.x+p.y*p.y ? c : p));
  const placed=[rect(anchor)];
  act.filter(m=>m!==anchor)
    .sort((a,b)=>((a.x-anchor.x)**2+(a.y-anchor.y)**2)-((b.x-anchor.x)**2+(b.y-anchor.y)**2))
    .forEach(m=>{
      const p=resolvePlacement(lw(m), lh(m), {x:m.x, y:m.y}, placed);
      if(p){ m.x=p.x; m.y=p.y; }
      placed.push(rect(m));
    });
}

// ---------- ARRANGEMENT ----------
function renderCanvas(){
  canvas.querySelectorAll('.mon').forEach(e=>e.remove());
  MONITORS.forEach(m=>{
    const sw=lw(m)*view.scale, sh=lh(m)*view.scale;
    const dragging = drag && drag.m===m;
    const el=document.createElement('div');
    el.className='mon'+(m.active?' on':' off')+(m.name===selected?' sel':'')
      +(dragging?' drag':'')+(dragging&&drag.snapped?' snap':'');
    el.style.left =toScreenX(m.x)+'px';
    el.style.top  =toScreenY(m.y)+'px';
    el.style.width =sw+'px';
    el.style.height=sh+'px';
    const sub = dragging ? `${m.x}, ${m.y}` : (m.active ? m.w+'×'+m.h : 'disabled');
    const showSub = sh>=42 && sw>=66;
    el.innerHTML=`${m.primary?'<span class="pri">primary</span>':''}
      <span class="mn-name">${m.name}</span>
      ${showSub?`<span class="mn-res">${sub}</span>`:''}`;
    el.addEventListener('pointerdown', e=>onGrab(e,m));
    canvas.appendChild(el);
  });
}

// ---------- drag + snap ----------
function onGrab(e,m){
  if(e.button!==0) return;
  e.preventDefault();
  selected=m.name;
  drag={ m, px:e.clientX, py:e.clientY, sx0:toScreenX(m.x), sy0:toScreenY(m.y),
         lx0:m.x, ly0:m.y, snapped:false, moved:false };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onDrop);
  render();
  // Pointermove updates only this element — a full render per move rebuilds
  // every node (selects included) and janks on the software paint path.
  drag.el = canvas.querySelector('.mon.drag');
  drag.sub = drag.el && drag.el.querySelector('.mn-res');
}
function onMove(e){
  if(!drag) return;
  const m=drag.m;
  const sw=lw(m)*view.scale, sh=lh(m)*view.scale;
  let sx=drag.sx0+(e.clientX-drag.px), sy=drag.sy0+(e.clientY-drag.py);
  if(Math.abs(e.clientX-drag.px)>2||Math.abs(e.clientY-drag.py)>2) drag.moved=true;

  // edge-snap against other active monitors (live hint; the drop solver is
  // what actually guarantees adjacency)
  let bx=null,bdx=SNAP, by=null,bdy=SNAP;
  MONITORS.forEach(o=>{ if(o===m||!o.active) return;
    const ox=toScreenX(o.x), oy=toScreenY(o.y), ow=lw(o)*view.scale, oh=lh(o)*view.scale;
    [ox+ow, ox-sw, ox, ox+ow-sw].forEach(c=>{ const d=Math.abs(sx-c); if(d<bdx){bdx=d;bx=c;} });
    [oy+oh, oy-sh, oy, oy+oh-sh].forEach(c=>{ const d=Math.abs(sy-c); if(d<bdy){bdy=d;by=c;} });
  });
  // fall back to grid snap per axis
  let nx = bx!=null ? bx : Math.round(sx/GRID)*GRID;
  let ny = by!=null ? by : Math.round(sy/GRID)*GRID;
  drag.snapped = (bx!=null || by!=null);
  // keep inside canvas
  nx=Math.max(0,Math.min(view.W-sw,nx));
  ny=Math.max(0,Math.min(view.H-sh,ny));
  m.x=toLayoutX(nx); m.y=toLayoutY(ny);
  const el=drag.el;
  if(el){
    el.style.left=toScreenX(m.x)+'px';
    el.style.top =toScreenY(m.y)+'px';
    el.classList.toggle('snap', drag.snapped);
    if(drag.sub) drag.sub.textContent=m.x+', '+m.y;
  }
}
function onDrop(){
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onDrop);
  const m=drag && drag.m, moved=drag && drag.moved;
  let stuck=false;
  if(moved && m && m.active){
    // Commit to the nearest gap-free spot; inactive outputs stay free-floating.
    const others=MONITORS.filter(o=>o!==m && o.active).map(rect);
    const p=resolvePlacement(lw(m), lh(m), {x:m.x, y:m.y}, others);
    if(p){ m.x=p.x; m.y=p.y; }
    else { m.x=drag.lx0; m.y=drag.ly0; stuck=true; }
  }
  drag=null; fitView(); render();
  if(stuck) toast('Layout must stay contiguous');
  else if(moved && m) toast(`<b>${m.name}</b> → ${m.x}, ${m.y}`);
}

// ---------- LIST ----------
function optsRes(m){ const cur=m.w+'×'+m.h;
  return m.modes.map(md=>{ const r=md.w+'×'+md.h; return `<option ${r===cur?'selected':''}>${r}</option>`; }).join(''); }
function optsRate(m){ const md=m.modes.find(x=>x.w===m.w&&x.h===m.h)||m.modes[0]||{rates:[m.rate]};
  return md.rates.map(r=>`<option value="${r}" ${r===m.rate?'selected':''}>${r} Hz</option>`).join(''); }
function optsScale(m){ return SCALES.map(s=>`<option value="${s}" ${s===m.scale?'selected':''}>${s}×</option>`).join(''); }

function renderList(){
  if(loadError){
    list.innerHTML = `<div style="padding:22px 16px;color:var(--bad);font-size:12px">⚠ ${loadError}</div>`;
    return;
  }
  if(MONITORS.length===0){
    list.innerHTML = `<div style="padding:22px 16px;color:var(--ink3);font-size:12px">No outputs detected.</div>`;
    return;
  }
  list.innerHTML = MONITORS.map(m=>{
    const off = m.active?'':'disabled';
    return `
    <div class="row${m.active?'':' dis'}${m.name===selected?' sel':''}" data-name="${m.name}">
      <span class="led ${m.active?'good':'off'}"></span>
      <div class="r-name">${m.name}${m.primary?'<span class="pill">primary</span>':''}<small>${m.make? m.make+' · ':''}${m.model}</small></div>
      <div class="r-pos">POS <b>${m.active? m.x+','+m.y : '—'}</b></div>
      <select class="sel" data-fld="res"   data-name="${m.name}" ${off}>${optsRes(m)}</select>
      <select class="sel" data-fld="rate"  data-name="${m.name}" ${off}>${optsRate(m)}</select>
      <select class="sel" data-fld="scale" data-name="${m.name}" ${off}>${optsScale(m)}</select>
      <div class="sw${m.active?' on':''}" data-sw="${m.name}">
        <span class="txt l">on</span><span class="txt r">off</span><span class="knob"></span>
      </div>
    </div>`; }).join('');
}

function renderMeta(){
  const total=MONITORS.length, on=MONITORS.filter(m=>m.active).length;
  $('#arr-meta').textContent = on+' active';
  $('#list-meta').textContent = total+' detected';
  $('#foot-note').innerHTML = `<b>${on}</b> of <b>${total}</b> outputs active`;
}

function render(){ renderCanvas(); renderList(); renderMeta(); }

// ---------- inline mode changes (per row) ----------
list.addEventListener('change', e=>{
  const s=e.target.closest('select[data-fld]'); if(!s) return;
  const m=MONITORS.find(x=>x.name===s.dataset.name); if(!m) return;
  selected=m.name;
  if(s.dataset.fld==='res'){
    const [w,h]=s.value.split('×').map(Number); m.w=w; m.h=h;
    const md=m.modes.find(x=>x.w===w&&x.h===h);
    if(md && !md.rates.includes(m.rate)) m.rate=Math.max(...md.rates);
    normalizeLayout(); fitView(); render(); toast(`<b>${m.name}</b> → ${w}×${h} @${m.rate}Hz`);
  } else if(s.dataset.fld==='rate'){
    m.rate=parseInt(s.value,10); render(); toast(`<b>${m.name}</b> → ${m.rate} Hz`);
  } else if(s.dataset.fld==='scale'){
    // Scale changes the output's logical footprint — re-glue the layout.
    m.scale=parseFloat(s.value); normalizeLayout(); fitView(); render(); toast(`<b>${m.name}</b> → scale ${m.scale}×`);
  }
});

// ---------- interaction ----------
function toggle(name){
  const m=MONITORS.find(x=>x.name===name);
  if(!m) return;
  const others=MONITORS.filter(x=>x.active).length;
  if(m.active && others<=1){ toast('At least one output must stay active'); return; }
  m.active=!m.active;
  selected=name;
  // Enabling pulls the output into the cluster; disabling repairs the hole it
  // may leave behind (a bridge output between two neighbors).
  normalizeLayout();
  fitView(); render();
  toast(`<b>${m.name}</b> ${m.active?'enabled':'disabled'}`);
}

list.addEventListener('click', e=>{
  if(e.target.closest('select')) return;        // let dropdowns work untouched
  const sw=e.target.closest('[data-sw]');
  if(sw){ toggle(sw.dataset.sw); return; }
  const row=e.target.closest('[data-name]');
  if(row){ selected=row.dataset.name; render(); }
});

document.querySelector('.footer').addEventListener('click', e=>{
  const b=e.target.closest('[data-act]'); if(!b) return;
  if(b.dataset.act==='apply') apply();
  if(b.dataset.act==='reset') reload('Reset — reloaded live state');
});

// ---------- backend wiring ----------
// Apply is two-phase: the layout goes live immediately but stays pending until
// confirmed. The Go side runs the authoritative auto-revert timer; the modal
// countdown here is cosmetic and calls RevertApply itself at zero (the call is
// idempotent, so racing the backend timer is safe).
let cdTimer=null, cdDeadline=0;
const confirmOpen = () => !$('#confirm').hidden;

function openConfirm(){
  cdDeadline=Date.now()+(window.__testRevertSecs||10)*1000;
  $('#confirm').hidden=false;
  updateCountdown();
  cdTimer=setInterval(updateCountdown,250);
}
function closeConfirm(){
  clearInterval(cdTimer); cdTimer=null;
  $('#confirm').hidden=true;
}
function updateCountdown(){
  const left=Math.max(0,Math.ceil((cdDeadline-Date.now())/1000));
  $('#cd').textContent=left;
  if(left<=0) revertNow();
}

async function keepChanges(){
  closeConfirm();
  try{
    await ConfirmApply();
    toast('Configuration applied');
  }catch(err){
    toast(`<b>Confirm failed</b> — ${err}`);
  }
}
async function revertNow(){
  closeConfirm();
  try{
    MONITORS = (await RevertApply()) || [];
    if(!MONITORS.some(m=>m.name===selected)) selected = MONITORS[0] ? MONITORS[0].name : null;
    fitView(); render();
    toast('Reverted to previous configuration');
  }catch(err){
    toast(`<b>Revert failed</b> — ${err}`);
  }
}

async function apply(){
  try{
    const res = await Apply(MONITORS);
    MONITORS = res || [];
    if(!MONITORS.some(m=>m.name===selected)) selected = MONITORS[0] ? MONITORS[0].name : null;
    fitView(); render();
    openConfirm();
  }catch(err){
    toast(`<b>Apply failed</b> — ${err}`);
  }
}

$('#confirm').addEventListener('click', e=>{
  const b=e.target.closest('[data-mact]'); if(!b) return;
  if(b.dataset.mact==='keep') keepChanges();
  if(b.dataset.mact==='revert') revertNow();
});

async function reload(msg){
  try{
    MONITORS = (await GetMonitors()) || [];
    loadError = null;
    if(!MONITORS.some(m=>m.name===selected)) selected = MONITORS[0] ? MONITORS[0].name : null;
    fitView(); render();
    if(msg) toast(msg);
  }catch(err){
    loadError = String(err && err.message || err);
    MONITORS = [];
    render();
    toast(`<b>Load failed</b> — ${loadError}`);
  }
}

let tt;
function toast(html){ const t=$('#toast'); t.innerHTML=html; t.classList.add('show');
  clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('show'),1900); }

// Esc closes the (frameless) window — but with the confirm dialog open it
// means "revert now" (the backend would revert on close anyway).
window.addEventListener('keydown', e=>{ if(e.key==='Escape'){ confirmOpen() ? revertNow() : Quit(); } });

// Refit on any canvas size change (window resize or flex reflow). A
// ResizeObserver delivers at most once per frame, so no extra throttling; the
// list/meta don't depend on canvas size, so only the canvas re-renders.
new ResizeObserver(()=>{ if(!drag){ fitView(); renderCanvas(); } }).observe(canvas);

reload();
