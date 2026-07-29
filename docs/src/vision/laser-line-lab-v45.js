const panel = document.querySelector('#laser-line-lab');
const status = document.querySelector('#laser-line-status');
const detail = document.querySelector('#laser-line-detail');
const grid = document.querySelector('#laser-line-grid');
const analyzeButton = document.querySelector('#analyze-laser-frame');
const orientationSelect = document.querySelector('#laser-orientation');
const thresholdInput = document.querySelector('#laser-threshold');
const thresholdValue = document.querySelector('#laser-threshold-value');
const video = document.querySelector('#camera');
const captures = document.querySelector('#captures');

const MAX_WIDTH = 640;
const profiles = [];
let scheduled = 0;
let lastCaptureId = '';
let latestDetection = null;

const views = [
  ['original', 'Original'],
  ['redness', 'Rödhetsbild'],
  ['mask', 'Rå lasermask'],
  ['centerline', 'Subpixelcentrum och sparade profiler'],
];
const canvases = new Map();

function ensureUi() {
  if (!panel || !grid || canvases.size) return;
  for (const [key, label] of views) {
    const figure = document.createElement('figure');
    figure.className = 'segmentation-lab-view';
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    figure.append(canvas, caption);
    grid.append(figure);
    canvases.set(key, canvas);
  }

  const actions = panel.querySelector('.segmentation-lab-actions');
  if (actions && !document.querySelector('#save-laser-profile')) {
    const save = document.createElement('button');
    save.id = 'save-laser-profile';
    save.type = 'button';
    save.className = 'secondary';
    save.textContent = 'Spara profil';
    save.disabled = true;
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
        points: latestDetection.points.map((point) => ({ ...point })),
      });
      count.textContent = `${profiles.length} sparade profiler`;
      paintCenterline(canvases.get('centerline'), latestDetection.source, latestDetection);
      window.dispatchEvent(new CustomEvent('timberscanner:laser-profile-saved', {
        detail: { index: profiles.length - 1, profile: profiles.at(-1), profiles: [...profiles] },
      }));
    });

    clear.addEventListener('click', () => {
      profiles.length = 0;
      count.textContent = '0 sparade profiler';
      if (latestDetection) paintCenterline(canvases.get('centerline'), latestDetection.source, latestDetection);
      window.dispatchEvent(new CustomEvent('timberscanner:laser-profiles-cleared'));
    });
  }
}

function captureSource() {
  let source = null;
  if (video?.videoWidth && video?.videoHeight) source = video;
  if (!source) {
    const figure = [...document.querySelectorAll('#captures figure[data-selection="selected"]')][0] || document.querySelector('#captures figure');
    source = figure?.querySelector('img');
  }
  const width = source?.videoWidth || source?.naturalWidth || 0;
  const height = source?.videoHeight || source?.naturalHeight || 0;
  if (!source || !width || !height) throw new Error('Starta kameran eller ta minst en bild först');
  const scale = Math.min(1, MAX_WIDTH / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(240, Math.round(width * scale));
  canvas.height = Math.max(160, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, imageData: context.getImageData(0, 0, canvas.width, canvas.height) };
}

function computeRedness(imageData) {
  const count = imageData.width * imageData.height;
  const score = new Float32Array(count);
  const rgba = imageData.data;
  const samples = [];
  for (let p = 0, i = 0; p < count; p += 1, i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
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
  const threshold = Math.max(10, adaptive, 70 - sensitivity * .63);
  return { score, threshold };
}

function makeMask(score, width, height, threshold) {
  const mask = new Uint8Array(score.length);
  for (let i = 0; i < score.length; i += 1) mask[i] = score[i] >= threshold ? 1 : 0;
  return mask;
}

function subpixelPoint(score, width, height, fixed, orientation, threshold) {
  const axisLimit = orientation === 'horizontal' ? height : width;
  let peakIndex = -1;
  let peakValue = threshold;
  for (let variable = 0; variable < axisLimit; variable += 1) {
    const x = orientation === 'horizontal' ? fixed : variable;
    const y = orientation === 'horizontal' ? variable : fixed;
    const value = score[y * width + x];
    if (value > peakValue) { peakValue = value; peakIndex = variable; }
  }
  if (peakIndex < 0) return null;

  const radius = 4;
  let weighted = 0;
  let total = 0;
  let secondMoment = 0;
  for (let variable = Math.max(0, peakIndex - radius); variable <= Math.min(axisLimit - 1, peakIndex + radius); variable += 1) {
    const x = orientation === 'horizontal' ? fixed : variable;
    const y = orientation === 'horizontal' ? variable : fixed;
    const raw = score[y * width + x];
    const weight = Math.max(0, raw - threshold * .55);
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

  const points = [];
  for (let i = 0; i < raw.length; i += 1) {
    const point = raw[i];
    const coordinate = orientation === 'horizontal' ? point.y : point.x;
    const neighbors = raw.slice(Math.max(0, i - 2), Math.min(raw.length, i + 3))
      .map((item) => orientation === 'horizontal' ? item.y : item.x)
      .sort((a, b) => a - b);
    const median = neighbors[Math.floor(neighbors.length / 2)];
    if (Math.abs(coordinate - median) <= 8) points.push(point);
  }
  return points;
}

function detectLine(score, width, height, requestedOrientation, threshold) {
  const verticalPoints = extractOrientation(score, width, height, 'vertical', threshold);
  const horizontalPoints = extractOrientation(score, width, height, 'horizontal', threshold);
  let orientation = requestedOrientation;
  if (orientation === 'auto') {
    const verticalCoverage = verticalPoints.length / height;
    const horizontalCoverage = horizontalPoints.length / width;
    orientation = horizontalCoverage >= verticalCoverage ? 'horizontal' : 'vertical';
  }
  const points = orientation === 'vertical' ? verticalPoints : horizontalPoints;
  return { orientation, points, verticalCount: verticalPoints.length, horizontalCount: horizontalPoints.length, width, height };
}

function paintOriginal(target, source) {
  target.width = source.width; target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}

function paintScalar(target, values, width, height, maxValue) {
  target.width = width; target.height = height;
  const context = target.getContext('2d');
  const image = context.createImageData(width, height);
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.max(0, Math.min(255, Math.round(values[i] / Math.max(1, maxValue) * 255)));
    const p = i * 4;
    image.data[p] = v; image.data[p + 1] = 0; image.data[p + 2] = 0; image.data[p + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function paintMask(target, mask, width, height) {
  target.width = width; target.height = height;
  const context = target.getContext('2d');
  const image = context.createImageData(width, height);
  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i] ? 255 : 0;
    const p = i * 4;
    image.data[p] = v; image.data[p + 1] = v; image.data[p + 2] = v; image.data[p + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function paintCenterline(target, source, detection) {
  target.width = source.width; target.height = source.height;
  const context = target.getContext('2d');
  context.drawImage(source, 0, 0);

  profiles.forEach((profile, profileIndex) => {
    context.globalAlpha = Math.max(.12, .48 - (profiles.length - profileIndex - 1) * .025);
    context.strokeStyle = '#80d7ff';
    context.lineWidth = 1;
    context.beginPath();
    profile.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.stroke();
  });

  context.globalAlpha = 1;
  context.strokeStyle = '#35ff75';
  context.lineWidth = 1.4;
  context.beginPath();
  detection.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  context.fillStyle = '#35ff75';
  for (let i = 0; i < detection.points.length; i += Math.max(1, Math.floor(detection.points.length / 90))) {
    const point = detection.points[i];
    context.beginPath(); context.arc(point.x, point.y, 1.6, 0, Math.PI * 2); context.fill();
  }
}

async function analyze() {
  ensureUi();
  panel.hidden = false;
  status.textContent = 'Beräknar lasercentrum med subpixelprecision…';
  const source = captureSource();
  const redness = computeRedness(source.imageData);
  const mask = makeMask(redness.score, source.imageData.width, source.imageData.height, redness.threshold);
  const detection = detectLine(redness.score, source.imageData.width, source.imageData.height, orientationSelect?.value || 'auto', redness.threshold);
  detection.source = source.canvas;
  latestDetection = detection;

  paintOriginal(canvases.get('original'), source.canvas);
  let maxScore = 1;
  for (const value of redness.score) maxScore = Math.max(maxScore, value);
  paintScalar(canvases.get('redness'), redness.score, source.imageData.width, source.imageData.height, Math.max(redness.threshold * 2.5, maxScore * .55));
  paintMask(canvases.get('mask'), mask, source.imageData.width, source.imageData.height);
  paintCenterline(canvases.get('centerline'), source.canvas, detection);

  const axisLength = detection.orientation === 'vertical' ? source.imageData.height : source.imageData.width;
  const coverage = Math.round(detection.points.length / axisLength * 100);
  const meanSigma = detection.points.length ? detection.points.reduce((sum, point) => sum + point.sigma, 0) / detection.points.length : 0;
  status.textContent = detection.points.length >= 20
    ? `Subpixelprofil hittad · ${detection.points.length} punkter`
    : `Svag eller ofullständig profil · ${detection.points.length} punkter`;
  detail.textContent = `Riktning ${detection.orientation === 'vertical' ? 'vertikal' : 'horisontell'} · täckning ${coverage}% · medelbredd σ ${meanSigma.toFixed(2)} px · tröskel ${redness.threshold.toFixed(1)} · sparade profiler ${profiles.length}`;
  const save = document.querySelector('#save-laser-profile');
  if (save) save.disabled = detection.points.length < 20;
  window.dispatchEvent(new CustomEvent('timberscanner:laser-line-detected', {
    detail: { ...detection, source: undefined, coverage, threshold: redness.threshold, meanSigma },
  }));
}

function schedule() {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => analyze().catch((error) => {
    panel.hidden = false;
    status.textContent = 'Laseranalysen misslyckades';
    detail.textContent = error instanceof Error ? error.message : String(error);
  }), 250);
}

analyzeButton?.addEventListener('click', schedule);
orientationSelect?.addEventListener('change', schedule);
thresholdInput?.addEventListener('input', () => {
  if (thresholdValue) thresholdValue.textContent = thresholdInput.value;
  schedule();
});
new MutationObserver(() => {
  const figure = document.querySelector('#captures figure');
  const id = figure?.dataset.captureId || figure?.querySelector('img')?.src || '';
  if (id && id !== lastCaptureId) { lastCaptureId = id; schedule(); }
}).observe(captures, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-selection'] });
