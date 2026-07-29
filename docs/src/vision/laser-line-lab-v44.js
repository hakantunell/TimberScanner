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
let scheduled = 0;
let lastCaptureId = '';

const views = [
  ['original', 'Original'],
  ['redness', 'Rödhetsbild'],
  ['mask', 'Lasermask'],
  ['centerline', 'Detekterad centrumlinje'],
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
    const brightnessGate = Math.max(0, r - 40) / 215;
    const value = Math.max(0, dominance * 1.35 + saturation * .35) * brightnessGate;
    score[p] = value;
    if ((p & 7) === 0) samples.push(value);
  }
  samples.sort((a, b) => a - b);
  const sensitivity = Number(thresholdInput?.value || 62);
  const percentile = Math.max(.75, Math.min(.995, .995 - sensitivity / 100 * .20));
  const adaptive = samples[Math.floor((samples.length - 1) * percentile)] || 0;
  const threshold = Math.max(12, adaptive, 72 - sensitivity * .65);
  return { score, threshold };
}

function makeMask(score, width, height, threshold) {
  let mask = new Uint8Array(score.length);
  for (let i = 0; i < score.length; i += 1) mask[i] = score[i] >= threshold ? 1 : 0;
  const cleaned = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += mask[(y + dy) * width + x + dx];
      cleaned[y * width + x] = sum >= 3 ? 1 : 0;
    }
  }
  return cleaned;
}

function detectLine(mask, score, width, height, requestedOrientation) {
  const verticalPoints = [];
  for (let y = 0; y < height; y += 1) {
    let weighted = 0; let total = 0; let peak = 0;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const w = score[i] * score[i];
      weighted += x * w; total += w; peak = Math.max(peak, score[i]);
    }
    if (total > 0) verticalPoints.push({ x: weighted / total, y, strength: peak });
  }

  const horizontalPoints = [];
  for (let x = 0; x < width; x += 1) {
    let weighted = 0; let total = 0; let peak = 0;
    for (let y = 0; y < height; y += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const w = score[i] * score[i];
      weighted += y * w; total += w; peak = Math.max(peak, score[i]);
    }
    if (total > 0) horizontalPoints.push({ x, y: weighted / total, strength: peak });
  }

  let orientation = requestedOrientation;
  if (orientation === 'auto') {
    const verticalCoverage = verticalPoints.length / height;
    const horizontalCoverage = horizontalPoints.length / width;
    orientation = verticalCoverage >= horizontalCoverage ? 'vertical' : 'horizontal';
  }
  let points = orientation === 'vertical' ? verticalPoints : horizontalPoints;

  // Remove isolated outliers by requiring local continuity.
  points = points.filter((point, index, all) => {
    const previous = all[Math.max(0, index - 1)];
    const next = all[Math.min(all.length - 1, index + 1)];
    const coordinate = orientation === 'vertical' ? point.x : point.y;
    const p = orientation === 'vertical' ? previous.x : previous.y;
    const n = orientation === 'vertical' ? next.x : next.y;
    return Math.min(Math.abs(coordinate - p), Math.abs(coordinate - n)) < 18;
  });
  return { orientation, points, verticalCount: verticalPoints.length, horizontalCount: horizontalPoints.length };
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
  context.strokeStyle = '#35ff75';
  context.lineWidth = 2;
  context.beginPath();
  detection.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.stroke();
  context.fillStyle = '#35ff75';
  for (let i = 0; i < detection.points.length; i += Math.max(1, Math.floor(detection.points.length / 60))) {
    const point = detection.points[i];
    context.beginPath(); context.arc(point.x, point.y, 2.2, 0, Math.PI * 2); context.fill();
  }
}

async function analyze() {
  ensureUi();
  panel.hidden = false;
  status.textContent = 'Analyserar laserlinjen…';
  const source = captureSource();
  const redness = computeRedness(source.imageData);
  const mask = makeMask(redness.score, source.imageData.width, source.imageData.height, redness.threshold);
  const detection = detectLine(mask, redness.score, source.imageData.width, source.imageData.height, orientationSelect?.value || 'auto');

  paintOriginal(canvases.get('original'), source.canvas);
  let maxScore = 1;
  for (const value of redness.score) maxScore = Math.max(maxScore, value);
  paintScalar(canvases.get('redness'), redness.score, source.imageData.width, source.imageData.height, Math.max(redness.threshold * 2.5, maxScore * .55));
  paintMask(canvases.get('mask'), mask, source.imageData.width, source.imageData.height);
  paintCenterline(canvases.get('centerline'), source.canvas, detection);

  const axisLength = detection.orientation === 'vertical' ? source.imageData.height : source.imageData.width;
  const coverage = Math.round(detection.points.length / axisLength * 100);
  status.textContent = detection.points.length >= 20 ? `Laserlinje hittad · ${detection.points.length} punkter` : `Svag eller ofullständig laserlinje · ${detection.points.length} punkter`;
  detail.textContent = `Riktning ${detection.orientation === 'vertical' ? 'vertikal' : 'horisontell'} · täckning ${coverage}% · tröskel ${redness.threshold.toFixed(1)} · kandidater V/H ${detection.verticalCount}/${detection.horizontalCount}`;
  window.dispatchEvent(new CustomEvent('timberscanner:laser-line-detected', { detail: { ...detection, coverage, threshold: redness.threshold, width: source.imageData.width, height: source.imageData.height } }));
}

function schedule() {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => analyze().catch((error) => {
    panel.hidden = false;
    status.textContent = 'Laseranalysen misslyckades';
    detail.textContent = error instanceof Error ? error.message : String(error);
  }), 300);
}

analyzeButton?.addEventListener('click', schedule);
orientationSelect?.addEventListener('change', schedule);
thresholdInput?.addEventListener('input', () => { if (thresholdValue) thresholdValue.textContent = thresholdInput.value; schedule(); });
new MutationObserver(() => {
  const figure = document.querySelector('#captures figure');
  const id = figure?.dataset.captureId || figure?.querySelector('img')?.src || '';
  if (id && id !== lastCaptureId) { lastCaptureId = id; schedule(); }
}).observe(captures, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-selection'] });
