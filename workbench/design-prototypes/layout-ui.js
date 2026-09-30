(() => {
  const key='evaldock.sidebar.width.v1', root=document.documentElement;
  let preferred=246;
  try { const saved=Number(localStorage.getItem(key)); if(Number.isFinite(saved)&&saved>=200&&saved<=480)preferred=saved; } catch {}
  const handle=document.createElement('div');
  handle.className='sidebar-resizer';
  handle.tabIndex=0;
  handle.setAttribute('role','separator');
  handle.setAttribute('aria-orientation','vertical');
  handle.setAttribute('aria-label','调整左侧导航宽度');
  handle.title='拖动调整宽度；双击恢复默认；方向键微调';
  document.body.append(handle);
  const max=()=>Math.max(200,Math.min(480,Math.floor(innerWidth*.4)));
  const clamp=n=>Math.max(200,Math.min(max(),Math.round(n)));
  function paint(){
    root.style.setProperty('--nav-preferred-width',preferred+'px');
    handle.setAttribute('aria-valuemin','200');
    handle.setAttribute('aria-valuemax',String(max()));
    handle.setAttribute('aria-valuenow',String(clamp(preferred)));
  }
  function save(){try{localStorage.setItem(key,String(preferred));}catch{}}
  let drag=null;
  handle.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;
    e.preventDefault();handle.focus({preventScroll:true});
    drag={id:e.pointerId,x:e.clientX,width:clamp(preferred)};
    handle.setPointerCapture(e.pointerId);root.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.id)return;
    preferred=clamp(drag.width+e.clientX-drag.x);paint();
  });
  function finish(e){
    if(!drag||e.pointerId!==drag.id)return;
    drag=null;root.classList.remove('sidebar-resizing');save();
  }
  handle.addEventListener('pointerup',finish);
  handle.addEventListener('pointercancel',finish);
  handle.addEventListener('lostpointercapture',finish);
  handle.addEventListener('dblclick',()=>{preferred=246;paint();save();});
  handle.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    preferred=e.key==='Home'?200:e.key==='End'?max():clamp(clamp(preferred)+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?32:8));
    paint();save();
  });
  addEventListener('resize',paint);paint();
})();
