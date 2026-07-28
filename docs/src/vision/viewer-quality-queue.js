import { analyseCanvasQuality, describeSharpness } from './image-quality.js';

const captures = document.querySelector('#captures');
const analysisCount = document.querySelector('#analysis-count');
const storageStatus = document.querySelector('#storage-status');

const analysed = new Set();
let running = false;
let scheduled = false;

function updateCount() {
  if (analysisCount) analysisCount.textContent = String(analysed.size);
}

function waitForImage(image) {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Bildavkodningen tog för lång tid')), 15000);
    image.addEventListener('load', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    image.addEventListener('error', () => {
      window.clearTimeout(timeout);
      reject(new Error('Bilden kunde inte avkodas'));
    }, { once: true });
  });
}

async function analyseFigure(figure) {
  const id = figure.dataset.captureId;
  if (!id || analysed.has(id)) return;

  const image = figure.querySelector('img');
  const caption = figure.querySelector('figcaption');
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
  figure.className = `quality-${quality.sharpness}`;
  if (caption) caption.textContent = `${caption.textContent.replace(/ · Analys avstängd$/, '')} · ${describeSharpness(quality)}`;
  updateCount();
}

async function runQueue() {
  scheduled = false;
  if (running || !captures) return;
  running = true;

  try {
    while (true) {
      const pending = [...captures.querySelectorAll('figure[data-capture-id]')]
        .reverse()
        .find((figure) => !analysed.has(figure.dataset.captureId));
      if (!pending) break;

      if (storageStatus) storageStatus.textContent = `Analyserar ${analysed.size + 1}`;
      try {
        await analyseFigure(pending);
      } catch (error) {
        const id = pending.dataset.captureId;
        if (id) analysed.add(id);
        const caption = pending.querySelector('figcaption');
        if (caption) caption.textContent += ` · Analysfel: ${error.message}`;
        console.error('Sekventiell bildanalys misslyckades', error);
        updateCount();
      }

      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  } finally {
    running = false;
    if (storageStatus) storageStatus.textContent = 'Analys klar';
  }
}

function scheduleQueue() {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(runQueue, 500);
}

if (captures) {
  new MutationObserver(scheduleQueue).observe(captures, { childList: true });
  scheduleQueue();
}
