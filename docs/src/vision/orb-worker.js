function toGray(image) {
  const rgba = new Uint8Array(image.buffer);
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round((rgba[offset] * 0.299) + (rgba[offset + 1] * 0.587) + (rgba[offset + 2] * 0.114));
  }
  return gray;
}

function detectCorners(gray, width, height, limit = 180) {
  const candidates = [];
  const margin = 8;
  const xMin = Math.max(margin, Math.round(width * 0.12));
  const xMax = Math.min(width - margin, Math.round(width * 0.88));
  const yMin = Math.max(margin, Math.round(height * 0.18));
  const yMax = Math.min(height - margin, Math.round(height * 0.82));
  for (let y = yMin; y < yMax; y += 4) {
    for (let x = xMin; x < xMax; x += 4) {
      const index = (y * width) + x;
      const gx = Math.abs(gray[index + 1] - gray[index - 1]);
      const gy = Math.abs(gray[index + width] - gray[index - width]);
      const diagonal = Math.abs(gray[index + width + 1] - gray[index - width - 1]);
      const score = gx + gy + Math.round(diagonal * 0.5);
      if (score >= 46) candidates.push({ x, y, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const selected = [];
  const minDistanceSquared = 9 * 9;
  for (const candidate of candidates) {
    let separated = true;
    for (const point of selected) {
      const dx = point.x - candidate.x;
      const dy = point.y - candidate.y;
      if ((dx * dx) + (dy * dy) < minDistanceSquared) {
        separated = false;
        break;
      }
    }
    if (separated) {
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function patchDistance(grayA, widthA, pointA, grayB, widthB, pointB, radius = 2) {
  let total = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const a = grayA[((pointA.y + dy) * widthA) + pointA.x + dx];
      const b = grayB[((pointB.y + dy) * widthB) + pointB.x + dx];
      total += Math.abs(a - b);
      count += 1;
    }
  }
  return total / count;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function geometricFilter(matches, iterations = 120, threshold = 6) {
  if (matches.length < 3) return { inliers: matches, model: { dx: 0, dy: 0 }, ratio: matches.length ? 1 : 0 };
  let best = [];
  let bestDx = 0;
  let bestDy = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const seed = matches[Math.floor(Math.random() * matches.length)];
    const dx = seed.b.x - seed.a.x;
    const dy = seed.b.y - seed.a.y;
    const inliers = matches.filter((match) => Math.hypot((match.b.x - match.a.x) - dx, (match.b.y - match.a.y) - dy) <= threshold);
    if (inliers.length > best.length) {
      best = inliers;
      bestDx = dx;
      bestDy = dy;
    }
  }
  if (best.length >= 3) {
    bestDx = median(best.map((match) => match.b.x - match.a.x));
    bestDy = median(best.map((match) => match.b.y - match.a.y));
    best = matches.filter((match) => Math.hypot((match.b.x - match.a.x) - bestDx, (match.b.y - match.a.y) - bestDy) <= threshold);
  }
  return {
    inliers: best,
    model: { dx: Math.round(bestDx * 10) / 10, dy: Math.round(bestDy * 10) / 10 },
    ratio: matches.length ? best.length / matches.length : 0,
  };
}

function matchFeatures(id, left, right) {
  self.postMessage({ id, progress: 'grayscale' });
  const grayA = toGray(left);
  const grayB = toGray(right);
  self.postMessage({ id, progress: 'corners' });
  const pointsA = detectCorners(grayA, left.width, left.height);
  const pointsB = detectCorners(grayB, right.width, right.height);
  const accepted = [];
  const maxShiftX = Math.round(Math.max(left.width, right.width) * 0.38);
  const maxShiftY = Math.round(Math.max(left.height, right.height) * 0.28);
  self.postMessage({ id, progress: 'matching', keypointsA: pointsA.length, keypointsB: pointsB.length });
  for (const pointA of pointsA) {
    let best = null;
    let second = null;
    for (const pointB of pointsB) {
      if (Math.abs(pointA.x - pointB.x) > maxShiftX || Math.abs(pointA.y - pointB.y) > maxShiftY) continue;
      const distance = patchDistance(grayA, left.width, pointA, grayB, right.width, pointB);
      if (!best || distance < best.distance) {
        second = best;
        best = { point: pointB, distance };
      } else if (!second || distance < second.distance) {
        second = { point: pointB, distance };
      }
    }
    if (best && second && best.distance < 34 && best.distance < second.distance * 0.84) {
      accepted.push({ a: { x: pointA.x, y: pointA.y }, b: { x: best.point.x, y: best.point.y }, distance: Math.round(best.distance * 10) / 10 });
    }
  }
  accepted.sort((leftMatch, rightMatch) => leftMatch.distance - rightMatch.distance);
  self.postMessage({ id, progress: 'ransac', rawMatches: accepted.length });
  const filtered = geometricFilter(accepted);
  return {
    keypointsA: pointsA.length,
    keypointsB: pointsB.length,
    rawMatches: accepted.length,
    matches: filtered.inliers.length,
    inlierRatio: Math.round(filtered.ratio * 100),
    motion: filtered.model,
    points: filtered.inliers.slice(0, 100),
    rawPoints: accepted.slice(0, 100),
    algorithm: 'central-roi-patch-translation-ransac-v1',
  };
}

self.postMessage({ type: 'ready', version: '20260728-19' });
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    self.postMessage({ id, ok: true, result: matchFeatures(id, payload.left, payload.right) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});