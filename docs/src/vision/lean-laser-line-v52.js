const panel = document.querySelector('#laser-line-lab');
const status = document.querySelector('#laser-line-status');
const detail = document.querySelector('#laser-line-detail');
const analyzeButton = document.querySelector('#analyze-laser-frame');
const orientationSelect = document.querySelector('#laser-orientation');
const thresholdInput = document.querySelector('#laser-threshold');
const thresholdValue = document.querySelector('#laser-threshold-value');
const video = document.querySelector('#camera');

const MAX_WIDTH = 560;
const profiles = [];
let scheduled = 0;
let latestDetection = null;

function ensureUi() {
  if (!panel) return;
  panel.hidden = false;
  const grid = document.querySelector('#laser-line-grid');
  if (grid) grid.hidden = true;
  const actions = panel.querySelector('.segmentation-lab-actions');
  if (!actions || document.querySelector('#save-laser-profile')) return;

  const save = document.createElement('button');
  save.id = 'save-laser-profile';
  save.type = 'button';
  save.className = 'secondary';
  save.textContent = 'Spara profil';
  save.disabled = true;
  save.hidden = true;

  const clear = document.createElement('button');
  clear.id = 'clear-laser-profiles';
  clear.type = 'button';
  clear.className = 'secondary';
  clear.textContent = 'Rensa profiler';

  const count = document.createElement('span');
  count.id = 'laser-profile-count';
  count.textContent = '0 sparade profiler';
  actions.append(save, clear, count);

  save.addEventListener('click', () => {
    if (!latestDetection?.points?.length) return;
    profiles.push({
      capturedAt: Date.now(),
      orientation: latestDetection.orientation,
      width: latestDetection.width,
      height: latestDetection.height,
      points: latestDetection.points.map(point => ({ ...point })),
    });
    count.textContent = `${profiles.length} sparade profiler`;
    window.dispatchEvent(new CustomEvent('timberscanner:laser-profile-saved', {
      detail: { index: profiles.length - 1, profile: profiles.at(-1), profiles: [...profiles] },
    }));
  });

  clear.addEventListener('click', () => {
    profiles.length = 0;
    count.textContent = '0 sparade profiler';
    window.dispatchEvent(new CustomEvent('timberscanner:laser-profiles-cleared'));
  });
}

function captureSource() {
  if (!video?.videoWidth || !video?.videoHeight) throw new Error('Starta kameran först');
  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(240, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(160, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { canvas, imageData: context.getImageData(0, 0, canvas.width, canvas.height) };
}

function computeRedness(imageData) {
  const count = imageData.width * imageData.height;
  const score = new Float32Array(count);
  const samples = [];
  const rgba = imageData.data;
  for (let p = 0, i = 0; p < count; p += 1, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const dominance = r - Math.max(g, b);
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const brightnessGate = Math.max(0, r - 35) / 220;
    const value = Math.max(0, dominance * 1.45 + saturation * .28) * brightnessGate;
    score[p] = value;
    if ((p & 7) === 0) samples.push(value);
  }
  samples.sort((a, b) => a - b);
  const sensitivity = Number(thresholdInput?.value || 62);
  const percentile = Math.max(.76, Math.min(.997, .996 - sensitivity / 100 * .21));
  const adaptive = samples[Math.floor((samples.length - 1) * percentile)] || 0;
  return { score, threshold: Math.max(10, adaptive, 70 - sensitivity * .63) };
}

function subpixelPoint(score, width, height, fixed, orientation, threshold) {
  const axisLimit = orientation === 'horizontal' ? height : width;
  let peakIndex = -1, peakValue = threshold;
  for (let variable = 0; variable < axisLimit; variable += 1) {
    const x = orientation === 'horizontal' ? fixed : variable;
    const y = orientation === 'horizontal' ? variable : fixed;
    const value = score[y * width + x];
    if (value > peakValue) { peakValue = value; peakIndex = variable; }
  }
  if (peakIndex < 0) return null;

  let weighted = 0, total = 0, secondMoment = 0;
  const radius = 4;
  for (let variable = Math.max(0, peakIndex - radius); variable <= Math.min(axisLimit - 1, peakIndex + radius); variable += 1) {
    const x = orientation === 'horizontal' ? fixed : variable;
    const y = orientation === 'horizontal' ? variable : fixed;
    const weight = Math.max(0, score[y * width + x] - threshold * .55);
    weighted += variable * weight;
    total += weight;
  }
  if (total <= 0) return null;
  const center = weighted / total;
  for (let variable = Math.max(0, peakIndex - radius); variable <= Math.min(axisLimit - 1, peakIndex + radius); variable += 1) {
    const x = orientation === 'horizontal' ? fixed : variable;
    const y = orientation === 'horizontal' ? variable : fixed;
    const weight = Math.max(0, score[y * width + x] - threshold * .55);
    secondMoment += (variable - center) ** 2 * weight;
  }
  const sigma = Math.sqrt(secondMoment / total);
  if (sigma > 4.2) return null;
  return orientation === 'horizontal'
    ? { x: fixed, y: center, strength: peakValue, sigma }
    : { x: center, y: fixed, strength: peakValue, sigma };
}

function extractOrientation(score, width, height, orientation, threshold) {
  const fixedLimit = orientation === 'horizontal' ? width : height;
  const raw = [];
  for (let fixed = 0; fixed < fixedLimit; fixed += 1) {
    const point = subpixelPoint(score, width, height, fixed, orientation, threshold);
    if (point) raw.push(point);
  }
  return raw.filter((point, i) => {
    const coordinate = orientation === 'horizontal' ? point.y : point.x;
    const neighbors = raw.slice(Math.max(0, i - 2), Math.min(raw.length, i + 3))
      .map(item => orientation === 'horizontal' ? item.y : item.x)
      .sort((a, b) => a - b);
    return Math.abs(coordinate - neighbors[Math.floor(neighbors.length / 2)]) <= 8;
  });
}

function detectLine(score, width, height, requestedOrientation, threshold) {
  const verticalPoints = extractOrientation(score, width, height, 'vertical', threshold);
  const horizontalPoints = extractOrientation(score, width, height, 'horizontal', threshold);
  let orientation = requestedOrientation;
  if (orientation === 'auto') orientation = horizontalPoints.length / width >= verticalPoints.length / height ? 'horizontal' : 'vertical';
  const points = orientation === 'vertical' ? verticalPoints : horizontalPoints;
  return { orientation, points, verticalCount: verticalPoints.length, horizontalCount: horizontalPoints.length, width, height };
}

async function analyze() {
  ensureUi();
  const source = captureSource();
  const redness = computeRedness(source.imageData);
  const detection = detectLine(redness.score, source.imageData.width, source.imageData.height, orientationSelect?.value || 'auto', redness.threshold);
  latestDetection = detection;
  const axisLength = detection.orientation === 'vertical' ? source.imageData.height : source.imageData.width;
  const coverage = Math.round(detection.points.length / axisLength * 100);
  const meanSigma = detection.points.length ? detection.points.reduce((sum, point) => sum + point.sigma, 0) / detection.points.length : 0;
  status.textContent = detection.points.length >= 20 ? `Laserprofil hittad · ${detection.points.length} punkter` : `Svag profil · ${detection.points.length} punkter`;
  detail.textContent = `Riktning ${detection.orientation === 'vertical' ? 'vertikal' : 'horisontell'} · täckning ${coverage}% · σ ${meanSigma.toFixed(2)} px · sparade ${profiles.length}`;
  const save = document.querySelector('#save-laser-profile');
  if (save) save.disabled = detection.points.length < 20;
  window.dispatchEvent(new CustomEvent('timberscanner:laser-line-detected', {
    detail: { ...detection, coverage, threshold: redness.threshold, meanSigma },
  }));
}

function schedule() {
  clearTimeout(scheduled);
  scheduled = setTimeout(() => analyze().catch(error => {
    status.textContent = 'Laseranalysen misslyckades';
    detail.textContent = error instanceof Error ? error.message : String(error);
  }), 40);
}

analyzeButton?.addEventListener('click', schedule);
orientationSelect?.addEventListener('change', schedule);
thresholdInput?.addEventListener('input', () => {
  if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
  schedule();
});

ensureUi();