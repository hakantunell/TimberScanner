import { registerAnalysisStage } from './analysis-pipeline.js';

const panel = document.querySelector('#feature-matching');
const status = document.querySelector('#feature-match-status');
const detail = document.querySelector('#feature-match-detail');
const canvas = document.querySelector('#feature-match-canvas');
const chainSummary = document.querySelector('#match-chain-summary');
const chainList = document.querySelector('#match-chain-list');
const processedPairs = new Set();
const results = new Map();
const pending = new Map();
let requestId = 0;
let worker = null;
let workerReady = false;
let lastWorkerStage = 'workern har inte startat';

function workerUrl() {
  return new URL('./orb-worker-v29.js?v=20260728-30', import.meta.url);
}

function stageText(message) {
  const names = {
    grayscale: 'Konverterar bilderna till gråskala',
    corners: 'Letar stabila hörnpunkter',
    descriptors: `Skapar orienterade BRIEF-deskriptorer för ${message.keypointsA ?? 0}/${message.keypointsB ?? 0} punkter`,
    matching: `Matchar ${message.keypointsA ?? 0}/${message.keypointsB ?? 0} deskriptorer med Hamming-avstånd`,
    ransac: `Affin RANSAC på ${message.rawMatches ?? 0} ömsesidiga matchningar`,
  };
  return names[message.stage ?? message.progress] ?? message.stage ?? message.progress ?? 'okänd workerfas';
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
  lastWorkerStage = 'startar lokal JavaScript-worker v20260728-30';
  worker = new Worker(workerUrl(), { type: 'classic' });
  worker.addEventListener('message', (event) => {
    const message = event.data ?? {};
    if (message.type === 'ready') {
      workerReady = true;
      lastWorkerStage = `worker redo: ${message.engine ?? 'bildmatchning'}`;
      detail.textContent = `${lastWorkerStage} · version ${message.version}`;
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.progress) {
      lastWorkerStage = stageText(message);
      detail.textContent = lastWorkerStage;
      return;
    }
    pending.delete(message.id);
    window.clearTimeout(entry.timeout);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || 'Bildmatchningsworkern misslyckades'));
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(`${event.message || 'Bildmatchningsworkern kraschade'} · senaste fas: ${lastWorkerStage}`);
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

function imageData(image, maxWidth = 480) {
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.max(200, Math.round(image.naturalWidth * scale));
  work.height = Math.max(150, Math.round(image.naturalHeight * scale));
  const context = work.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, work.width, work.height);
  return { canvas: work, data: context.getImageData(0, 0, work.width, work.height) };
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
      reject(new Error(`Bildmatchningsworkern tog längre än 25 sekunder · senaste fas: ${lastWorkerStage}`));
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

function drawPair(left, right, points = [], label = 'Förbereder bildmatchning…') {
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
  context.strokeStyle = 'rgba(244,211,94,.82)';
  context.lineWidth = 1.35;
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

function classify(result) {
  if (result.error) return 'rejected';
  if (result.matches >= 12 && result.inlierRatio >= 35 && result.meanError <= 5) return 'approved';
  if (result.matches >= 6 && result.inlierRatio >= 20 && result.meanError <= 8) return 'weak';
  return 'rejected';
}

function classLabel(classification) {
  return classification === 'approved' ? 'Godkänt' : classification === 'weak' ? 'Svagt' : 'Underkänt';
}

function renderChain(figures) {
  if (!chainSummary || !chainList) return;
  const rows = [];
  let approved = 0;
  let weak = 0;
  let rejected = 0;

  for (let index = 1; index < figures.length; index += 1) {
    const first = figures[index - 1];
    const second = figures[index];
    const pairId = `${first.dataset.captureId}|${second.dataset.captureId}`;
    const result = results.get(pairId);
    const classification = result ? classify(result) : 'pending';
    if (classification === 'approved') approved += 1;
    else if (classification === 'weak') weak += 1;
    else if (classification === 'rejected') rejected += 1;

    const row = document.createElement('article');
    row.className = `match-chain-row match-${classification}`;
    const heading = document.createElement('strong');
    heading.textContent = `Bild ${index} ↔ Bild ${index + 1}`;
    const badge = document.createElement('span');
    badge.className = 'match-chain-badge';
    badge.textContent = classification === 'pending' ? 'Väntar' : classLabel(classification);
    const metrics = document.createElement('small');
    metrics.textContent = result?.error
      ? result.error
      : result
        ? `${result.matches}/${result.rawMatches} inliers · ${result.inlierRatio}% · fel ${result.meanError}px`
        : 'Inte analyserat ännu';
    row.append(heading, badge, metrics);
    rows.push(row);
  }

  chainList.replaceChildren(...rows);
  const total = Math.max(0, figures.length - 1);
  const pendingCount = total - approved - weak - rejected;
  chainSummary.textContent = `${approved} godkända · ${weak} svaga · ${rejected} underkända · ${pendingCount} väntar`;
}

async function matchPair(firstFigure, secondFigure) {
  const firstImage = firstFigure.querySelector('img');
  const secondImage = secondFigure.querySelector('img');
  if (!firstImage?.naturalWidth || !secondImage?.naturalWidth) throw new Error('Bildparet är inte färdigavkodat');
  const left = imageData(firstImage);
  const right = imageData(secondImage);
  drawPair(left.canvas, right.canvas, [], 'Bildparet skickat till lokal ORB-liknande worker');
  detail.textContent = `Skickar ${left.data.width}×${left.data.height} och ${right.data.width}×${right.data.height}`;
  const result = await requestMatch(left, right);
  drawPair(left.canvas, right.canvas, result.points, `${result.matches}/${result.rawMatches} RANSAC-inliers · ${result.inlierRatio}% · lokal ORB-liknande matcher`);
  return result;
}

registerAnalysisStage({
  name: 'feature-matching',
  async run() {
    const figures = selectedFigures();
    panel.hidden = false;
    renderChain(figures);
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
      detail.textContent = workerReady ? 'Lokal bildmatchningsworker redo' : 'Startar lokal bildmatchningsworker…';
      try {
        const result = await matchPair(first, second);
        processedPairs.add(pairId);
        results.set(pairId, { pairId, ...result });
        const classification = classify(result);
        status.textContent = classification === 'approved'
          ? 'Geometriskt stabil bildmatchning'
          : classification === 'weak'
            ? 'Geometriskt svag bildmatchning'
            : 'Underkänd bildmatchning';
        const motion = result.motion;
        const motionText = motion ? `rotation ${motion.rotation}° · skala ${motion.scale} · förskjutning ${motion.tx}, ${motion.ty} px` : 'ingen stabil affin modell';
        detail.textContent = `${result.matches}/${result.rawMatches} inliers (${result.inlierRatio}%) · ${result.ratioMatches} ratio-matchningar · fel ${result.meanError}px · ${motionText}`;
        window.dispatchEvent(new CustomEvent('timberscanner:pair-matched', { detail: { pairId, classification, ...result } }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        processedPairs.add(pairId);
        results.set(pairId, { pairId, error: message });
        status.textContent = 'Bildmatchningen misslyckades';
        detail.textContent = message;
        console.error(error);
      }
      renderChain(figures);
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    const orderedResults = [];
    for (let index = 1; index < figures.length; index += 1) {
      const pairId = `${figures[index - 1].dataset.captureId}|${figures[index].dataset.captureId}`;
      const result = results.get(pairId);
      if (result) orderedResults.push(result);
    }
    const approved = orderedResults.filter((item) => classify(item) === 'approved').length;
    const weak = orderedResults.filter((item) => classify(item) === 'weak').length;
    const rejected = orderedResults.filter((item) => classify(item) === 'rejected').length;
    status.textContent = `Bildkedja klar: ${approved}/${figures.length - 1} godkända par`;
    detail.textContent = `${weak} svaga · ${rejected} underkända · pose och triangulering är fortfarande avstängda`;
    renderChain(figures);
    window.dispatchEvent(new CustomEvent('timberscanner:match-chain-ready', {
      detail: { approved, weak, rejected, total: figures.length - 1, results: orderedResults },
    }));
  },
});

window.addEventListener('pagehide', () => {
  worker?.terminate();
  worker = null;
  workerReady = false;
});
