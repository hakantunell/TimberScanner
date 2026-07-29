const panel = document.querySelector('#laser-line-lab');
const actions = panel?.querySelector('.segmentation-lab-actions');
const analyzeButton = document.querySelector('#analyze-laser-frame');

let running = false;
let timer = 0;
let recent = [];
let lastSaved = null;
let lastAcceptedAt = 0;
let rejectedFrames = 0;
let acceptedProfiles = 0;
let qualityRows = [];

const SAMPLE_INTERVAL_MS = 260;
const WINDOW_FRAMES = 3;
const MIN_POINTS = 70;
const MIN_SPAN_RATIO = 0.22;
const MAX_SIGMA = 4.2;
const OCCLUSION_RAW_JUMP_PX = 32;
const MAX_REGISTRATION_SHIFT_PX = 16;
const MAX_REGISTERED_RESIDUAL_PX = 3.2;
const MAX_RESIDUAL_VARIATION_PX = 1.5;
const NEW_PROFILE_LIMIT_PX = 0.65;
const MIN_SAVE_INTERVAL_MS = 550;

function ensureUi() {
  if (!actions || document.querySelector('#start-auto-profiles')) return;
  const manualSave = document.querySelector('#save-laser-profile');
  if (manualSave) manualSave.hidden = true;

  const start = document.createElement('button');
  start.id = 'start-auto-profiles';
  start.type = 'button';
  start.textContent = 'Starta automatisk profilinsamling';

  const stop = document.createElement('button');
  stop.id = 'stop-auto-profiles';
  stop.type = 'button';
  stop.className = 'secondary';
  stop.textContent = 'Stoppa';
  stop.disabled = true;

  const state = document.createElement('span');
  state.id = 'auto-profile-state';
  state.textContent = 'Automatisk insamling avstängd';

  const quality = document.createElement('section');
  quality.id = 'laser-profile-quality';
  quality.className = 'segmentation-candidates';
  quality.innerHTML = '<article class="segmentation-candidate"><strong>Profilkvalitet</strong><small>Inga profiler sparade ännu.</small></article>';

  const copy = document.createElement('button');
  copy.id = 'copy-profile-diagnostics';
  copy.type = 'button';
  copy.className = 'secondary';
  copy.textContent = 'Kopiera profildiagnostik';

  actions.prepend(start, stop, copy, state);
  panel.append(quality);
  start.addEventListener('click', startCollection);
  stop.addEventListener('click', stopCollection);
  copy.addEventListener('click', copyDiagnostics);
}

function axisLength(detection) {
  return detection.orientation === 'horizontal' ? detection.width : detection.height;
}

function fixedCoordinate(detection, point) {
  return detection.orientation === 'horizontal' ? point.x : point.y;
}

function profileVector(detection, bins = 160) {
  const vector = new Float32Array(bins);
  vector.fill(Number.NaN);
  const counts = new Uint16Array(bins);
  const length = Math.max(1, axisLength(detection));
  for (const point of detection.points || []) {
    const fixed = fixedCoordinate(detection, point);
    const value = detection.orientation === 'horizontal' ? point.y : point.x;
    const bin = Math.max(0, Math.min(bins - 1, Math.floor(fixed / length * bins)));
    if (!Number.isFinite(vector[bin])) vector[bin] = 0;
    vector[bin] += value;
    counts[bin] += 1;
  }
  for (let i = 0; i < bins; i += 1) if (counts[i]) vector[i] /= counts[i];
  return vector;
}

function median(values) {
  if (!values.length) return Infinity;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function rawDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const differences = [];
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) differences.push(Math.abs(a[i] - b[i]));
  }
  if (differences.length < a.length * 0.18) return Infinity;
  return median(differences);
}

function registeredDistance(a, b) {
  if (!a || !b || a.length !== b.length) return { shift: 0, residual: Infinity, overlap: 0 };
  let best = { shift: 0, residual: Infinity, overlap: 0 };
  for (let shift = -MAX_REGISTRATION_SHIFT_PX; shift <= MAX_REGISTRATION_SHIFT_PX; shift += 0.5) {
    const differences = [];
    for (let i = 0; i < a.length; i += 1) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
      differences.push(Math.abs((a[i] + shift) - b[i]));
    }
    if (differences.length < a.length * 0.18) continue;
    const residual = median(differences);
    if (residual < best.residual) best = { shift, residual, overlap: differences.length / a.length };
  }
  return best;
}

function contiguousSpan(detection) {
  const coordinates = (detection.points || []).map(point => fixedCoordinate(detection, point)).sort((a, b) => a - b);
  if (!coordinates.length) return { ratio: 0, longestRun: 0 };
  let runStart = coordinates[0];
  let previous = coordinates[0];
  let longestRun = 0;
  for (let i = 1; i < coordinates.length; i += 1) {
    const current = coordinates[i];
    if (current - previous > 4) {
      longestRun = Math.max(longestRun, previous - runStart + 1);
      runStart = current;
    }
    previous = current;
  }
  longestRun = Math.max(longestRun, previous - runStart + 1);
  return { ratio: longestRun / Math.max(1, axisLength(detection)), longestRun };
}

function quality(event) {
  const d = event.detail || {};
  const sigma = Number(d.meanSigma || 99);
  const points = d.points?.length || 0;
  const span = contiguousSpan(d);
  const reasons = [];
  if (points < MIN_POINTS) reasons.push(`för få punkter ${points}/${MIN_POINTS}`);
  if (span.ratio < MIN_SPAN_RATIO) reasons.push(`kort linje ${Math.round(span.ratio * 100)}%/${Math.round(MIN_SPAN_RATIO * 100)}%`);
  if (sigma > MAX_SIGMA) reasons.push(`otydlig linje σ ${sigma.toFixed(2)}/${MAX_SIGMA.toFixed(1)} px`);
  return { valid: reasons.length === 0, sigma, points, spanRatio: span.ratio, reasons };
}

function setState(text) {
  const element = document.querySelector('#auto-profile-state');
  if (element) element.textContent = text;
}

function assess(q, r1, r2) {
  const variation = Math.abs(r2.residual - r1.residual);
  const reasons = [];
  if (q.spanRatio < 0.35) reasons.push(`linjetäckning ${Math.round(q.spanRatio * 100)}%`);
  if (q.sigma > 2.8) reasons.push(`laserbredd σ ${q.sigma.toFixed(2)} px`);
  if (Math.max(r1.residual, r2.residual) > 1.8) reasons.push(`residual ${Math.max(r1.residual, r2.residual).toFixed(2)} px`);
  if (variation > 0.8) reasons.push(`residualvariation ${variation.toFixed(2)} px`);
  const grade = reasons.length ? 'Osäker' : 'Bra';
  return { grade, reason: reasons.join(' · ') || 'Tydlig linje och jämn profil efter registrering', variation };
}

function renderQuality() {
  const host = document.querySelector('#laser-profile-quality');
  if (!host) return;
  if (!qualityRows.length) {
    host.innerHTML = '<article class="segmentation-candidate"><strong>Profilkvalitet</strong><small>Inga profiler sparade ännu.</small></article>';
    return;
  }
  host.replaceChildren(...qualityRows.slice().reverse().slice(0, 16).map(item => {
    const row = document.createElement('article');
    row.className = `segmentation-candidate${item.grade === 'Bra' ? ' selected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = `Profil ${item.index} · ${item.grade}`;
    const reason = document.createElement('small');
    reason.textContent = item.reason;
    const metrics = document.createElement('small');
    metrics.textContent = `${item.points} punkter · linje ${Math.round(item.spanRatio * 100)}% · σ ${item.sigma.toFixed(2)} px · rå ${item.raw1.toFixed(2)}/${item.raw2.toFixed(2)} px · justering ${item.shift1.toFixed(1)}/${item.shift2.toFixed(1)} px · residual ${item.residual1.toFixed(2)}/${item.residual2.toFixed(2)} px · variation ${item.variation.toFixed(2)} px`;
    row.append(title, reason, metrics);
    return row;
  }));
}

async function copyDiagnostics() {
  const header = ['profil','betyg','orsak','punkter','linjePct','sigmaPx','raw1','raw2','shift1','shift2','residual1','residual2','variation'];
  const rows = qualityRows.map(x => [x.index,x.grade,x.reason,x.points,Math.round(x.spanRatio*100),x.sigma.toFixed(3),x.raw1.toFixed(3),x.raw2.toFixed(3),x.shift1.toFixed(3),x.shift2.toFixed(3),x.residual1.toFixed(3),x.residual2.toFixed(3),x.variation.toFixed(3)].join('\t'));
  const text = [header.join('\t'), ...rows].join('\n');
  try { await navigator.clipboard.writeText(text); setState(`Profildiagnostik kopierad · ${qualityRows.length} profiler`); }
  catch { setState('Kunde inte kopiera profildiagnostik automatiskt'); }
}

function processDetection(event) {
  if (!running) return;
  const d = event.detail || {};
  const q = quality(event);
  if (!q.valid) {
    recent.length = 0;
    rejectedFrames += 1;
    setState(`Väntar: ${q.reasons.join(' · ')}`);
    return;
  }

  const vector = profileVector(d);
  const previous = recent.at(-1);
  const rawJump = previous ? rawDistance(previous.vector, vector) : 0;
  if (rawJump > OCCLUSION_RAW_JUMP_PX) {
    recent.length = 0;
    rejectedFrames += 1;
    setState(`Pausar: rått hopp ${rawJump.toFixed(1)} px – möjlig skymning`);
    return;
  }

  recent.push({ vector, quality: q });
  if (recent.length > WINDOW_FRAMES) recent.shift();
  if (recent.length < WINDOW_FRAMES) {
    setState(`Verifierar ${recent.length}/${WINDOW_FRAMES} · ${q.points} punkter · linje ${Math.round(q.spanRatio * 100)}%`);
    return;
  }

  const raw1 = rawDistance(recent[0].vector, recent[1].vector);
  const raw2 = rawDistance(recent[1].vector, recent[2].vector);
  const r1 = registeredDistance(recent[0].vector, recent[1].vector);
  const r2 = registeredDistance(recent[1].vector, recent[2].vector);
  const variation = Math.abs(r2.residual - r1.residual);

  if (Math.max(r1.residual, r2.residual) > MAX_REGISTERED_RESIDUAL_PX || variation > MAX_RESIDUAL_VARIATION_PX) {
    setState(`Ojämn efter registrering: residual ${r1.residual.toFixed(2)}/${r2.residual.toFixed(2)} px · variation ${variation.toFixed(2)} px`);
    recent.shift();
    return;
  }

  const candidate = recent[2];
  const changed = lastSaved ? registeredDistance(lastSaved, candidate.vector).residual : Infinity;
  if (lastSaved && changed < NEW_PROFILE_LIMIT_PX) {
    setState(`För liten ny profilförändring efter registrering · ${changed.toFixed(2)} px`);
    recent.shift();
    return;
  }

  const now = performance.now();
  if (now - lastAcceptedAt < MIN_SAVE_INTERVAL_MS) return;
  const save = document.querySelector('#save-laser-profile');
  if (!save || save.disabled) {
    setState('Profil godkänd men sparfunktionen är inte redo');
    return;
  }

  const assessment = assess(candidate.quality, r1, r2);
  save.click();
  lastSaved = candidate.vector.slice();
  lastAcceptedAt = now;
  acceptedProfiles += 1;
  qualityRows.push({
    index: acceptedProfiles,
    grade: assessment.grade,
    reason: assessment.reason,
    points: candidate.quality.points,
    spanRatio: candidate.quality.spanRatio,
    sigma: candidate.quality.sigma,
    raw1, raw2,
    shift1: r1.shift,
    shift2: r2.shift,
    residual1: r1.residual,
    residual2: r2.residual,
    variation: assessment.variation,
    changed
  });
  renderQuality();
  recent.length = 0;
  setState(`Profil ${acceptedProfiles} sparad · ${assessment.grade} · ${assessment.reason}`);
}

function tick() {
  if (!running) return;
  if (analyzeButton && !analyzeButton.disabled) analyzeButton.click();
  timer = window.setTimeout(tick, SAMPLE_INTERVAL_MS);
}

function startCollection() {
  if (running) return;
  running = true;
  recent.length = 0;
  rejectedFrames = 0;
  acceptedProfiles = 0;
  lastSaved = null;
  qualityRows = [];
  renderQuality();
  document.querySelector('#start-auto-profiles').disabled = true;
  document.querySelector('#stop-auto-profiles').disabled = false;
  setState('Startar registrerad profildiagnostik…');
  tick();
}

function stopCollection() {
  running = false;
  window.clearTimeout(timer);
  recent.length = 0;
  const start = document.querySelector('#start-auto-profiles');
  const stop = document.querySelector('#stop-auto-profiles');
  if (start) start.disabled = false;
  if (stop) stop.disabled = true;
  setState(`Stoppad · ${acceptedProfiles} profiler · ${rejectedFrames} störda bildrutor`);
}

window.addEventListener('timberscanner:laser-line-detected', processDetection);
window.addEventListener('timberscanner:laser-profiles-cleared', () => {
  recent.length = 0;
  lastSaved = null;
  acceptedProfiles = 0;
  qualityRows = [];
  renderQuality();
  setState(running ? 'Profiler rensade · fortsätter samla' : 'Profiler rensade');
});
window.addEventListener('pagehide', stopCollection);

ensureUi();