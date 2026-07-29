const video = document.querySelector('#camera');
const host = document.querySelector('#rotation-scale-panel');

const state = {
  locked: false,
  center: null,
  radius: 42,
  raw: null,
  unwrapped: null,
  zero: null,
  velocity: 0,
  confidence: 0,
  shapeScore: 0,
  timer: 0,
  lost: 0,
  rows: [],
  candidates: [],
  latestProfileQuality: null,
  mmPerPixel: Number(localStorage.getItem('timberscanner.mmPerPixel') || 0),
};

function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function delta(a, b) { let d = norm(a) - norm(b); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

function buildUi() {
  if (!host || document.querySelector('#t51-panel')) return;
  for (const id of ['t49-panel', 't50-panel']) {
    const old = document.querySelector(`#${id}`);
    if (old) old.hidden = true;
  }
  const panel = document.createElement('section');
  panel.id = 't51-panel';
  panel.className = 'diagnostic-panel';
  panel.innerHTML = `
    <div class="diagnostic-heading">
      <div><p class="eyebrow">Strikt rotationsföljning</p><h2>Svartvit T-geometri</h2></div>
      <div><strong id="t51-status">Söker efter ett komplett T…</strong><span id="t51-detail">En ensam linje kan inte godkännas</span></div>
    </div>
    <div class="segmentation-lab-actions">
      <button id="t51-rescan" type="button">Sök om automatiskt</button>
      <button id="t51-zero" class="secondary" type="button" disabled>Nollställ aktuell vinkel</button>
      <button id="t51-copy" class="secondary" type="button">Kopiera diagnos</button>
      <button id="t51-clear" class="secondary" type="button">Rensa diagnos</button>
    </div>
    <div class="segmentation-lab-grid">
      <figure class="segmentation-lab-view"><canvas id="t51-canvas" width="640" height="360"></canvas><figcaption>Bästa kandidater: grönt = valt, gult = alternativ</figcaption></figure>
      <article class="segmentation-candidate selected"><strong id="t51-angle">Rotation: –</strong><small id="t51-quality">Söker i gråskala</small></article>
    </div>
    <div id="t51-candidates" class="segmentation-candidates"></div>
    <label class="laser-setting" style="margin-top:12px">Kopierbar diagnostik<textarea id="t51-log" rows="16" readonly style="width:100%;font-family:ui-monospace,monospace;white-space:pre"></textarea></label>
    <p class="diagnostic-note">Ett T godkänns endast när stammen, vänster arm och höger arm alla är tydliga och möts i samma skärningspunkt. Färg används inte.</p>`;
  host.insertAdjacentElement('afterend', panel);

  panel.querySelector('#t51-rescan').addEventListener('click', reset);
  panel.querySelector('#t51-zero').addEventListener('click', () => {
    if (!Number.isFinite(state.unwrapped)) return;
    state.zero = state.unwrapped;
    updateDisplay();
    logRow('ZERO', fields());
  });
  panel.querySelector('#t51-copy').addEventListener('click', async () => {
    const text = panel.querySelector('#t51-log').value;
    try { await navigator.clipboard.writeText(text); setStatus('Diagnos kopierad', `${text.length} tecken`); }
    catch { panel.querySelector('#t51-log').select(); document.execCommand('copy'); }
  });
  panel.querySelector('#t51-clear').addEventListener('click', () => { state.rows.length = 0; renderLog(); });
}

function reset() {
  state.locked = false; state.center = null; state.raw = null; state.unwrapped = null;
  state.zero = null; state.velocity = 0; state.confidence = 0; state.shapeScore = 0; state.lost = 0;
  setStatus('Söker efter ett komplett T…', 'Global svartvit geometrisökning pågår');
}

function setStatus(title, detail) {
  const a = document.querySelector('#t51-status');
  const b = document.querySelector('#t51-detail');
  if (a) a.textContent = title;
  if (b) b.textContent = detail;
}

function capture() {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const scale = Math.min(1, 560 / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
  return c;
}

function lum(data, w, h, x, y) {
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return 255;
  const i = (iy * w + ix) * 4;
  return data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
}

function localThreshold(data, w, h, cx, cy, r) {
  const values = [];
  for (let y = cy-r; y <= cy+r; y += 4) for (let x = cx-r; x <= cx+r; x += 4) {
    if (Math.hypot(x-cx, y-cy) <= r) values.push(lum(data,w,h,x,y));
  }
  if (values.length < 24) return null;
  values.sort((a,b)=>a-b);
  const dark = values[Math.floor(values.length*.16)];
  const median = values[Math.floor(values.length*.55)];
  const bright = values[Math.floor(values.length*.84)];
  if (bright-dark < 24) return null;
  return { dark, median, bright, threshold: dark + (median-dark)*.72 + 5 };
}

function lineEvidence(data,w,h,cx,cy,ux,uy,px,py,r,t0,t1,halfWidth=2) {
  let darkSum=0, hits=0, count=0;
  const stats = localThreshold(data,w,h,cx,cy,r);
  if (!stats) return null;
  for (let t=t0; t<=t1; t+=.045) {
    let best=0;
    for (let off=-halfWidth; off<=halfWidth; off+=2) {
      const value = Math.max(0, stats.threshold - lum(data,w,h,cx+ux*r*t+px*off,cy+uy*r*t+py*off));
      if (value > best) best = value;
    }
    darkSum += best;
    if (best >= 7) hits += 1;
    count += 1;
  }
  return { mean: darkSum/Math.max(1,count), coverage: hits/Math.max(1,count), stats };
}

function scoreT(data,w,h,cx,cy,r,angle) {
  const rad=angle*Math.PI/180, ux=Math.cos(rad), uy=Math.sin(rad), px=-uy, py=ux;
  const stem = lineEvidence(data,w,h,cx,cy,ux,uy,px,py,r,.06,.80,2);
  if (!stem) return null;
  const opposite = lineEvidence(data,w,h,cx,cy,-ux,-uy,px,py,r,.08,.68,2);
  const left = lineEvidence(data,w,h,cx,cy,-px,-py,ux,uy,r,.08,.58,2);
  const right = lineEvidence(data,w,h,cx,cy,px,py,ux,uy,r,.08,.58,2);
  if (!opposite || !left || !right) return null;

  // Hard gates: all three real T arms must be present.
  const armMin = Math.min(left.coverage, right.coverage);
  const armBalance = Math.min(left.mean,right.mean) / Math.max(1,Math.max(left.mean,right.mean));
  if (stem.coverage < .48 || armMin < .42 || armBalance < .30) return null;
  if (stem.mean < 5.5 || Math.min(left.mean,right.mean) < 4.8) return null;

  // A T must be one-sided along the stem. Reject crosses and lone straight lines.
  const oneSided = stem.mean / Math.max(1, opposite.mean);
  if (oneSided < 1.10 && opposite.coverage > .55) return null;

  // Check that the junction itself is dark.
  let junction=0;
  for (let oy=-3;oy<=3;oy+=2) for(let ox=-3;ox<=3;ox+=2) junction += Math.max(0,stem.stats.threshold-lum(data,w,h,cx+ox,cy+oy));
  junction /= 16;
  if (junction < 4) return null;

  const completeness = Math.min(stem.coverage,left.coverage,right.coverage);
  const crossStrength = Math.min(left.mean,right.mean);
  const score = completeness*900 + stem.mean*18 + crossStrength*24 + armBalance*160 + Math.min(2.5,oneSided)*90 + junction*10;
  return { cx,cy,r,angle:norm(angle),score,stem:stem.mean,left:left.mean,right:right.mean,opposite:opposite.mean,stemCov:stem.coverage,leftCov:left.coverage,rightCov:right.coverage,armBalance,oneSided,junction,completeness };
}

function search(frame, local=false) {
  const ctx=frame.getContext('2d',{willReadFrequently:true});
  const img=ctx.getImageData(0,0,frame.width,frame.height);
  const hits=[];
  const minDim=Math.min(frame.width,frame.height);
  const radii = local && state.center ? [state.radius-8,state.radius-4,state.radius,state.radius+4,state.radius+8].filter(r=>r>=18) : [];
  if (!radii.length) for(let r=Math.max(20,Math.round(minDim*.055));r<=Math.round(minDim*.19);r+=8)radii.push(r);
  const centerStep = local ? 3 : Math.max(10,Math.round(minDim*.035));
  const x0 = local ? state.center.x-18 : 20;
  const x1 = local ? state.center.x+18 : frame.width-20;
  const y0 = local ? state.center.y-18 : 20;
  const y1 = local ? state.center.y+18 : frame.height-20;
  const predicted = Number.isFinite(state.raw) ? state.raw+state.velocity : 0;

  for(const r of radii) for(let cy=y0;cy<=y1;cy+=centerStep) for(let cx=x0;cx<=x1;cx+=centerStep) {
    if(cx-r<0||cy-r<0||cx+r>=frame.width||cy+r>=frame.height)continue;
    const aStart = local && Number.isFinite(state.raw) ? predicted-42 : 0;
    const aEnd = local && Number.isFinite(state.raw) ? predicted+42 : 345;
    const aStep = local ? 3 : 15;
    for(let a=aStart;a<=aEnd;a+=aStep){
      const hit=scoreT(img.data,frame.width,frame.height,cx,cy,r,a);
      if(!hit)continue;
      if(local) hit.score += Math.max(0,180-Math.abs(delta(hit.angle,predicted))*4);
      hits.push(hit);
    }
  }
  hits.sort((a,b)=>b.score-a.score);
  const distinct=[];
  for(const hit of hits){
    if(distinct.every(x=>Math.hypot(x.cx-hit.cx,x.cy-hit.cy)>Math.max(12,hit.r*.35)||Math.abs(delta(x.angle,hit.angle))>22)) distinct.push(hit);
    if(distinct.length>=6)break;
  }
  state.candidates=distinct;
  if(!distinct.length)return null;
  const best=distinct[0], second=distinct[1];
  const margin=(best.score-(second?.score||best.score*.72))/Math.max(1,best.score);
  return {...best,confidence:Math.max(0,margin*7+best.completeness*2+best.armBalance)};
}

function accept(hit) {
  if(!hit)return false;
  if(!state.locked){
    if(hit.confidence<1.15||hit.completeness<.47)return false;
    state.center={x:hit.cx,y:hit.cy}; state.radius=hit.r; state.raw=hit.angle;
    state.unwrapped=hit.angle; state.zero=hit.angle; state.velocity=0; state.locked=true;
    state.confidence=hit.confidence; state.shapeScore=hit.score; state.lost=0;
    document.querySelector('#t51-zero').disabled=false;
    logRow('LOCK',fields());
    return true;
  }
  const d=delta(hit.angle,state.raw);
  if(Math.abs(d)>50&&hit.confidence<2.0)return false;
  const step=d*.46;
  state.raw=norm(state.raw+step); state.unwrapped+=step; state.velocity=state.velocity*.72+step*.28;
  state.center.x=state.center.x*.55+hit.cx*.45; state.center.y=state.center.y*.55+hit.cy*.45;
  state.radius=state.radius*.72+hit.r*.28; state.confidence=hit.confidence; state.shapeScore=hit.score; state.lost=0;
  return true;
}

function fields(){
  const total=Number.isFinite(state.unwrapped)&&Number.isFinite(state.zero)?state.unwrapped-state.zero:null;
  const wrapped=total==null?null:norm(total);
  const direction=state.velocity>.12?'medurs':state.velocity<-.12?'moturs':'stilla';
  return {angleWrapped:wrapped,angleTotal:total,direction,velocity:state.velocity,confidence:state.confidence,shapeScore:state.shapeScore,centerX:state.center?.x,centerY:state.center?.y,radius:state.radius,locked:state.locked};
}

function updateDisplay(){
  const v=fields(); const a=document.querySelector('#t51-angle'), q=document.querySelector('#t51-quality');
  if(a)a.textContent=v.angleTotal==null?'Rotation: –':`Rotation: ${v.angleWrapped.toFixed(1)}° · totalt ${v.angleTotal.toFixed(1)}°`;
  const best=state.candidates[0];
  if(q)q.textContent=best?`centrum ${v.centerX?.toFixed(1)}, ${v.centerY?.toFixed(1)} · ${v.direction} · T-kompletthet ${(best.completeness*100).toFixed(0)}% · armbalans ${(best.armBalance*100).toFixed(0)}% · säkerhet ${v.confidence.toFixed(2)}`:'Inget komplett T hittat';
  return v;
}

function draw(frame){
  const c=document.querySelector('#t51-canvas');if(!c||!frame)return;c.width=frame.width;c.height=frame.height;const x=c.getContext('2d');x.drawImage(frame,0,0);
  state.candidates.slice(0,5).forEach((h,i)=>{x.strokeStyle=i===0?'#35ff75':'#ffd45e';x.lineWidth=i===0?2:1;x.globalAlpha=i===0?1:.7;drawT(x,h);});x.globalAlpha=1;
}
function drawT(x,h){const r=h.angle*Math.PI/180,ux=Math.cos(r),uy=Math.sin(r),px=-uy,py=ux;x.beginPath();x.arc(h.cx,h.cy,h.r,0,Math.PI*2);x.stroke();x.beginPath();x.moveTo(h.cx,h.cy);x.lineTo(h.cx+ux*h.r*.8,h.cy+uy*h.r*.8);x.moveTo(h.cx-px*h.r*.58,h.cy-py*h.r*.58);x.lineTo(h.cx+px*h.r*.58,h.cy+py*h.r*.58);x.stroke();}

function renderCandidates(){const host=document.querySelector('#t51-candidates');if(!host)return;host.replaceChildren(...state.candidates.slice(0,5).map((h,i)=>{const e=document.createElement('article');e.className=`segmentation-candidate ${i===0?'selected':''}`;e.innerHTML=`<strong>Kandidat ${i+1}${i===0?' · högst poäng':''}</strong><small>poäng ${h.score.toFixed(0)} · kompletthet ${(h.completeness*100).toFixed(0)}% · stam ${(h.stemCov*100).toFixed(0)}% · vänster ${(h.leftCov*100).toFixed(0)}% · höger ${(h.rightCov*100).toFixed(0)}% · armbalans ${(h.armBalance*100).toFixed(0)}% · ensidighet ${h.oneSided.toFixed(2)} · centrum ${h.cx.toFixed(0)},${h.cy.toFixed(0)}</small>`;return e;}));}

function logRow(type,extra={}){state.rows.push({time:new Date().toISOString().slice(11,23),type,...extra});if(state.rows.length>500)state.rows.shift();renderLog();}
function renderLog(){const t=document.querySelector('#t51-log');if(!t)return;const cols=['time','type','angleWrapped','angleTotal','direction','velocity','confidence','shapeScore','centerX','centerY','radius','locked','profile','quality','points','runPct','sigmaPx','stabilityPx','changePx','mmPerPixel'];t.value=[cols.join('\t'),...state.rows.map(r=>cols.map(k=>r[k]??'').join('\t'))].join('\n');t.scrollTop=t.scrollHeight;}

function tick(){
  const frame=capture();if(frame){let hit=search(frame,state.locked);if(hit&&accept(hit)){const v=updateDisplay();setStatus('Komplett T följs',`${v.direction} · ${v.angleWrapped?.toFixed(1)}° · centrum ${v.centerX?.toFixed(0)},${v.centerY?.toFixed(0)}`);window.dispatchEvent(new CustomEvent('timberscanner:rotation-v51',{detail:{angleDeg:v.angleWrapped,totalAngleDeg:v.angleTotal,direction:v.direction,confidence:v.confidence,velocityDegPerFrame:v.velocity,centerX:v.centerX,centerY:v.centerY,radius:v.radius}}));}else if(state.locked){state.lost++;setStatus('T-formen tillfälligt osäker',`Behåller senaste värde · ${state.lost} bildrutor`);if(state.lost>8)reset();}else setStatus('Inget komplett T hittat','Ensam linje förkastas; söker efter stam plus två tvärarmar');draw(frame);renderCandidates();}
  state.timer=setTimeout(tick,state.locked?240:700);
}

window.addEventListener('timberscanner:laser-profile-quality',e=>{state.latestProfileQuality=e.detail||null;});
window.addEventListener('timberscanner:laser-profile-saved',e=>{const v=updateDisplay();const p=e.detail.profile||{};p.rotationAngleDeg=v.angleWrapped;p.rotationTotalAngleDeg=v.angleTotal;p.rotationDirection=v.direction;p.rotationConfidence=v.confidence;p.mmPerPixel=state.mmPerPixel||p.mmPerPixel||null;const q=state.latestProfileQuality||{};logRow('PROFILE',{...v,profile:(e.detail.index??0)+1,quality:q.rating||'',points:q.points||p.points?.length||'',runPct:q.runPercent||'',sigmaPx:q.sigma?.toFixed?.(3)||'',stabilityPx:q.stability?.toFixed?.(3)||'',changePx:q.change?.toFixed?.(3)||'',mmPerPixel:(state.mmPerPixel||p.mmPerPixel||'')});});
window.addEventListener('timberscanner:scale-calibrated',e=>{state.mmPerPixel=Number(e.detail.mmPerPixel||0);logRow('SCALE',{mmPerPixel:state.mmPerPixel.toFixed(6)});});
window.addEventListener('pagehide',()=>clearTimeout(state.timer));

buildUi();renderLog();tick();