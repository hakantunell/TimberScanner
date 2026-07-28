import { analyseCanvasQuality, describeSharpness } from './image-quality.js';

const captures = document.querySelector('#captures');
const analysisCount = document.querySelector('#analysis-count');
const storageStatus = document.querySelector('#storage-status');

const analysed = new Set();
const qualityById = new Map();
const signatureById = new Map();
const DUPLICATE_DISTANCE = 8;
let running = false;
let scheduled = false;
let lastSelectionSignature = '';

function updateCount() {
  if (analysisCount) analysisCount.textContent = String(analysed.size);
}

async function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) return;
  if (typeof image.decode === 'function') {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('Bildavkodningen tog för lång tid')), 20000)),
    ]);
    if (image.naturalWidth > 0) return;
  }
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Bildavkodningen tog för lång tid')), 20000);
    image.addEventListener('load', () => { window.clearTimeout(timeout); resolve(); }, { once: true });
    image.addEventListener('error', () => { window.clearTimeout(timeout); reject(new Error('Bilden kunde inte avkodas')); }, { once: true });
  });
}

function makeSignature(sourceCanvas) {
  const width = 16;
  const height = 12;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceCanvas, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const signature = new Uint8Array(width * height);
  for (let index = 0; index < signature.length; index += 1) {
    const offset = index * 4;
    signature[index] = Math.round((data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114));
  }
  return signature;
}

function signatureDistance(left, right) {
  if (!left || !right || left.length !== right.length) return Infinity;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

function baseCaption(figure) {
  const caption = figure.querySelector('figcaption');
  if (!caption) return '';
  if (!caption.dataset.baseCaption) {
    caption.dataset.baseCaption = caption.textContent
      .replace(/ · Analys väntar$/, '')
      .replace(/ · Analys avstängd$/, '')
      .replace(/ · Analysfel:.*$/, '');
  }
  return caption.dataset.baseCaption;
}

function applySelection() {
  if (!captures) return;
  const figures = [...captures.querySelectorAll('figure[data-capture-id]')].reverse();
  const selected = [];

  for (const figure of figures) {
    const id = figure.dataset.captureId;
    const quality = qualityById.get(id);
    const signature = signatureById.get(id);
    figure.dataset.selected = 'false';
    if (!quality || !signature) continue;
    if (quality.sharpness === 'blurry') {
      figure.dataset.selection = 'rejected-blurry';
      continue;
    }

    const previous = selected.at(-1);
    if (!previous || signatureDistance(previous.signature, signature) >= DUPLICATE_DISTANCE) {
      selected.push({ figure, id, quality, signature });
      figure.dataset.selection = 'selected';
      figure.dataset.selected = 'true';
      continue;
    }

    if (quality.sharpnessScore > previous.quality.sharpnessScore) {
      previous.figure.dataset.selection = 'rejected-duplicate';
      previous.figure.dataset.selected = 'false';
      selected[selected.length - 1] = { figure, id, quality, signature };
      figure.dataset.selection = 'selected';
      figure.dataset.selected = 'true';
    } else {
      figure.dataset.selection = 'rejected-duplicate';
    }
  }

  for (const figure of figures) {
    const id = figure.dataset.captureId;
    const quality = qualityById.get(id);
    if (!quality) continue;
    const caption = figure.querySelector('figcaption');
    const selection = figure.dataset.selection;
    figure.className = `quality-${quality.sharpness}`;
    figure.style.opacity = selection === 'selected' ? '1' : '0.42';
    figure.style.outline = selection === 'selected' ? '3px solid rgba(70,180,100,.75)' : 'none';
    const selectionText = selection === 'selected' ? 'Vald för analys' : selection === 'rejected-blurry' ? 'Bortvald: oskarp' : 'Bortvald: nästan identisk';
    if (caption) caption.textContent = `${baseCaption(figure)} · Analyserad · ${describeSharpness(quality)} · ${selectionText}`;
  }

  if (storageStatus) storageStatus.textContent = `Urval ${selected.length}/${qualityById.size}`;
  const selectedIds = selected.map((item) => item.id);
  const signature = selectedIds.join('|');
  window.dispatchEvent(new CustomEvent('timberscanner:image-selection', { detail: { selectedIds, analysed: qualityById.size } }));
  if (signature !== lastSelectionSignature) {
    lastSelectionSignature = signature;
    window.dispatchEvent(new CustomEvent('timberscanner:selection-updated', { detail: { selectedIds, analysed: qualityById.size } }));
  }
}

async function analyseFigure(figure) {
  const id = figure.dataset.captureId;
  if (!id || analysed.has(id)) return;
  const image = figure.querySelector('img');
  if (!image) return;
  await waitForImage(image);
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const quality = analyseCanvasQuality(canvas);
  analysed.add(id);
  qualityById.set(id, quality);
  signatureById.set(id, makeSignature(canvas));
  updateCount();
  applySelection();
}

async function runQueue() {
  scheduled = false;
  if (running || !captures) return;
  running = true;
  try {
    while (true) {
      const pending = [...captures.querySelectorAll('figure[data-capture-id]')].reverse().find((figure) => !analysed.has(figure.dataset.captureId));
      if (!pending) break;
      if (storageStatus) storageStatus.textContent = `Analyserar ${analysed.size + 1}`;
      try { await analyseFigure(pending); }
      catch (error) {
        const id = pending.dataset.captureId;
        if (id) analysed.add(id);
        const caption = pending.querySelector('figcaption');
        if (caption) caption.textContent = `${baseCaption(pending)} · Analysfel: ${error.message}`;
        console.error('Sekventiell bildanalys misslyckades', error);
        updateCount();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
  } finally {
    running = false;
    applySelection();
  }
}

function scheduleQueue() {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(runQueue, 250);
}

if (captures) {
  new MutationObserver(scheduleQueue).observe(captures, { childList: true });
  scheduleQueue();
}
