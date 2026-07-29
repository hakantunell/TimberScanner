const panel = document.querySelector('#segmentation-lab');
const status = document.querySelector('#segmentation-lab-status');
const detail = document.querySelector('#segmentation-lab-detail');
const grid = document.querySelector('#segmentation-lab-grid');
const candidateList = document.querySelector('#segmentation-candidates');
const rerun = document.querySelector('#rerun-segmentation-lab');
const captures = document.querySelector('#captures');

const MAX_WIDTH = 480;
const GRID = 4;
let scheduled = 0;
let lastCaptureId = '';

const views = [
  ['original', 'Original'],
  ['gradient', 'Gradient'],
  ['threshold', 'Tröskelmask'],
  ['morphology', 'Efter morfologi'],
  ['components', 'Komponenter och vald kandidat'],
];

const canvases = new Map();

function ensureUi() {
  if (!panel || !grid) return;
  if (canvases.size) return;
  for (const [key, label] of views) {
    const figure = document.createElement('figure');
    figure.className = 'segmentation-lab-view';
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 360;
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    figure.append(canvas, caption);
    grid.append(figure);
    canvases.set(key, canvas);
  }
}

function selectedFigure() {
  const figures = [...document.querySelectorAll('#captures figure[data-selection="selected"]')];
  return figures[0] ?? document.querySelector('#captures figure');
}

function imageDataFrom(image) {
  const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(200, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(150, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, data: context.getImageData(0, 0, canvas.width, canvas.height) };
}

function grayscale(imageData) {
  const gray = new Uint8Array(imageData.width * imageData.height);
  const rgba = imageData.data;
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    gray[p] = Math.round(rgba[i] * .299 + rgba[i + 1] * .587 + rgba[i + 2] * .114);
  }
  return gray;
}

function gradientMap(gray, width, height) {
  const gradient = new Float32Array(width * height);
  const samples = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx = gray[y * width + x + 1] - gray[y * width + x - 1];
      const gy = gray[(y + 1) * width + x] - gray[(y - 1) * width + x];
      const value = Math.hypot(gx, gy);
      gradient[y * width + x] = value;
      samples.push(value);
    }
  }
  samples.sort((a, b) => a - b);
  const threshold = Math.max(22, samples[Math.floor(samples.length * .72)] || 22);
  return { gradient, threshold };
}

function coarseThreshold(gradient, width, height, threshold) {
  const cw = Math.ceil(width / GRID);
  const ch = Math.ceil(height / GRID);
  const mask = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = 0; oy < GRID; oy += 1) {
        const y = cy * GRID + oy;
        if (y >= height) continue;
        for (let ox = 0; ox < GRID; ox += 1) {
          const x = cx * GRID + ox;
          if (x >= width) continue;
          sum += gradient[y * width + x];
          count += 1;
        }
      }
      mask[cy * cw + cx] = count && sum / count >= threshold * .68 ? 1 : 0;
    }
  }
  return { mask, cw, ch };
}

function morph(input, width, height, dilate, rounds = 1) {
  let current = input;
  for (let round = 0; round < rounds; round += 1) {
    const output = new Uint8Array(current.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += current[(y + dy) * width + x + dx];
        }
        output[y * width + x] = dilate ? (sum >= 2 ? 1 : 0) : (sum >= 6 ? 1 : 0);
      }
    }
    current = output;
  }
  return current;
}

function components(mask, cw, ch) {
  const visited = new Uint8Array(mask.length);
  const result = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const pixels = [];
    let minX = cw; let minY = ch; let maxX = 0; let maxY = 0;
    while (stack.length) {
      const index = stack.pop();
      pixels.push(index);
      const x = index % cw;
      const y = Math.floor(index / cw);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
        const ni = ny * cw + nx;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const area = pixels.length;
    const aspect = width / Math.max(1, height);
    const widthRatio = width / cw;
    const heightRatio = height / ch;
    const fill = area / Math.max(1, width * height);
    const centerX = (minX + maxX) / 2 / cw;
    const centerY = (minY + maxY) / 2 / ch;
    const centerDistance = Math.hypot(centerX - .5, centerY - .55);
    const horizontalScore = Math.min(3.5, aspect) * 26;
    const sizeScore = widthRatio * 95 + Math.min(.25, area / mask.length) * 180;
    const centerScore = Math.max(0, 45 - centerDistance * 110);
    const fillScore = Math.min(25, fill * 35);
    const tooHighPenalty = centerY < .30 ? 45 : 0;
    const tooTallPenalty = heightRatio > .62 ? 55 : 0;
    const score = horizontalScore + sizeScore + centerScore + fillScore - tooHighPenalty - tooTallPenalty;
    result.push({ pixels, minX, minY, maxX, maxY, width, height, area, aspect, widthRatio, heightRatio, fill, centerX, centerY, score });
  }
  return result.sort((a, b) => b.score - a.score);
}

function paintSource(target, source) {
  target.width = source.width;
  target.height = source.height;
  target.getContext('2d').drawImage(source, 0, 0);
}

function paintScalar(target, values, width, height, maxValue) {
  target.width = width;
  target.height = height;
  const context = target.getContext('2d');
  const image = context.createImageData(width, height);
  for (let i = 0; i < values.length; i += 1) {
    const value = Math.max(0, Math.min(255, Math.round(values[i] / Math.max(1, maxValue) * 255)));
    const p = i * 4;
    image.data[p] = value; image.data[p + 1] = value; image.data[p + 2] = value; image.data[p + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function paintMask(target, mask, cw, ch) {
  target.width = cw;
  target.height = ch;
  const context = target.getContext('2d');
  const image = context.createImageData(cw, ch);
  for (let i = 0; i < mask.length; i += 1) {
    const value = mask[i] ? 255 : 0;
    const p = i * 4;
    image.data[p] = value; image.data[p + 1] = value; image.data[p + 2] = value; image.data[p + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function paintComponents(target, source, candidates, cw, ch) {
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d');
  context.drawImage(source, 0, 0);
  context.lineWidth = 2;
  context.font = '13px system-ui, sans-serif';
  candidates.slice(0, 8).forEach((candidate, index) => {
    const x = candidate.minX * GRID;
    const y = candidate.minY * GRID;
    const width = candidate.width * GRID;
    const height = candidate.height * GRID;
    context.strokeStyle = index === 0 ? '#36f08b' : '#ffd45e';
    context.fillStyle = index === 0 ? '#36f08b' : '#ffd45e';
    context.strokeRect(x, y, width, height);
    context.fillText(`#${index + 1} ${Math.round(candidate.score)}`, x + 4, Math.max(14, y - 4));
  });
}

function renderCandidates(candidates) {
  if (!candidateList) return;
  if (!candidates.length) {
    candidateList.textContent = 'Inga sammanhängande komponenter hittades efter morfologin.';
    return;
  }
  const rows = candidates.slice(0, 10).map((candidate, index) => {
    const row = document.createElement('article');
    row.className = index === 0 ? 'segmentation-candidate selected' : 'segmentation-candidate';
    const title = document.createElement('strong');
    title.textContent = `Kandidat ${index + 1}${index === 0 ? ' · högst poäng' : ''}`;
    const metrics = document.createElement('small');
    metrics.textContent = `poäng ${Math.round(candidate.score)} · aspect ${candidate.aspect.toFixed(2)} · bredd ${(candidate.widthRatio * 100).toFixed(0)}% · höjd ${(candidate.heightRatio * 100).toFixed(0)}% · fyllnad ${(candidate.fill * 100).toFixed(0)}% · centrum ${candidate.centerX.toFixed(2)}, ${candidate.centerY.toFixed(2)} · area ${candidate.area}`;
    row.append(title, metrics);
    return row;
  });
  candidateList.replaceChildren(...rows);
}

async function analyze(force = false) {
  ensureUi();
  const figure = selectedFigure();
  const image = figure?.querySelector('img');
  if (!figure || !image?.naturalWidth) {
    if (status) status.textContent = 'Väntar på en bild';
    if (detail) detail.textContent = 'Ta minst en bild med USB-kameran.';
    return;
  }
  const captureId = figure.dataset.captureId || image.src;
  if (!force && captureId === lastCaptureId) return;
  lastCaptureId = captureId;
  panel.hidden = false;
  status.textContent = 'Analyserar senaste valda bild…';
  detail.textContent = `Bild ${image.naturalWidth}×${image.naturalHeight}`;

  const source = imageDataFrom(image);
  const gray = grayscale(source.data);
  const gradientInfo = gradientMap(gray, source.data.width, source.data.height);
  const coarse = coarseThreshold(gradientInfo.gradient, source.data.width, source.data.height, gradientInfo.threshold);
  let cleaned = morph(coarse.mask, coarse.cw, coarse.ch, true, 3);
  cleaned = morph(cleaned, coarse.cw, coarse.ch, false, 2);
  cleaned = morph(cleaned, coarse.cw, coarse.ch, true, 1);
  const candidates = components(cleaned, coarse.cw, coarse.ch);

  paintSource(canvases.get('original'), source.canvas);
  paintScalar(canvases.get('gradient'), gradientInfo.gradient, source.data.width, source.data.height, gradientInfo.threshold * 2.5);
  paintMask(canvases.get('threshold'), coarse.mask, coarse.cw, coarse.ch);
  paintMask(canvases.get('morphology'), cleaned, coarse.cw, coarse.ch);
  paintComponents(canvases.get('components'), source.canvas, candidates, coarse.cw, coarse.ch);
  renderCandidates(candidates);

  if (candidates.length) {
    const best = candidates[0];
    status.textContent = `Högst poäng: kandidat 1 · ${Math.round(best.score)}`;
    detail.textContent = `Gradienttröskel ${gradientInfo.threshold.toFixed(1)} · ${candidates.length} komponenter · aspect ${best.aspect.toFixed(2)} · bredd ${(best.widthRatio * 100).toFixed(0)}% · centrum y ${best.centerY.toFixed(2)}`;
  } else {
    status.textContent = 'Ingen kandidat efter morfologin';
    detail.textContent = `Gradienttröskel ${gradientInfo.threshold.toFixed(1)} · kontrollera tröskelmasken och morfologivyn`;
  }
}

function schedule(force = false) {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => analyze(force).catch((error) => {
    panel.hidden = false;
    status.textContent = 'Segmenteringslaboratoriet misslyckades';
    detail.textContent = error instanceof Error ? error.message : String(error);
  }), 350);
}

rerun?.addEventListener('click', () => schedule(true));
new MutationObserver(() => schedule()).observe(captures, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-selection', 'src'] });
window.addEventListener('timberscanner:pair-matched', () => schedule(true));
window.addEventListener('load', () => schedule(true));
