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
const STABLE_FRAMES = 3;
const MIN_POINTS = 70;
const MIN_SPAN_RATIO = 0.22;
const MAX_SIGMA = 4.2;
const STABILITY_LIMIT_PX = 1.8;
const NEW_PROFILE_LIMIT_PX = 0.75;
const OCCLUSION_JUMP_PX = 28;
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

  actions.prepend(start, stop, state);
  panel.append(quality);
  start.addEventListener('click', startCollection);
  stop.addEventListener('click', stopCollection);
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

function distance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  const differences = [];
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) differences.push(Math.abs(a[i] - b[i]));
  }
  if (differences.length < a.length * .18) return Infinity;
  return median(differences);
}

function contiguousSpan(detection) {
  const coordinates = (detection.points || []).map((point) => fixedCoordinate(detection, point)).sort((a, b) => a - b);
  if (!coordinates.length) return { span: 0, ratio: 0, longestRun: 0 };
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
  return { span: coordinates.at(-1) - coordinates[0] + 1, ratio: longestRun / Math.max(1, axisLength(detection)), longestRun };
}

function quality(event) {
  const d = event.detail || {};
  const sigma = Number(d.meanSigma || 99);
  const points = d.points?.length || 0;
  const span = contiguousSpan(d);
  const valid = points >= MIN_POINTS && span.ratio >= MIN_SPAN_RATIO && sigma <= MAX_SIGMA;
  let reason = 'bra';
  if (points < MIN_POINTS) reason = `för få laserpunkter (${points}/${MIN_POINTS})`;
  else if (span.ratio < MIN_SPAN_RATIO) reason = `för kort sammanhängande linje (${Math.round(span.ratio * 100)}%)`;
  else if (sigma > MAX_SIGMA) reason = `för bred/otydlig laserlinje (σ ${sigma.toFixed(2)} px)`;
  return { valid, sigma, points, spanRatio: span.ratio, longestRun: span.longestRun, reason };
}

function setState(text) {
  const element = document.querySelector('#auto-profile-state');
  if (element) element.textContent = text;
}

function renderQuality() {
  const host = document.querySelector('#laser-profile-quality');
  if (!host) return;
  if (!qualityRows.length) {
    host.innerHTML = '<article class="segmentation-candidate"><strong>Profilkvalitet</strong><small>Inga profiler sparade ännu.</small></article>';
    return;
  }
  host.replaceChildren(...qualityRows.slice().reverse().slice(0, 12).map((item) => {
    const row = document.createElement('article');
    row.className = `segmentation-candidate${item.grade === 'Bra' ? ' selected' : ''}`;
    const title = document.createElement('strong');
    title.textContent = `Profil ${item.index} · ${item.grade}`;
    const metrics = document.createElement('small');
    metrics.textContent = `${item.points} punkter · sammanhängande linje ${Math.round(item.spanRatio * 100)}% · σ ${item.sigma.toFixed(2)} px · stabilitet ${item.stability.toFixed(2)} px · förändring ${Number.isFinite(item.changed) ? item.changed.toFixed(2) : 'första'} px`;
    row.append(title, metrics);
    return row;
  }));
}

function gradeProfile(q, stability, changed) {
  if (q.spanRatio >= .35 && q.sigma <= 2.8 && stability <= 1.1) return 'Bra';
  if (q.valid && stability <= STABILITY_LIMIT_PX) return 'Osäker';
  return 'Underkänd';
}

function processDetection(event) {
  if (!running) return;

  const d = event.detail || {};
  const q = quality(event);
  if (!q.valid) {
    recent.length = 0;
    rejectedFrames += 1;
    setState(`Väntar: ${q.reason}`);
    return;
  }

  const vector = profileVector(d);
  const previous = recent.at(-1);
  const frameJump = previous ? distance(previous.vector, vector) : 0;
  if (frameJump > OCCLUSION_JUMP_PX) {
    recent.length = 0;
    rejectedFrames += 1;
    setState(`Pausar: plötslig förändring ${frameJump.toFixed(1)} px – möjlig skymning`);
    return;
  }

  recent.push({ vector, detection: d, quality: q, capturedAt: performance.now() });
  if (recent.length > STABLE_FRAMES) recent.shift();
  if (recent.length < STABLE_FRAMES) {
    setState(`Verifierar profil ${recent.length}/${STABLE_FRAMES} · ${q.points} punkter · linje ${Math.round(q.spanRatio * 100)}%`);
    return;
  }

  const d01 = distance(recent[0].vector, recent[1].vector);
  const d12 = distance(recent[1].vector, recent[2].vector);
  const stability = Math.max(d01, d12);
  if (stability > STABILITY_LIMIT_PX) {
    setState(`Objektet rör sig · väntar på stabil profil · ${stability.toFixed(2)} px`);
    return;
  }

  const candidate = recent[2];
  const changed = lastSaved ? distance(lastSaved, candidate.vector) : Infinity;
  if (lastSaved && changed < NEW_PROFILE_LIMIT_PX) {
    setState(`Stabil men ännu inte tillräckligt förändrad · ${changed.toFixed(2)} px`);
    return;
  }

  const now = performance.now();
  if (now - lastAcceptedAt < MIN_SAVE_INTERVAL_MS) return;

  const save = document.querySelector('#save-laser-profile');
  if (!save || save.disabled) {
    setState('Stabil profil hittad men sparfunktionen är inte redo');
    return;
  }

  const grade = gradeProfile(candidate.quality, stability, changed);
  if (grade === 'Underkänd') {
    rejectedFrames += 1;
    setState('Profilen är stabil men kvalitetsmässigt underkänd');
    return;
  }

  save.click();
  lastSaved = candidate.vector.slice();
  lastAcceptedAt = now;
  acceptedProfiles += 1;
  qualityRows.push({ index: acceptedProfiles, grade, points: candidate.quality.points, spanRatio: candidate.quality.spanRatio, sigma: candidate.quality.sigma, stability, changed });
  renderQuality();
  recent.length = 0;
  setState(`Profil ${acceptedProfiles} sparad · ${grade} · linje ${Math.round(candidate.quality.spanRatio * 100)}% · ${rejectedFrames} störda bildrutor ignorerade`);
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
  const start = document.querySelector('#start-auto-profiles');
  const stop = document.querySelector('#stop-auto-profiles');
  if (start) start.disabled = true;
  if (stop) stop.disabled = false;
  setState('Startar kontinuerlig analys…');
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
  setState(`Stoppad · ${acceptedProfiles} profiler sparade · ${rejectedFrames} störda bildrutor ignorerade`);
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