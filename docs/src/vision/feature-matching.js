const captures = document.querySelector('#captures');
const panel = document.querySelector('#feature-matching');
const canvas = document.querySelector('#feature-match-canvas');
const status = document.querySelector('#feature-match-status');
const detail = document.querySelector('#feature-match-detail');

const SAMPLE_WIDTH = 360;
const MAX_FEATURES = 140;
const PATCH_RADIUS = 4;
const SEARCH_RADIUS = 55;
let lastSignature = '';
let running = false;

function imageToGray(image, targetWidth = SAMPLE_WIDTH) {
  const scale = Math.min(1, targetWidth / image.naturalWidth);
  const width = Math.max(80, Math.round(image.naturalWidth * scale));
  const height = Math.max(60, Math.round(image.naturalHeight * scale));
  const work = document.createElement('canvas');
  work.width = width;
  work.height = height;
  const context = work.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (pixels[p] * 0.299) + (pixels[p + 1] * 0.587) + (pixels[p + 2] * 0.114);
  }
  return { work, gray, width, height };
}

function detectFeatures(frame) {
  const { gray, width, height } = frame;
  const candidates = [];
  for (let y = 3; y < height - 3; y += 2) {
    for (let x = 3; x < width - 3; x += 2) {
      const i = y * width + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + width] - gray[i - width];
      const gxx = gx * gx;
      const gyy = gy * gy;
      const gxy = gx * gy;
      const response = (gxx * gyy - gxy * gxy) - (0.04 * (gxx + gyy) ** 2);
      const contrast = Math.abs(gx) + Math.abs(gy);
      if (contrast > 38) candidates.push({ x, y, score: response + contrast * contrast });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) > 9)) {
      selected.push(candidate);
      if (selected.length >= MAX_FEATURES) break;
    }
  }
  return selected;
}

function patchScore(a, b, ax, ay, bx, by) {
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let count = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy += 1) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx += 1) {
      const av = a.gray[(ay + dy) * a.width + ax + dx];
      const bv = b.gray[(by + dy) * b.width + bx + dx];
      sumA += av;
      sumB += bv;
      sumAA += av * av;
      sumBB += bv * bv;
      sumAB += av * bv;
      count += 1;
    }
  }
  const numerator = sumAB - ((sumA * sumB) / count);
  const denominator = Math.sqrt(
    Math.max(1, sumAA - ((sumA * sumA) / count))
    * Math.max(1, sumBB - ((sumB * sumB) / count)),
  );
  return numerator / denominator;
}

function matchFeatures(a, b, featuresA, featuresB) {
  const scaleX = b.width / a.width;
  const scaleY = b.height / a.height;
  const matches = [];
  for (const point of featuresA) {
    let best = null;
    let second = null;
    const expectedX = point.x * scaleX;
    const expectedY = point.y * scaleY;
    for (const candidate of featuresB) {
      if (Math.abs(candidate.x - expectedX) > SEARCH_RADIUS || Math.abs(candidate.y - expectedY) > SEARCH_RADIUS) continue;
      if (candidate.x <= PATCH_RADIUS || candidate.y <= PATCH_RADIUS || candidate.x >= b.width - PATCH_RADIUS || candidate.y >= b.height - PATCH_RADIUS) continue;
      const score = patchScore(a, b, point.x, point.y, candidate.x, candidate.y);
      if (!best || score > best.score) {
        second = best;
        best = { a: point, b: candidate, score };
      } else if (!second || score > second.score) {
        second = { a: point, b: candidate, score };
      }
    }
    if (best && best.score > 0.78 && (!second || best.score - second.score > 0.035)) matches.push(best);
  }
  matches.sort((x, y) => y.score - x.score);
  return matches.slice(0, 80);
}

function draw(frameA, frameB, featuresA, featuresB, matches) {
  const gap = 12;
  canvas.width = frameA.width + frameB.width + gap;
  canvas.height = Math.max(frameA.height, frameB.height);
  const context = canvas.getContext('2d');
  context.drawImage(frameA.work, 0, 0);
  context.drawImage(frameB.work, frameA.width + gap, 0);
  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(255, 215, 80, .78)';
  for (const match of matches) {
    context.beginPath();
    context.moveTo(match.a.x, match.a.y);
    context.lineTo(frameA.width + gap + match.b.x, match.b.y);
    context.stroke();
  }
  context.fillStyle = 'rgba(70, 220, 120, .9)';
  for (const match of matches) {
    context.beginPath();
    context.arc(match.a.x, match.a.y, 2.5, 0, Math.PI * 2);
    context.arc(frameA.width + gap + match.b.x, match.b.y, 2.5, 0, Math.PI * 2);
    context.fill();
  }
}

async function analyseLatestPair() {
  if (running || !captures || !panel) return;
  const images = [...captures.querySelectorAll('img')];
  if (images.length < 2) {
    panel.hidden = true;
    return;
  }
  const [latest, previous] = images;
  if (!latest.complete || !previous.complete || !latest.naturalWidth || !previous.naturalWidth) return;
  const signature = `${latest.src}|${previous.src}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  running = true;
  panel.hidden = false;
  status.textContent = 'Matchar bilddetaljer…';
  detail.textContent = 'Jämför de två senaste bildrutorna';
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const frameA = imageToGray(previous);
    const frameB = imageToGray(latest);
    const featuresA = detectFeatures(frameA);
    const featuresB = detectFeatures(frameB);
    const matches = matchFeatures(frameA, frameB, featuresA, featuresB);
    draw(frameA, frameB, featuresA, featuresB, matches);
    const ratio = Math.round((matches.length / Math.max(1, Math.min(featuresA.length, featuresB.length))) * 100);
    if (matches.length >= 28) status.textContent = 'Bra överlappning';
    else if (matches.length >= 12) status.textContent = 'Användbar överlappning';
    else status.textContent = 'För få säkra matchningar';
    detail.textContent = `${featuresA.length} + ${featuresB.length} detaljer · ${matches.length} matchningar · ${ratio} %`;
  } catch (error) {
    status.textContent = 'Bildmatchningen misslyckades';
    detail.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  } finally {
    running = false;
  }
}

if (captures && panel) {
  new MutationObserver(() => analyseLatestPair()).observe(captures, { childList: true, subtree: true });
  window.setInterval(analyseLatestPair, 1500);
  analyseLatestPair();
}
