const video = document.querySelector('#camera');
const laserPanel = document.querySelector('#laser-line-lab');

const state = {
  canvas: null,
  context: null,
  center: null,
  radius: 52,
  zeroAngle: null,
  latestRawAngle: null,
  latestAngle: null,
  confidence: 0,
  mode: 'idle',
  rulerPoints: [],
  calibrationFrame: null,
  mmPerPixel: Number(localStorage.getItem('timberscanner.mmPerPixel') || 0),
  timer: 0,
  profileRecords: [],
};

function normalizeAngle(value) {
  let angle = value % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function circularDelta(a, b) {
  let d = normalizeAngle(a) - normalizeAngle(b);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function buildUi() {
  if (!laserPanel || document.querySelector('#rotation-scale-panel')) return;
  const panel = document.createElement('section');
  panel.id = 'rotation-scale-panel';
  panel.className = 'diagnostic-panel';
  panel.innerHTML = `
    <div class="diagnostic-heading">
      <div><p class="eyebrow">Rotation och skala</p><h2>T-markör och linjalkalibrering</h2></div>
      <div><strong id="rotation-status">T-markören är inte inställd</strong><span id="rotation-detail">Markera centrum på stockänden en gång</span></div>
    </div>
    <div class="segmentation-lab-actions">
      <button id="mark-end-center" type="button">Markera stockändens centrum</button>
      <label class="laser-setting">Sökradie <span id="marker-radius-value">${state.radius}</span> px<input id="marker-radius" type="range" min="20" max="130" value="${state.radius}"></label>
      <button id="zero-marker-angle" class="secondary" type="button" disabled>Nollställ aktuell T-vinkel</button>
      <button id="capture-ruler-frame" class="secondary" type="button">Fånga linjalbild</button>
      <label class="laser-setting">Känt avstånd, mm<input id="ruler-distance-mm" type="number" min="1" step="1" value="100"></label>
      <button id="mark-ruler-points" class="secondary" type="button" disabled>Markera två linjalpunkter</button>
    </div>
    <div class="segmentation-lab-grid">
      <figure class="segmentation-lab-view"><canvas id="rotation-scale-canvas" width="640" height="360"></canvas><figcaption>T-markör, vinkel och linjalpunkter</figcaption></figure>
      <article class="segmentation-candidate selected"><strong id="rotation-value">Rotation: –</strong><small id="rotation-quality">Ingen T-vinkel ännu</small></article>
      <article class="segmentation-candidate"><strong id="scale-value">Skala: ${state.mmPerPixel ? `${state.mmPerPixel.toFixed(4)} mm/px` : 'inte kalibrerad'}</strong><small>Linjalpunkterna ska ligga på ungefär samma avstånd från kameran som stockens yta.</small></article>
    </div>
    <div id="profile-angle-list" class="segmentation-candidates"></div>
    <p class="diagnostic-note">Din hand får synas i bilden. En profil stoppas bara om handen påverkar laserlinjen eller döljer T-markören. T-vinkeln används för att placera varje laserprofil runt stockens omkrets. Linjalen behöver bara synas under kalibreringen.</p>`;
  laserPanel.insertAdjacentElement('afterend', panel);

  state.canvas = panel.querySelector('#rotation-scale-canvas');
  state.context = state.canvas.getContext('2d', { willReadFrequently: true });

  panel.querySelector('#mark-end-center').addEventListener('click', () => {
    state.mode = 'center';
    setStatus('Klicka i mitten av stockänden', 'Klicka en gång i kamerabilden nedan');
  });
  panel.querySelector('#marker-radius').addEventListener('input', (event) => {
    state.radius = Number(event.target.value);
    panel.querySelector('#marker-radius-value').textContent = String(state.radius);
  });
  panel.querySelector('#zero-marker-angle').addEventListener('click', () => {
    if (!Number.isFinite(state.latestRawAngle)) return;
    state.zeroAngle = state.latestRawAngle;
    updateAngleDisplay();
  });
  panel.querySelector('#capture-ruler-frame').addEventListener('click', () => {
    state.calibrationFrame = captureFrame();
    state.mode = 'idle';
    state.rulerPoints.length = 0;
    panel.querySelector('#mark-ruler-points').disabled = false;
    setStatus('Linjalbild fångad', 'Tryck Markera två linjalpunkter och klicka på två kända markeringar');
    draw();
  });
  panel.querySelector('#mark-ruler-points').addEventListener('click', () => {
    if (!state.calibrationFrame) return;
    state.rulerPoints.length = 0;
    state.mode = 'ruler';
    setStatus('Markera linjalens två punkter', 'Klicka först på startmarkeringen och sedan på slutmarkeringen');
  });
  state.canvas.addEventListener('click', handleCanvasClick);
}

function setStatus(title, detail) {
  const titleNode = document.querySelector('#rotation-status');
  const detailNode = document.querySelector('#rotation-detail');
  if (titleNode) titleNode.textContent = title;
  if (detailNode) detailNode.textContent = detail;
}

function captureFrame() {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const scale = Math.min(1, 640 / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function pointFromEvent(event) {
  const rect = state.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * state.canvas.width / rect.width,
    y: (event.clientY - rect.top) * state.canvas.height / rect.height,
  };
}

function handleCanvasClick(event) {
  const point = pointFromEvent(event);
  if (state.mode === 'center') {
    state.center = point;
    state.zeroAngle = null;
    state.mode = 'idle';
    document.querySelector('#zero-marker-angle').disabled = false;
    setStatus('Stockändens centrum markerat', 'T-riktningen följs nu automatiskt; nollställ vinkeln i önskat startläge');
    return;
  }
  if (state.mode === 'ruler') {
    state.rulerPoints.push(point);
    if (state.rulerPoints.length === 2) {
      const [a, b] = state.rulerPoints;
      const pixels = Math.hypot(b.x - a.x, b.y - a.y);
      const millimeters = Number(document.querySelector('#ruler-distance-mm')?.value || 0);
      if (pixels > 2 && millimeters > 0) {
        state.mmPerPixel = millimeters / pixels;
        localStorage.setItem('timberscanner.mmPerPixel', String(state.mmPerPixel));
        document.querySelector('#scale-value').textContent = `Skala: ${state.mmPerPixel.toFixed(4)} mm/px`;
        setStatus('Linjalskala sparad', `${millimeters.toFixed(1)} mm över ${pixels.toFixed(1)} px`);
        window.dispatchEvent(new CustomEvent('timberscanner:scale-calibrated', { detail: { mmPerPixel: state.mmPerPixel, pixels, millimeters } }));
      }
      state.mode = 'idle';
    }
    draw();
  }
}

function detectMarker(frame) {
  if (!frame || !state.center) return null;
  const context = frame.getContext('2d', { willReadFrequently: true });
  const image = context.getImageData(0, 0, frame.width, frame.height);
  const { x: cx, y: cy } = state.center;
  const r = state.radius;
  const samples = [];
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(frame.height - 1, Math.ceil(cy + r)); y += 2) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(frame.width - 1, Math.ceil(cx + r)); x += 2) {
      const dx = x - cx; const dy = y - cy;
      const radius = Math.hypot(dx, dy);
      if (radius < r * .14 || radius > r) continue;
      const i = (y * frame.width + x) * 4;
      const luminance = image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114;
      samples.push(luminance);
    }
  }
  if (samples.length < 30) return null;
  samples.sort((a, b) => a - b);
  const darkThreshold = samples[Math.floor(samples.length * .22)];
  const bins = new Float32Array(360);
  let darkCount = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(frame.height - 1, Math.ceil(cy + r)); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(frame.width - 1, Math.ceil(cx + r)); x += 1) {
      const dx = x - cx; const dy = y - cy;
      const radius = Math.hypot(dx, dy);
      if (radius < r * .18 || radius > r) continue;
      const i = (y * frame.width + x) * 4;
      const luminance = image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114;
      if (luminance > darkThreshold) continue;
      darkCount += 1;
      const angle = normalizeAngle(Math.atan2(dy, dx) * 180 / Math.PI);
      const bin = Math.round(angle) % 360;
      bins[bin] += (darkThreshold - luminance + 2) * Math.pow(radius / r, 1.8);
    }
  }
  if (darkCount < 12) return null;
  const smooth = new Float32Array(360);
  for (let a = 0; a < 360; a += 1) {
    let total = 0;
    for (let d = -5; d <= 5; d += 1) total += bins[normalizeAngle(a + d)] * (6 - Math.abs(d));
    smooth[a] = total;
  }
  let best = 0;
  for (let a = 1; a < 360; a += 1) if (smooth[a] > smooth[best]) best = a;
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length * .6)] || 1;
  const confidence = smooth[best] / Math.max(1, baseline);
  return { angle: best, confidence, darkCount };
}

function updateAngleDisplay() {
  if (!Number.isFinite(state.latestRawAngle)) return;
  state.latestAngle = state.zeroAngle == null ? state.latestRawAngle : normalizeAngle(state.latestRawAngle - state.zeroAngle);
  const value = document.querySelector('#rotation-value');
  const quality = document.querySelector('#rotation-quality');
  if (value) value.textContent = `Rotation: ${state.latestAngle.toFixed(1)}°`;
  if (quality) quality.textContent = `T-säkerhet ${state.confidence.toFixed(1)} · rå vinkel ${state.latestRawAngle.toFixed(1)}°${state.zeroAngle == null ? ' · ej nollställd' : ''}`;
}

function draw(frame = null) {
  if (!state.context || !state.canvas) return;
  const source = state.calibrationFrame && state.mode === 'ruler' ? state.calibrationFrame : frame;
  if (source) {
    state.canvas.width = source.width;
    state.canvas.height = source.height;
    state.context.drawImage(source, 0, 0);
  } else {
    state.context.clearRect(0, 0, state.canvas.width, state.canvas.height);
  }
  if (state.center) {
    state.context.strokeStyle = '#35ff75';
    state.context.lineWidth = 2;
    state.context.beginPath();
    state.context.arc(state.center.x, state.center.y, state.radius, 0, Math.PI * 2);
    state.context.stroke();
    if (Number.isFinite(state.latestRawAngle)) {
      const radians = state.latestRawAngle * Math.PI / 180;
      state.context.beginPath();
      state.context.moveTo(state.center.x, state.center.y);
      state.context.lineTo(state.center.x + Math.cos(radians) * state.radius, state.center.y + Math.sin(radians) * state.radius);
      state.context.stroke();
    }
  }
  if (state.rulerPoints.length) {
    state.context.fillStyle = '#ffd45e';
    state.context.strokeStyle = '#ffd45e';
    state.context.lineWidth = 2;
    for (const point of state.rulerPoints) {
      state.context.beginPath(); state.context.arc(point.x, point.y, 5, 0, Math.PI * 2); state.context.fill();
    }
    if (state.rulerPoints.length === 2) {
      state.context.beginPath(); state.context.moveTo(state.rulerPoints[0].x, state.rulerPoints[0].y); state.context.lineTo(state.rulerPoints[1].x, state.rulerPoints[1].y); state.context.stroke();
    }
  }
}

function tick() {
  const frame = captureFrame();
  if (frame && state.center) {
    const marker = detectMarker(frame);
    if (marker && marker.confidence >= 1.25) {
      if (Number.isFinite(state.latestRawAngle)) {
        state.latestRawAngle = normalizeAngle(state.latestRawAngle + circularDelta(marker.angle, state.latestRawAngle) * .35);
      } else state.latestRawAngle = marker.angle;
      state.confidence = marker.confidence;
      updateAngleDisplay();
      setStatus('T-markör hittad', `Vinkel ${state.latestAngle?.toFixed(1) ?? '–'}° · säkerhet ${marker.confidence.toFixed(1)}`);
      window.dispatchEvent(new CustomEvent('timberscanner:rotation-detected', { detail: { angleDeg: state.latestAngle, rawAngleDeg: state.latestRawAngle, confidence: state.confidence } }));
    } else {
      state.confidence = marker?.confidence || 0;
      setStatus('T-markören tillfälligt osäker', 'Profilinsamlingen kan fortsätta, men profilen får ingen säker rotationsvinkel');
    }
    if (state.mode !== 'ruler') draw(frame);
  } else if (frame && state.mode !== 'ruler') draw(frame);
  state.timer = window.setTimeout(tick, 300);
}

function renderProfileRecord(record) {
  const list = document.querySelector('#profile-angle-list');
  if (!list) return;
  const row = document.createElement('article');
  row.className = `segmentation-candidate ${record.angleReliable ? 'selected' : ''}`;
  const angleText = record.angleReliable ? `${record.angleDeg.toFixed(1)}°` : 'vinkel saknas/osäker';
  const scaleText = record.mmPerPixel ? `${record.mmPerPixel.toFixed(4)} mm/px` : 'ingen mm-skala';
  row.innerHTML = `<strong>Profil ${record.index + 1} · ${angleText}</strong><small>T-säkerhet ${record.confidence.toFixed(1)} · ${scaleText}</small>`;
  list.prepend(row);
}

window.addEventListener('timberscanner:laser-profile-saved', (event) => {
  const angleReliable = Number.isFinite(state.latestAngle) && state.confidence >= 1.35;
  const record = {
    index: event.detail.index,
    angleDeg: angleReliable ? state.latestAngle : null,
    angleReliable,
    confidence: state.confidence,
    mmPerPixel: state.mmPerPixel || null,
  };
  if (event.detail.profile) {
    event.detail.profile.rotationAngleDeg = record.angleDeg;
    event.detail.profile.rotationConfidence = record.confidence;
    event.detail.profile.mmPerPixel = record.mmPerPixel;
  }
  state.profileRecords.push(record);
  renderProfileRecord(record);
  window.dispatchEvent(new CustomEvent('timberscanner:profile-metadata-attached', { detail: record }));
});

window.addEventListener('timberscanner:laser-profiles-cleared', () => {
  state.profileRecords.length = 0;
  const list = document.querySelector('#profile-angle-list');
  if (list) list.replaceChildren();
});

window.addEventListener('pagehide', () => window.clearTimeout(state.timer));

buildUi();
tick();
