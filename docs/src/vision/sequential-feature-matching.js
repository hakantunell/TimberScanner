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

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./orb-worker.js', import.meta.url), { type: 'classic' });
  worker.addEventListener('message', (event) => {
    const entry = pending.get(event.data?.id);
    if (!entry) return;
    pending.delete(event.data.id);
    window.clearTimeout(entry.timeout);
    if (event.data.ok) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.error || 'ORB-worker misslyckades'));
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'ORB-worker kraschade');
    for (const entry of pending.values()) {
      window.clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
    worker.terminate();
    worker = null;
  });
  return worker;
}

function selectedFigures() {
  return [...document.querySelectorAll('#captures figure[data-selection="selected"]')].reverse();
}

function imageData(image, maxWidth = 480) {
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
      reject(new Error('ORB-worker tog längre än 25 sekunder'));
    }, 25000);
    pending.set(id, { resolve, reject, timeout });
    ensureWorker().postMessage({
      id,
      type: 'match',
      payload: {
        left: { width: left.data.width, height: left.data.height, buffer: leftBuffer },
        right: { width: right.data.width, height: right.data.height, buffer: rightBuffer },
      },
    }, [leftBuffer, rightBuffer]);
  });
}

function drawSummary(left, right, points, matchCount) {
  const width = 960;
  const half = width / 2;
  const scaleA = Math.min(half / left.width, 360 / left.height);
  const scaleB = Math.min(half / right.width, 360 / right.height);
  canvas.width = width;
  canvas.height = 420;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, 420);
  context.drawImage(left, 0, 0, left.width * scaleA, left.height * scaleA);
  context.drawImage(right, half, 0, right.width * scaleB, right.height * scaleB);
  context.strokeStyle = 'rgba(244,211,94,.45)';
  context.lineWidth = 1;
  for (const match of points) {
    context.beginPath();
    context.moveTo(match.a.x * scaleA, match.a.y * scaleA);
    context.lineTo(half + match.b.x * scaleB, match.b.y * scaleB);
    context.stroke();
  }
  context.fillStyle = 'rgba(255,255,255,.9)';
  context.font = '14px system-ui, sans-serif';
  context.fillText(`${matchCount} godkända ORB-matchningar · kördes i Web Worker`, 16, 402);
}

async function matchPair(firstFigure, secondFigure) {
  const firstImage = firstFigure.querySelector('img');
  const secondImage = secondFigure.querySelector('img');
  if (!firstImage?.naturalWidth || !secondImage?.naturalWidth) throw new Error('Bildparet är inte färdigavkodat');
  const left = imageData(firstImage);
  const right = imageData(secondImage);
  const result = await requestMatch(left, right);
  drawSummary(left.canvas, right.canvas, result.points, result.matches);
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
      detail.textContent = 'ORB körs i Web Worker på 480 px';
      const result = await matchPair(first, second);
      processedPairs.add(pairId);
      results.push({ pairId, ...result });
      status.textContent = result.matches >= 40 ? 'Stabil bildmatchning' : 'Svag bildmatchning';
      detail.textContent = `${result.matches} matchningar · ${result.keypointsA}/${result.keypointsB} nyckelpunkter`;
      window.dispatchEvent(new CustomEvent('timberscanner:pair-matched', { detail: { pairId, ...result } }));
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return;
    }

    if (results.length) {
      const usable = results.filter((item) => item.matches >= 40).length;
      status.textContent = `Bildmatchning klar: ${usable}/${results.length} användbara par`;
      detail.textContent = 'Pose och triangulering är fortfarande avstängda';
    }
  },
});

window.addEventListener('pagehide', () => {
  worker?.terminate();
  worker = null;
});