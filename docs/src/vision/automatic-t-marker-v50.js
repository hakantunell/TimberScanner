const video = document.querySelector('#camera');
const host = document.querySelector('#rotation-scale-panel');

const tracker = {
  center: null,
  radius: 44,
  raw: null,
  unwrapped: null,
  zero: null,
  velocity: 0,
  confidence: 0,
  asymmetry: 0,
  locked: false,
  lostFrames: 0,
  frameNo: 0,
  timer: 0,
  rows: [],
  latestProfileQuality: null,
  mmPerPixel: Number(localStorage.getItem('timberscanner.mmPerPixel') || 0),
};

function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function delta(a, b) { let d = norm(a) - norm(b); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

function buildUi() {
  if (!host || document.querySelector('#t50-panel')) return;
  const old49 = document.querySelector('#t49-panel');
  if (old49) old49.hidden = true;
  const oldList = document.querySelector('#profile-angle-list');
  if (oldList) oldList.hidden = true;

  const panel = document.createElement('section');
  panel.id = 't50-panel';
  panel.className = 'diagnostic-panel';
  panel.innerHTML = `
    <div class="diagnostic-heading">
      <div><p class="eyebrow">Automatisk rotationsföljning</p><h2>Stockände och T-markör</h2></div>
      <div><strong id="t50-status">Söker efter T-markören…</strong><span id="t50-detail">Ingen manuell centrum- eller riktningsmarkering behövs</span></div>
    </div>
    <div class="segmentation-lab-actions">
      <button id="t50-rescan" type="button">Sök om automatiskt</button>
      <button id="t50-zero" class="secondary" type="button" disabled>Nollställ aktuell vinkel</button>
      <button id="t50-copy" class="secondary" type="button">Kopiera diagnos</button>
      <button id="t50-clear" class="secondary" type="button">Rensa diagnos</button>
    </div>
    <div class="segmentation-lab-grid">
      <figure class="segmentation-lab-view"><canvas id="t50-canvas" width="640" height="360"></canvas><figcaption>Automatiskt centrum, T-form och spårning</figcaption></figure>
      <article class="segmentation-candidate selected"><strong id="t50-angle">Rotation: –</strong><small id="t50-quality">Söker över hela bilden</small></article>
    </div>
    <label class="laser-setting" style="margin-top:12px">Kopierbar diagnostik<textarea id="t50-log" rows="16" readonly style="width:100%;font-family:ui-monospace,monospace;white-space:pre"></textarea></label>
    <p class="diagnostic-note">Skärningspunkten mellan T-stammen och tvärstrecket används som stockändens centrum. Centrum följer stocken när den rullar och förflyttas. Vid tappad spårning söker programmet automatiskt om i hela bilden.</p>`;
  host.insertAdjacentElement('afterend', panel);

  panel.querySelector('#t50-rescan').addEventListener('click', resetLock);
  panel.querySelector('#t50-zero').addEventListener('click', () => {
    if (!Number.isFinite(tracker.unwrapped)) return;
    tracker.zero = tracker.unwrapped;
    updateDisplay();
    logRow('ZERO', currentFields());
  });
  panel.querySelector('#t50-copy').addEventListener('click', async () => {
    const text = panel.querySelector('#t50-log').value;
    try { await navigator.clipboard.writeText(text); setStatus('Diagnos kopierad', `${text.length} tecken`); }
    catch { panel.querySelector('#t50-log').select(); document.execCommand('copy'); }
  });
  panel.querySelector('#t50-clear').addEventListener('click', () => { tracker.rows.length = 0; renderLog(); });
}

function resetLock() {
  tracker.center = null;
  tracker.raw = null;
  tracker.unwrapped = null;
  tracker.zero = null;
  tracker.velocity = 0;
  tracker.confidence = 0;
  tracker.asymmetry = 0;
  tracker.locked = false;
  tracker.lostFrames = 0;
  setStatus('Söker efter T-markören…', 'Global automatisk sökning pågår');
}

function setStatus(a, b) {
  const s = document.querySelector('#t50-status');
  const d = document.querySelector('#t50-detail');
  if (s) s.textContent = a;
  if (d) d.textContent = b;
}

function capture() {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const scale = Math.min(1, 640 / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
  return c;
}

function luminance(data, w, h, x, y) {
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return 255;
  const i = (iy * w + ix) * 4;
  return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
}

function localStats(data, w, h, cx, cy, r) {
  const values = [];
  for (let y = Math.max(0, cy-r); y <= Math.min(h-1, cy+r); y += 4) {
    for (let x = Math.max(0, cx-r); x <= Math.min(w-1, cx+r); x += 4) {
      if (Math.hypot(x-cx, y-cy) <= r) values.push(luminance(data,w,h,x,y));
    }
  }
  if (values.length < 20) return null;
  values.sort((a,b)=>a-b);
  return {
    dark: values[Math.floor(values.length*.18)],
    median: values[Math.floor(values.length*.55)],
    bright: values[Math.floor(values.length*.82)],
  };
}

function darkness(data,w,h,x,y,threshold) {
  return Math.max(0, threshold - luminance(data,w,h,x,y));
}

// T geometry used here: the crossbar passes through the stock-end centre,
// while the stem starts at the centre and points in one unique direction.
function scoreT(data,w,h,cx,cy,r,angle) {
  const stats = localStats(data,w,h,cx,cy,r);
  if (!stats || stats.bright-stats.dark < 18) return null;
  const threshold = stats.dark + (stats.median-stats.dark)*.58 + 6;
  const rad=angle*Math.PI/180, ux=Math.cos(rad), uy=Math.sin(rad), px=-uy, py=ux;
  let stem=0, oppositeStem=0, cross=0, shoulders=0, samples=0;

  // Stem from the centre toward the unique end.
  for (let t=.05; t<=.78; t+=.055) {
    for (const off of [-2,0,2]) {
      stem += darkness(data,w,h,cx+ux*r*t+px*off,cy+uy*r*t+py*off,threshold);
      oppositeStem += darkness(data,w,h,cx-ux*r*t+px*off,cy-uy*r*t+py*off,threshold);
      samples += 2;
    }
  }
  // Crossbar through the centre.
  for (let q=-.58; q<=.58; q+=.055) {
    for (const off of [-2,0,2]) cross += darkness(data,w,h,cx+px*r*q+ux*off,cy+py*r*q+uy*off,threshold);
  }
  // Reward dark arms on both sides of centre, not just one random line.
  for (const sign of [-1,1]) {
    for (let q=.22; q<=.58; q+=.07) shoulders += darkness(data,w,h,cx+px*r*q*sign,cy+py*r*q*sign,threshold);
  }

  const asymmetry = stem - oppositeStem*.82;
  const contrast = stats.bright - stats.dark;
  const score = stem*.72 + cross*.72 + shoulders*.45 + asymmetry*.92 + contrast*18;
  return { cx,cy,r,angle:norm(angle),score,asymmetry,stem,cross,contrast };
}

function globalSearch(image) {
  const ctx=image.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,image.width,image.height);
  let best=null;
  const minR=Math.max(22,Math.round(Math.min(image.width,image.height)*.055));
  const maxR=Math.max(minR+8,Math.round(Math.min(image.width,image.height)*.18));
  const step=Math.max(12,Math.round(minR*.55));

  // Search mainly where an object can reasonably fit, but do not assume left/right.
  for(let r=minR;r<=maxR;r+=Math.max(8,Math.round(minR*.38))){
    for(let cy=r;cy<image.height-r;cy+=step){
      for(let cx=r;cx<image.width-r;cx+=step){
        for(let a=0;a<360;a+=15){
          const hit=scoreT(img.data,image.width,image.height,cx,cy,r,a);
          if(hit&&(!best||hit.score>best.score))best=hit;
        }
      }
    }
  }
  if(!best)return null;

  // Refine centre, radius and angle around the coarse result.
  let refined=best;
  for(let cy=best.cy-step;cy<=best.cy+step;cy+=3){
    for(let cx=best.cx-step;cx<=best.cx+step;cx+=3){
      for(let r=Math.max(18,best.r-10);r<=best.r+10;r+=4){
        for(let a=best.angle-18;a<=best.angle+18;a+=3){
          const hit=scoreT(img.data,image.width,image.height,cx,cy,r,a);
          if(hit&&hit.score>refined.score)refined=hit;
        }
      }
    }
  }
  return refineConfidence(refined,best.score);
}

function localSearch(image) {
  if(!tracker.center||!Number.isFinite(tracker.raw))return null;
  const ctx=image.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,image.width,image.height);
  const predicted=tracker.raw+tracker.velocity;
  let best=null, second=null;
  for(let cy=tracker.center.y-14;cy<=tracker.center.y+14;cy+=2){
    for(let cx=tracker.center.x-14;cx<=tracker.center.x+14;cx+=2){
      for(let r=Math.max(18,tracker.radius-8);r<=tracker.radius+8;r+=3){
        for(let a=predicted-34;a<=predicted+34;a+=2){
          const hit=scoreT(img.data,image.width,image.height,cx,cy,r,a);
          if(!hit)continue;
          hit.score += Math.max(0,160-Math.abs(delta(hit.angle,predicted))*4);
          if(!best||hit.score>best.score){second=best;best=hit;}else if(!second||hit.score>second.score)second=hit;
        }
      }
    }
  }
  if(!best)return null;
  return refineConfidence(best,second?.score||0);
}

function refineConfidence(hit, runnerUpScore) {
  const margin=(hit.score-runnerUpScore)/Math.max(1,Math.abs(hit.score));
  const shape=Math.max(0,hit.asymmetry)/Math.max(1,hit.stem);
  return {...hit,confidence:Math.max(0,margin*8+shape*4)};
}

function accept(hit) {
  if(!hit)return false;
  if(!tracker.locked){
    if(hit.confidence<.32||hit.asymmetry<8)return false;
    tracker.center={x:hit.cx,y:hit.cy};
    tracker.radius=hit.r;
    tracker.raw=hit.angle;
    tracker.unwrapped=hit.angle;
    tracker.zero=hit.angle; // first reliable pose is automatically 0 degrees
    tracker.velocity=0;
    tracker.locked=true;
    tracker.lostFrames=0;
    tracker.confidence=hit.confidence;
    tracker.asymmetry=hit.asymmetry;
    document.querySelector('#t50-zero').disabled=false;
    logRow('LOCK',currentFields());
    return true;
  }

  const d=delta(hit.angle,tracker.raw);
  if(Math.abs(d)>48&&hit.confidence<1.2)return false;
  const step=d*.48;
  tracker.raw=norm(tracker.raw+step);
  tracker.unwrapped+=step;
  tracker.velocity=tracker.velocity*.70+step*.30;
  tracker.center.x=tracker.center.x*.58+hit.cx*.42;
  tracker.center.y=tracker.center.y*.58+hit.cy*.42;
  tracker.radius=tracker.radius*.72+hit.r*.28;
  tracker.confidence=hit.confidence;
  tracker.asymmetry=hit.asymmetry;
  tracker.lostFrames=0;
  return true;
}

function currentFields(){
  const total=Number.isFinite(tracker.unwrapped)&&Number.isFinite(tracker.zero)?tracker.unwrapped-tracker.zero:null;
  const wrapped=total==null?null:norm(total);
  const direction=tracker.velocity>.12?'medurs':tracker.velocity<-.12?'moturs':'stilla';
  return {angleWrapped:wrapped,angleTotal:total,direction,velocity:tracker.velocity,confidence:tracker.confidence,asymmetry:tracker.asymmetry,centerX:tracker.center?.x,centerY:tracker.center?.y,radius:tracker.radius,locked:tracker.locked};
}

function updateDisplay(){
  const v=currentFields();
  const a=document.querySelector('#t50-angle'),q=document.querySelector('#t50-quality');
  if(a)a.textContent=v.angleTotal==null?'Rotation: –':`Rotation: ${v.angleWrapped.toFixed(1)}° · totalt ${v.angleTotal.toFixed(1)}°`;
  if(q)q.textContent=tracker.locked?`centrum ${v.centerX.toFixed(1)}, ${v.centerY.toFixed(1)} · radie ${v.radius.toFixed(1)} px · ${v.direction} · ${v.velocity.toFixed(2)}°/bild · säkerhet ${v.confidence.toFixed(2)}`:'Söker över hela bilden';
  return v;
}

function draw(frame,hit){
  const c=document.querySelector('#t50-canvas');if(!c||!frame)return;
  c.width=frame.width;c.height=frame.height;const x=c.getContext('2d');x.drawImage(frame,0,0);
  if(!tracker.center)return;
  x.strokeStyle='#35ff75';x.lineWidth=2;x.beginPath();x.arc(tracker.center.x,tracker.center.y,tracker.radius,0,Math.PI*2);x.stroke();
  if(Number.isFinite(tracker.raw)){
    const r=tracker.raw*Math.PI/180,ux=Math.cos(r),uy=Math.sin(r),px=-uy,py=ux;
    x.beginPath();x.moveTo(tracker.center.x,tracker.center.y);x.lineTo(tracker.center.x+ux*tracker.radius*.80,tracker.center.y+uy*tracker.radius*.80);x.stroke();
    x.beginPath();x.moveTo(tracker.center.x-px*tracker.radius*.58,tracker.center.y-py*tracker.radius*.58);x.lineTo(tracker.center.x+px*tracker.radius*.58,tracker.center.y+py*tracker.radius*.58);x.stroke();
    x.fillStyle='#35ff75';x.beginPath();x.arc(tracker.center.x,tracker.center.y,3.5,0,Math.PI*2);x.fill();
  }
}

function logRow(type,fields={}){
  tracker.rows.push({time:new Date().toISOString().slice(11,23),type,...fields});
  if(tracker.rows.length>600)tracker.rows.shift();
  renderLog();
}
function renderLog(){
  const t=document.querySelector('#t50-log');if(!t)return;
  const cols=['time','type','angleWrapped','angleTotal','direction','velocityDegPerFrame','tConfidence','tAsymmetry','centerX','centerY','radius','locked','profile','quality','points','runPct','sigmaPx','stabilityPx','changePx','mmPerPixel'];
  const lines=tracker.rows.map(r=>[r.time,r.type,r.angleWrapped??'',r.angleTotal??'',r.direction??'',r.velocity??'',r.confidence??'',r.asymmetry??'',r.centerX??'',r.centerY??'',r.radius??'',r.locked??'',r.profile??'',r.quality??'',r.points??'',r.runPct??'',r.sigma??'',r.stability??'',r.change??'',r.mmPerPixel??''].join('\t'));
  t.value=[cols.join('\t'),...lines].join('\n');t.scrollTop=t.scrollHeight;
}

function tick(){
  const frame=capture();
  if(frame){
    tracker.frameNo++;
    let hit=tracker.locked?localSearch(frame):null;
    if(!hit&&(!tracker.locked||tracker.lostFrames>=3||tracker.frameNo%12===0))hit=globalSearch(frame);
    if(accept(hit)){
      const v=updateDisplay();
      setStatus(tracker.lostFrames?'T-markören återfunnen':'T-markören följs automatiskt',`${v.direction} · ${v.angleWrapped.toFixed(1)}° · centrum ${v.centerX.toFixed(0)},${v.centerY.toFixed(0)}`);
      window.dispatchEvent(new CustomEvent('timberscanner:rotation-v50',{detail:{angleDeg:v.angleWrapped,totalAngleDeg:v.angleTotal,direction:v.direction,confidence:v.confidence,velocityDegPerFrame:v.velocity,center:{x:v.centerX,y:v.centerY},radius:v.radius}}));
    }else if(tracker.locked){
      tracker.lostFrames++;
      tracker.velocity*=.75;
      setStatus('T-markören tillfälligt osäker',`${tracker.lostFrames} bildrutor tappade · söker om automatiskt`);
      if(tracker.lostFrames>10){tracker.locked=false;tracker.center=null;setStatus('T-spårningen tappad','Global automatisk återsökning pågår');logRow('LOST',currentFields());}
    }else setStatus('Söker efter T-markören…','Ingen manuell markering behövs');
    draw(frame,hit);
  }
  tracker.timer=setTimeout(tick,260);
}

window.addEventListener('timberscanner:laser-profile-quality',e=>{tracker.latestProfileQuality=e.detail||null;});
window.addEventListener('timberscanner:laser-profile-saved',e=>{
  const v=updateDisplay();const p=e.detail.profile||{};
  p.rotationAngleDeg=v.angleWrapped;p.rotationTotalAngleDeg=v.angleTotal;p.rotationDirection=v.direction;p.rotationConfidence=tracker.confidence;p.rotationCenter=tracker.center?{...tracker.center}:null;p.mmPerPixel=tracker.mmPerPixel||p.mmPerPixel||null;
  const q=tracker.latestProfileQuality||{};
  logRow('PROFILE',{...v,angleWrapped:v.angleWrapped?.toFixed?.(2),angleTotal:v.angleTotal?.toFixed?.(2),velocity:v.velocity.toFixed(3),confidence:v.confidence.toFixed(3),asymmetry:v.asymmetry.toFixed(1),centerX:v.centerX?.toFixed?.(2),centerY:v.centerY?.toFixed?.(2),radius:v.radius?.toFixed?.(2),profile:(e.detail.index??0)+1,quality:q.rating||'',points:q.points||p.points?.length||'',runPct:q.runPercent||'',sigma:q.sigma?.toFixed?.(3)||'',stability:q.stability?.toFixed?.(3)||'',change:q.change?.toFixed?.(3)||'',mmPerPixel:(tracker.mmPerPixel||p.mmPerPixel||'')});
});
window.addEventListener('timberscanner:scale-calibrated',e=>{tracker.mmPerPixel=Number(e.detail.mmPerPixel||0);logRow('SCALE',{mmPerPixel:tracker.mmPerPixel.toFixed(6)});});
window.addEventListener('pagehide',()=>clearTimeout(tracker.timer));

buildUi();renderLog();tick();