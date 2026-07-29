const panel = document.querySelector('#laser-line-lab');
const actions = panel?.querySelector('.segmentation-lab-actions');
const analyzeButton = document.querySelector('#analyze-laser-frame');

let running = false;
let timer = 0;
let recent = [];
let lastSaved = null;
let lastAcceptedAt = 0;
let latestEvent = null;
let rejectedFrames = 0;
let acceptedProfiles = 0;

const SAMPLE_INTERVAL_MS = 280;
const STABLE_FRAMES = 3;
const MIN_COVERAGE = 32;
const MAX_SIGMA = 3.4;
const STABILITY_LIMIT_PX = 1.35;
const NEW_PROFILE_LIMIT_PX = 1.15;
const OCCLUSION_JUMP_PX = 18;
const MIN_SAVE_INTERVAL_MS = 650;

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

  actions.prepend(start, stop, state);
  start.addEventListener('click', startCollection);
  stop.addEventListener('click', stopCollection);
}

function axisLength(detection) {
  return detection.orientation === 'horizontal' ? detection.width : detection.height;
}

function profileVector(detection, bins = 160) {
  const vector = new Float32Array(bins);
  vector.fill(Number.NaN);
  const counts = new Uint16Array(bins);
  const length = Math.max(1, axisLength(detection));

  for (const point of detection.points || []) {
    const fixed = detection.orientation === 'horizontal' ? point.x : point.y;
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
  if (differences.length < a.length * .28) return Infinity;
  return median(differences);
}

function quality(event) {
  const d = event.detail || {};
  const coverage = Number(d.coverage || 0);
  const sigma = Number(d.meanSigma || 99);
  const points = d.points?.length || 0;
  const minimumPoints = Math.max(35, Math.round(axisLength(d) * .25));
  return {
    valid: points >= minimumPoints && coverage >= MIN_COVERAGE && sigma <= MAX_SIGMA,
    coverage,
    sigma,
    points,
  };
}

function setState(text) {
  const element = document.querySelector('#auto-profile-state');
  if (element) element.textContent = text;
}

function processDetection(event) {
  latestEvent = event;
  if (!running) return;

  const d = event.detail || {};
  const q = quality(event);
  if (!q.valid) {
    recent.length = 0;
    rejectedFrames += 1;
    setState(`Pausar: ofullständig/skymd profil · ${q.points} punkter · ${q.coverage}%`);
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

  recent.push({ vector, detection: d, capturedAt: performance.now() });
  if (recent.length > STABLE_FRAMES) recent.shift();
  if (recent.length < STABLE_FRAMES) {
    setState(`Verifierar stabilitet ${recent.length}/${STABLE_FRAMES}…`);
    return;
  }

  const d01 = distance(recent[0].vector, recent[1].vector);
  const d12 = distance(recent[1].vector, recent[2].vector);
  const stability = Math.max(d01, d12);
  if (stability > STABILITY_LIMIT_PX) {
    setState(`Stocken rör sig · väntar på stabil profil · ${stability.toFixed(2)} px`);
    return;
  }

  const candidate = recent[2];
  const changed = lastSaved ? distance(lastSaved, candidate.vector) : Infinity;
  if (lastSaved && changed < NEW_PROFILE_LIMIT_PX) {
    setState(`Stabil men oförändrad · skillnad ${changed.toFixed(2)} px`);
    return;
  }

  const now = performance.now();
  if (now - lastAcceptedAt < MIN_SAVE_INTERVAL_MS) return;

  const save = document.querySelector('#save-laser-profile');
  if (!save || save.disabled) {
    setState('Stabil profil hittad men sparfunktionen är inte redo');
    return;
  }

  save.click();
  lastSaved = candidate.vector.slice();
  lastAcceptedAt = now;
  acceptedProfiles += 1;
  recent.length = 0;
  setState(`Profil ${acceptedProfiles} sparad automatiskt · förändring ${Number.isFinite(changed) ? changed.toFixed(2) : 'första'} px · ${rejectedFrames} störda bildrutor ignorerade`);
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
  setState(running ? 'Profiler rensade · fortsätter samla' : 'Profiler rensade');
});
window.addEventListener('pagehide', stopCollection);

ensureUi();
