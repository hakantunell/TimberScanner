import { registerAnalysisStage } from './analysis-pipeline.js';

const panel = document.querySelector('#feature-matching');
const status = document.querySelector('#feature-match-status');
const detail = document.querySelector('#feature-match-detail');
const canvas = document.querySelector('#feature-match-canvas');
const processedPairs = new Set();
const results = [];

async function getOpenCv() {
  const loaded = await window.timberscannerLoadOpenCv();
  const cv = loaded instanceof Promise ? await loaded : loaded;
  if (cv?.Mat) return cv;
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (window.cv?.Mat) resolve();
      else if (Date.now() - started > 30000) reject(new Error('OpenCV initierades inte'));
      else window.setTimeout(poll, 100);
    };
    poll();
  });
  return window.cv;
}

function selectedFigures() {
  return [...document.querySelectorAll('#captures figure[data-selected="true"]')].reverse();
}

function imageCanvas(image, maxWidth = 640) {
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.max(160, Math.round(image.naturalWidth * scale));
  work.height = Math.max(120, Math.round(image.naturalHeight * scale));
  work.getContext('2d').drawImage(image, 0, 0, work.width, work.height);
  return work;
}

function drawSummary(left, right, matches) {
  const width = 960;
  const half = width / 2;
  const scaleA = Math.min(half / left.width, 360 / left.height);
  const scaleB = Math.min(half / right.width, 360 / right.height);
  canvas.width = width;
  canvas.height = 420;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, 420);
  ctx.drawImage(left, 0, 0, left.width * scaleA, left.height * scaleA);
  ctx.drawImage(right, half, 0, right.width * scaleB, right.height * scaleB);
  ctx.strokeStyle = 'rgba(244,211,94,.45)';
  ctx.lineWidth = 1;
  for (const match of matches.slice(0, 80)) {
    ctx.beginPath();
    ctx.moveTo(match.a.x * scaleA, match.a.y * scaleA);
    ctx.lineTo(half + match.b.x * scaleB, match.b.y * scaleB);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(`${matches.length} godkända ORB-matchningar`, 16, 402);
}

function point(vector, index) {
  const item = vector.get(index);
  return { x: item.pt.x, y: item.pt.y };
}

async function matchPair(cv, firstFigure, secondFigure) {
  const firstImage = firstFigure.querySelector('img');
  const secondImage = secondFigure.querySelector('img');
  if (!firstImage?.naturalWidth || !secondImage?.naturalWidth) throw new Error('Bildparet är inte färdigavkodat');
  const left = imageCanvas(firstImage);
  const right = imageCanvas(secondImage);
  const rgbaA = cv.imread(left);
  const rgbaB = cv.imread(right);
  const grayA = new cv.Mat();
  const grayB = new cv.Mat();
  const keyA = new cv.KeyPointVector();
  const keyB = new cv.KeyPointVector();
  const descA = new cv.Mat();
  const descB = new cv.Mat();
  const mask = new cv.Mat();
  const orb = new cv.ORB(900);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  const resources = [rgbaA, rgbaB, grayA, grayB, keyA, keyB, descA, descB, mask, orb, matcher, knn];
  try {
    cv.cvtColor(rgbaA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(rgbaB, grayB, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(grayA, mask, keyA, descA);
    orb.detectAndCompute(grayB, mask, keyB, descB);
    if (descA.empty() || descB.empty()) throw new Error('För få bilddetaljer');
    matcher.knnMatch(descA, descB, knn, 2);
    const accepted = [];
    for (let i = 0; i < knn.size(); i += 1) {
      const pair = knn.get(i);
      if (pair.size() >= 2) {
        const a = pair.get(0);
        const b = pair.get(1);
        if (a.distance < b.distance * 0.72 && a.distance < 72) {
          accepted.push({ a: point(keyA, a.queryIdx), b: point(keyB, a.trainIdx), distance: a.distance });
        }
      }
      pair.delete();
    }
    accepted.sort((x, y) => x.distance - y.distance);
    drawSummary(left, right, accepted);
    return { keypointsA: keyA.size(), keypointsB: keyB.size(), matches: accepted.length };
  } finally {
    for (const resource of resources.reverse()) {
      try { resource.delete(); } catch { /* best effort */ }
    }
  }
}

registerAnalysisStage({
  name: 'feature-matching',
  async run() {
    const figures = selectedFigures();
    if (figures.length < 2) return;
    panel.hidden = false;
    for (let i = 1; i < figures.length; i += 1) {
      const first = figures[i - 1];
      const second = figures[i];
      const pairId = `${first.dataset.captureId}|${second.dataset.captureId}`;
      if (processedPairs.has(pairId)) continue;
      status.textContent = `Matchar valt bildpar ${i}/${figures.length - 1}…`;
      detail.textContent = 'ORB körs sekventiellt i 640 px';
      const cv = await getOpenCv();
      const result = await matchPair(cv, first, second);
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
