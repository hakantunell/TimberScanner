const captures = document.querySelector('#captures');
const panel = document.querySelector('#contour-diagnostics');
const sourceCanvas = document.querySelector('#contour-source');
const overlayCanvas = document.querySelector('#contour-overlay');
const status = document.querySelector('#contour-status');
const coverage = document.querySelector('#contour-coverage');

const MAX_SIDE = 720;
let lastAnalysedSource = null;
let analysisSequence = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function grayscaleAt(data, offset) {
  return (data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114);
}

function analyseEdges(imageData) {
  const { data, width, height } = imageData;
  const magnitudes = new Float32Array(width * height);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = (y * width + x) * 4;
      const tl = grayscaleAt(data, p - ((width + 1) * 4));
      const tc = grayscaleAt(data, p - (width * 4));
      const tr = grayscaleAt(data, p - ((width - 1) * 4));
      const ml = grayscaleAt(data, p - 4);
      const mr = grayscaleAt(data, p + 4);
      const bl = grayscaleAt(data, p + ((width - 1) * 4));
      const bc = grayscaleAt(data, p + (width * 4));
      const br = grayscaleAt(data, p + ((width + 1) * 4));
      const gx = -tl + tr - (2 * ml) + (2 * mr) - bl + br;
      const gy = -tl - (2 * tc) - tr + bl + (2 * bc) + br;
      const magnitude = Math.hypot(gx, gy);
      magnitudes[(y * width) + x] = magnitude;
      sum += magnitude;
      sumSquares += magnitude * magnitude;
      count += 1;
    }
  }

  const mean = count ? sum / count : 0;
  const variance = count ? Math.max(0, (sumSquares / count) - (mean * mean)) : 0;
  const threshold = clamp(mean + (Math.sqrt(variance) * 1.2), 45, 180);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let edgeCount = 0;
  const edgeMask = new Uint8Array(width * height);

  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const index = (y * width) + x;
      if (magnitudes[index] < threshold) continue;
      edgeMask[index] = 1;
      edgeCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const hasBounds = maxX >= minX && maxY >= minY;
  const boundingBox = hasBounds ? {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  } : null;
  const frameCoverage = boundingBox
    ? (boundingBox.width * boundingBox.height) / (width * height)
    : 0;

  return { edgeMask, edgeCount, threshold, boundingBox, frameCoverage };
}

function drawDiagnostics(context, image, analysis, width, height) {
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const edgeImage = context.createImageData(width, height);
  for (let index = 0; index < analysis.edgeMask.length; index += 1) {
    if (!analysis.edgeMask[index]) continue;
    const offset = index * 4;
    edgeImage.data[offset] = 0;
    edgeImage.data[offset + 1] = 255;
    edgeImage.data[offset + 2] = 80;
    edgeImage.data[offset + 3] = 190;
  }
  context.putImageData(edgeImage, 0, 0);

  if (analysis.boundingBox) {
    context.lineWidth = Math.max(2, width / 250);
    context.strokeStyle = '#ffcc00';
    context.strokeRect(
      analysis.boundingBox.x,
      analysis.boundingBox.y,
      analysis.boundingBox.width,
      analysis.boundingBox.height,
    );
  }
}

function describeCoverage(value) {
  if (value >= 0.65) return 'Objektet fyller en stor del av bilden';
  if (value >= 0.30) return 'Objektets storlek i bilden är användbar';
  if (value > 0) return 'Gå närmare objektet';
  return 'Ingen tydlig kontur hittades';
}

async function analyseImage(image) {
  if (!panel || !sourceCanvas || !overlayCanvas || !status || !coverage) return;
  if (!image?.complete || !image.naturalWidth) return;
  if (lastAnalysedSource === image.src) return;

  const sequence = ++analysisSequence;
  lastAnalysedSource = image.src;
  status.textContent = 'Analyserar senaste bildrutan…';
  panel.hidden = false;

  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (sequence !== analysisSequence) return;

  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(16, Math.round(image.naturalWidth * scale));
  const height = Math.max(16, Math.round(image.naturalHeight * scale));

  sourceCanvas.width = width;
  sourceCanvas.height = height;
  overlayCanvas.width = width;
  overlayCanvas.height = height;

  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0, width, height);
  const imageData = sourceContext.getImageData(0, 0, width, height);
  const analysis = analyseEdges(imageData);
  drawDiagnostics(overlayCanvas.getContext('2d'), image, analysis, width, height);

  const percent = Math.round(analysis.frameCoverage * 100);
  status.textContent = analysis.boundingBox
    ? `Konturkandidat hittad · ${analysis.edgeCount.toLocaleString('sv-SE')} kantpunkter`
    : 'Ingen stabil konturkandidat hittades';
  coverage.textContent = `${describeCoverage(analysis.frameCoverage)} · ungefär ${percent} % av bildytan`;
}

function inspectLatestCapture() {
  const latest = captures?.querySelector('figure img');
  if (!latest) {
    if (panel) panel.hidden = true;
    lastAnalysedSource = null;
    return;
  }
  if (latest.complete) analyseImage(latest).catch(console.error);
  else latest.addEventListener('load', () => analyseImage(latest).catch(console.error), { once: true });
}

if (captures) {
  new MutationObserver(inspectLatestCapture).observe(captures, { childList: true, subtree: true });
  inspectLatestCapture();
}
