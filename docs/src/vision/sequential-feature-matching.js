import { registerAnalysisStage } from './analysis-pipeline.js';

const panel = document.querySelector('#feature-matching');
const status = document.querySelector('#feature-match-status');
const detail = document.querySelector('#feature-match-detail');
const canvas = document.querySelector('#feature-match-canvas');
const processedPairs = new Set();
const results = [];
const pending = new Map();
let requestId = 0;
let worker = null;
let workerReady = false;

function workerUrl() {
  const url = new URL('./orb-worker.js', import.meta.url);
  url.searchParams.set('v', '20260728-17');
  return url;
}

function failPending(error) {
  for (const entry of pending.values()) {
    window.clearTimeout(entry.timeout);
    entry.reject(error);
  }
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  workerReady = false;
  worker = new Worker(workerUrl(), { type: 'classic' });
  worker.addEventListener('message', (event) => {
    const message = event.data ?? {};
    if (message.type === 'ready') {
      workerReady = true;
      detail.textContent = `Worker redo · version ${message.version}`;
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.progress) {
      const names = {
        grayscale: 'Konverterar till gråskala',
        corners: 'Letar hörnpunkter',
        matching: `Matchar ${message.keypointsA ?? 0}/${message.keypointsB ?? 0} hörnpunkter`,
      };
      detail.textContent = names[message.progress] ?? message.progress;
      return;
    }

    pending.delete(message.id);
    window.clearTimeout(entry.timeout);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || 'Bildmatchningsworkern misslyckades'));
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Bildmatchningsworkern kraschade');
    failPending(error);
    worker.terminate();
    worker = null;
    workerReady = false;
  });
  return worker;
}

function selectedFigures() {
  return [...document.querySelectorAll('#captures figure[data-selection="selected"]')].reverse();
}

function imageData(image, maxWidth = 320) {
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.max(160, Math.round(image.naturalWidth * scale));
  work.height = Math.max(120, Math.round(image.naturalHeight * scale));
  const context = work.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, work.width, work.height);
  const data = context.getImageData(0, 0, work.width, work.height);
  return { canvas: work, data };
}

function requestMatch(left, right) {
  const id = ++requestId;
  const leftBuffer = left.data.data.buffer;
  const rightBuffer = right.data.data.buffer;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      worker?.terminate();
      worker = null;
      workerReady = false;
      reject(new Error('Bildmatchningsworkern tog längre än 8 sekunder'));
    }, 8000);
    pending.set(id, { resolve, reject, timeout });
    const activeWorker = ensureWorker();
    activeWorker.postMessage({
      id,
      type: 'match',
      payload: {
        left: { width: left.data.width, height: left.data.height, buffer: leftBuffer },
        right: { width: right.data.width, height: right.data.height, buffer: rightBuffer },
      },
    }, [leftBuffer, rightBuffer]);
  });
}

function drawPair(left, right, points = [], label = 'Förbereder matchning…') {
  const width = 960;
  const half = width / 2;
  const scaleA = Math.min(half / left.width, 360 / left.height);
  const scaleB = Math.min(half / right.width, 360 / right.height);
  canvas.width = width;
  canvas.height = 420;
  const context = canvas.getContext('2d');
  context.fillStyle = '#0d1210';
  context.fillRect(0, 0, width, 420);
  context.drawImage(left, 0, 0, left.width * scaleA, left.height * scaleA);
  context.drawImage(right, half, 0, right.width * scaleB, right.height * scaleB);
  context.strokeStyle = 'rgba(244,211,94,.55)';
  context.lineWidth = 1;
  for (const match of points) {
    context.beginPath();
    context.moveTo(match.a.x * scaleA, match.a.y * scaleA);
    context.lineTo(half + match.b.x * scaleB, match.b.y * scaleB);
    context.stroke();
  }
  context.fillStyle = 'rgba(255,255,255,.95)';
  context.font = '14px system-ui, sans-serif';
  context.fillText(label, 16, 402);
}

async function matchPair(firstFigure, secondFigure) {
  const firstImage = firstFigure.querySelector('img');
  const secondImage = secondFigure.querySelector('img');
  if (!firstImage?.naturalWidth || !secondImage?.naturalWidth) throw new Error('Bildparet är inte färdigavkodat');
  const left = imageData(firstImage);
  const right = imageData(secondImage);
  drawPair(left.canvas, right.canvas, [], 'Bildparet är skickat till Web Worker');
  detail.textContent = `Skickar ${left.data.width}×${left.data.height} och ${right.data.width}×${right.data.height}`;
  const result = await requestMatch(left, right);
  drawPair(left.canvas, right.canvas, result.points, `${result.matches} lokala detaljmatchningar · Web Worker`);
  return result;
}

registerAnalysisStage({
  name: 'feature-matching',
  async run() {
    const figures = selectedFigures();
    panel.hidden = false;
    if (figures.length < 2) {
      status.textContent = `Väntar på två valda bilder (${figures.length}/2)`;
      detail.textContent = 'Skärpeanalys och bildurval måste bli klara först';
      return;
    }

    for (let index = 1; index < figures.length; index += 1) {
      const first = figures[index - 1];
      const second = figures[index];
      const pairId = `${first.dataset.captureId}|${second.dataset.captureId}`;
      if (processedPairs.has(pairId)) continue;

      status.textContent = `Matchar valt bildpar ${index}/${figures.length - 1}…`;
      detail.textContent = workerReady ? 'Worker redo' : 'Startar worker…';
      try {
        const result = await matchPair(first, second);
        processedPairs.add(pairId);
        results.push({ pairId, ...result });
        status.textContent = result.matches >= 20 ? 'Stabil bildmatchning' : 'Svag bildmatchning';
        detail.textContent = `${result.matches} matchningar · ${result.keypointsA}/${result.keypointsB} hörnpunkter`;
        window.dispatchEvent(new CustomEvent('timberscanner:pair-matched', { detail: { pairId, ...result } }));
      } catch (error) {
        status.textContent = 'Bildmatchningen misslyckades';
        detail.textContent = error instanceof Error ? error.message : String(error);
        console.error(error);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return;
    }

    if (results.length) {
      const usable = results.filter((item) => item.matches >= 20).length;
      status.textContent = `Bildmatchning klar: ${usable}/${results.length} användbara par`;
      detail.textContent = 'Pose och triangulering är fortfarande avstängda';
    }
  },
});

window.addEventListener('pagehide', () => {
  worker?.terminate();
  worker = null;
  workerReady = false;
});