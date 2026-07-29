const video = document.querySelector('#camera');
const host = document.querySelector('#rotation-scale-panel');

const tracker = {
  center: null,
  radius: 52,
  zero: null,
  raw: null,
  unwrapped: null,
  velocity: 0,
  confidence: 0,
  directionMargin: 0,
  timer: 0,
  mode: 'idle',
  rows: [],
  latestProfileQuality: null,
  mmPerPixel: Number(localStorage.getItem('timberscanner.mmPerPixel') || 0),
};

function norm(a) { a %= 360; return a < 0 ? a + 360 : a; }
function delta(a, b) { let d = norm(a) - norm(b); if (d > 180) d -= 360; if (d < -180) d += 360; return d; }

function buildUi() {
  if (!host || document.querySelector('#t49-panel')) return;
  const oldList = document.querySelector('#profile-angle-list');
  if (oldList) oldList.hidden = true;
  const panel = document.createElement('section');
  panel.id = 't49-panel';
  panel.className = 'diagnostic-panel';
  panel.innerHTML = `
    <div class="diagnostic-heading"><div><p class="eyebrow">T-riktning och export</p><h2>360° rotationsföljning</h2></div><div><strong id="t49-status">Inte kalibrerad</strong><span id="t49-detail">Markera centrum och T:ets stamriktning</span></div></div>
    <div class="segmentation-lab-actions">
      <button id="t49-center" type="button">Markera stockändens centrum</button>
      <button id="t49-direction" class="secondary" type="button" disabled>Markera T-stammens riktning</button>
      <label class="laser-setting">Sökradie <span id="t49-radius-value">52</span> px<input id="t49-radius" type="range" min="20" max="130" value="52"></label>
      <button id="t49-zero" class="secondary" type="button" disabled>Nollställ vinkel</button>
      <button id="t49-copy" class="secondary" type="button">Kopiera diagnos</button>
      <button id="t49-clear" class="secondary" type="button">Rensa diagnos</button>
    </div>
    <div class="segmentation-lab-grid">
      <figure class="segmentation-lab-view"><canvas id="t49-canvas" width="640" height="360"></canvas><figcaption>T-form, riktning och 360°-spårning</figcaption></figure>
      <article class="segmentation-candidate selected"><strong id="t49-angle">Rotation: –</strong><small id="t49-quality">Ingen riktning ännu</small></article>
    </div>
    <label class="laser-setting" style="margin-top:12px">Kopierbar diagnostik<textarea id="t49-log" rows="16" readonly style="width:100%;font-family:ui-monospace,monospace;white-space:pre"></textarea></label>
    <p class="diagnostic-note">Detektorn använder både T-stammen och tvärstrecket. Därmed skiljs θ från θ+180°. Diagnosen innehåller rå vinkel, upprullad vinkel, riktning, säkerhet, profilkvalitet och skala.</p>`;
  host.insertAdjacentElement('afterend', panel);

  const canvas = panel.querySelector('#t49-canvas');
  panel.querySelector('#t49-center').addEventListener('click', () => { tracker.mode = 'center'; setStatus('Klicka på stockändens centrum', 'Klicka i bilden'); });
  panel.querySelector('#t49-direction').addEventListener('click', () => { tracker.mode = 'direction'; setStatus('Klicka längs T-stammen', 'Klicka från centrum i den riktning som gör T-formen entydig'); });
  panel.querySelector('#t49-radius').addEventListener('input', e => { tracker.radius = Number(e.target.value); panel.querySelector('#t49-radius-value').textContent = String(tracker.radius); });
  panel.querySelector('#t49-zero').addEventListener('click', () => { if (Number.isFinite(tracker.unwrapped)) tracker.zero = tracker.unwrapped; updateDisplay(); });
  panel.querySelector('#t49-copy').addEventListener('click', async () => { const text = panel.querySelector('#t49-log').value; try { await navigator.clipboard.writeText(text); setStatus('Diagnos kopierad', `${text.length} tecken`); } catch { panel.querySelector('#t49-log').select(); document.execCommand('copy'); } });
  panel.querySelector('#t49-clear').addEventListener('click', () => { tracker.rows.length = 0; renderLog(); });
  canvas.addEventListener('click', e => {
    const rect = canvas.getBoundingClientRect();
    const p = { x: (e.clientX - rect.left) * canvas.width / rect.width, y: (e.clientY - rect.top) * canvas.height / rect.height };
    if (tracker.mode === 'center') {
      tracker.center = p; tracker.raw = tracker.unwrapped = tracker.zero = null; tracker.velocity = 0; tracker.mode = 'idle';
      panel.querySelector('#t49-direction').disabled = false;
      setStatus('Centrum markerat', 'Markera nu T-stammens riktning en gång');
    } else if (tracker.mode === 'direction' && tracker.center) {
      const initial = norm(Math.atan2(p.y - tracker.center.y, p.x - tracker.center.x) * 180 / Math.PI);
      tracker.raw = tracker.unwrapped = initial; tracker.zero = null; tracker.velocity = 0; tracker.mode = 'idle';
      panel.querySelector('#t49-zero').disabled = false;
      setStatus('T-riktning initierad', `Starttolkning ${initial.toFixed(1)}°`);
    }
  });
}

function setStatus(a, b) { const s = document.querySelector('#t49-status'); const d = document.querySelector('#t49-detail'); if (s) s.textContent = a; if (d) d.textContent = b; }
function capture() {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const scale = Math.min(1, 640 / video.videoWidth);
  const c = document.createElement('canvas'); c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height); return c;
}

function sampleDark(data, w, h, x, y, threshold) {
  const ix = Math.round(x), iy = Math.round(y); if (ix < 0 || iy < 0 || ix >= w || iy >= h) return 0;
  const i = (iy * w + ix) * 4; const lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
  return Math.max(0, threshold - lum);
}

function detectT(frame) {
  if (!tracker.center || !Number.isFinite(tracker.raw)) return null;
  const ctx = frame.getContext('2d', { willReadFrequently: true }); const img = ctx.getImageData(0, 0, frame.width, frame.height);
  const { x: cx, y: cy } = tracker.center, r = tracker.radius; const luminances = [];
  for (let y = Math.max(0, cy-r); y <= Math.min(frame.height-1, cy+r); y += 3) for (let x = Math.max(0, cx-r); x <= Math.min(frame.width-1, cx+r); x += 3) {
    if (Math.hypot(x-cx,y-cy) > r) continue; const i=(Math.floor(y)*frame.width+Math.floor(x))*4; luminances.push(img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114);
  }
  if (luminances.length < 40) return null; luminances.sort((a,b)=>a-b); const threshold = luminances[Math.floor(luminances.length*.28)];
  const predicted = tracker.raw + tracker.velocity; const candidates = [];
  for (let a = 0; a < 360; a += 2) {
    const rad = a*Math.PI/180, ux=Math.cos(rad), uy=Math.sin(rad), px=-uy, py=ux;
    let stem=0, cap=0, oppositeCap=0;
    for (let t=.16; t<=.76; t+=.045) for (const off of [-2,0,2]) stem += sampleDark(img.data,frame.width,frame.height,cx+ux*r*t+px*off,cy+uy*r*t+py*off,threshold);
    const capCenter=.70;
    for (let q=-.34; q<=.34; q+=.035) {
      cap += sampleDark(img.data,frame.width,frame.height,cx+ux*r*capCenter+px*r*q,cy+uy*r*capCenter+py*r*q,threshold);
      oppositeCap += sampleDark(img.data,frame.width,frame.height,cx-ux*r*capCenter+px*r*q,cy-uy*r*capCenter+py*r*q,threshold);
    }
    const asymmetry = cap - oppositeCap*.72; const continuity = Math.max(0, 80-Math.abs(delta(a,predicted))*2.0);
    candidates.push({ angle:a, score:stem*.55+cap*.85+asymmetry*.55+continuity, asymmetry, stem, cap });
  }
  candidates.sort((a,b)=>b.score-a.score); const best=candidates[0], second=candidates.find(c=>Math.abs(delta(c.angle,best.angle))>18) || candidates[1];
  const margin=(best.score-(second?.score||0))/Math.max(1,Math.abs(best.score)); return { ...best, confidence: Math.max(0,margin*10), margin };
}

function updateTracking(hit) {
  const d = delta(hit.angle, tracker.raw); const plausible = Math.abs(d) <= 55 || hit.confidence >= 1.8;
  if (!plausible) return false;
  const step = d * .42; tracker.raw = norm(tracker.raw + step); tracker.unwrapped = Number.isFinite(tracker.unwrapped) ? tracker.unwrapped + step : tracker.raw;
  tracker.velocity = tracker.velocity*.72 + step*.28; tracker.confidence = hit.confidence; tracker.directionMargin = hit.asymmetry; return true;
}

function updateDisplay() {
  const angle = Number.isFinite(tracker.unwrapped) ? tracker.unwrapped - (tracker.zero ?? tracker.unwrapped) : null;
  const wrapped = angle == null ? null : norm(angle); const dir = tracker.velocity > .15 ? 'medurs' : tracker.velocity < -.15 ? 'moturs' : 'stilla';
  const a=document.querySelector('#t49-angle'), q=document.querySelector('#t49-quality');
  if (a) a.textContent = angle == null ? 'Rotation: –' : `Rotation: ${wrapped.toFixed(1)}° · totalt ${angle.toFixed(1)}°`;
  if (q) q.textContent = `riktning ${dir} · hastighet ${tracker.velocity.toFixed(2)}°/bild · T-säkerhet ${tracker.confidence.toFixed(2)} · asymmetri ${tracker.directionMargin.toFixed(0)}`;
  return { angle, wrapped, dir };
}

function draw(frame, hit) {
  const c=document.querySelector('#t49-canvas'); if(!c||!frame)return; c.width=frame.width;c.height=frame.height;const x=c.getContext('2d');x.drawImage(frame,0,0);
  if(!tracker.center)return;x.strokeStyle='#35ff75';x.lineWidth=2;x.beginPath();x.arc(tracker.center.x,tracker.center.y,tracker.radius,0,Math.PI*2);x.stroke();
  if(Number.isFinite(tracker.raw)){const r=tracker.raw*Math.PI/180;x.beginPath();x.moveTo(tracker.center.x,tracker.center.y);x.lineTo(tracker.center.x+Math.cos(r)*tracker.radius*.82,tracker.center.y+Math.sin(r)*tracker.radius*.82);x.stroke();
    const ex=tracker.center.x+Math.cos(r)*tracker.radius*.7,ey=tracker.center.y+Math.sin(r)*tracker.radius*.7,px=-Math.sin(r),py=Math.cos(r);x.beginPath();x.moveTo(ex-px*tracker.radius*.32,ey-py*tracker.radius*.32);x.lineTo(ex+px*tracker.radius*.32,ey+py*tracker.radius*.32);x.stroke();}
}

function logRow(type, fields={}) { tracker.rows.push({ time:new Date().toISOString().slice(11,23), type, ...fields }); if(tracker.rows.length>400)tracker.rows.shift(); renderLog(); }
function renderLog(){const t=document.querySelector('#t49-log');if(!t)return;const header=['time','type','angleWrapped','angleTotal','direction','velocityDegPerFrame','tConfidence','tAsymmetry','profile','quality','points','runPct','sigmaPx','stabilityPx','changePx','mmPerPixel'].join('\t');t.value=[header,...tracker.rows.map(r=>[r.time,r.type,r.angleWrapped??'',r.angleTotal??'',r.direction??'',r.velocity??'',r.confidence??'',r.asymmetry??'',r.profile??'',r.quality??'',r.points??'',r.runPct??'',r.sigma??'',r.stability??'',r.change??'',r.mmPerPixel??''].join('\t'))].join('\n');t.scrollTop=t.scrollHeight;}

function tick(){const frame=capture();if(frame){let hit=null;if(tracker.center&&Number.isFinite(tracker.raw)){hit=detectT(frame);if(hit&&updateTracking(hit)){const v=updateDisplay();setStatus('T-riktning följs',`${v.dir} · ${v.wrapped?.toFixed(1)}° · säkerhet ${tracker.confidence.toFixed(2)}`);window.dispatchEvent(new CustomEvent('timberscanner:rotation-v49',{detail:{angleDeg:v.wrapped,totalAngleDeg:v.angle,direction:v.dir,confidence:tracker.confidence,velocityDegPerFrame:tracker.velocity}}));}else setStatus('T-riktningen är osäker','Behåller senaste riktning tills T-formen åter är tydlig');}draw(frame,hit);}tracker.timer=setTimeout(tick,220);}

window.addEventListener('timberscanner:laser-profile-quality',e=>{tracker.latestProfileQuality=e.detail||null;});
window.addEventListener('timberscanner:laser-profile-saved',e=>{const v=updateDisplay();const p=e.detail.profile||{};p.rotationAngleDeg=v.wrapped;p.rotationTotalAngleDeg=v.angle;p.rotationDirection=v.dir;p.rotationConfidence=tracker.confidence;p.mmPerPixel=tracker.mmPerPixel||p.mmPerPixel||null;const q=tracker.latestProfileQuality||{};logRow('PROFILE',{angleWrapped:v.wrapped?.toFixed(2),angleTotal:v.angle?.toFixed(2),direction:v.dir,velocity:tracker.velocity.toFixed(3),confidence:tracker.confidence.toFixed(3),asymmetry:tracker.directionMargin.toFixed(1),profile:(e.detail.index??0)+1,quality:q.rating||'',points:q.points||p.points?.length||'',runPct:q.runPercent||'',sigma:q.sigma?.toFixed?.(3)||'',stability:q.stability?.toFixed?.(3)||'',change:q.change?.toFixed?.(3)||'',mmPerPixel:(tracker.mmPerPixel||p.mmPerPixel||'')});});
window.addEventListener('timberscanner:scale-calibrated',e=>{tracker.mmPerPixel=Number(e.detail.mmPerPixel||0);logRow('SCALE',{mmPerPixel:tracker.mmPerPixel.toFixed(6)});});
window.addEventListener('pagehide',()=>clearTimeout(tracker.timer));
buildUi();renderLog();tick();