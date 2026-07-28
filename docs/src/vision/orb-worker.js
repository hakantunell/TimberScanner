function toGray(image) {
  const rgba = new Uint8Array(image.buffer);
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i += 1) {
    const o = i * 4;
    gray[i] = Math.round((rgba[o] * 0.299) + (rgba[o + 1] * 0.587) + (rgba[o + 2] * 0.114));
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
      const i = (y * width) + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + width] - gray[i - width]);
      const d = Math.abs(gray[i + width + 1] - gray[i - width - 1]);
      const score = gx + gy + Math.round(d * 0.5);
      if (score >= 46) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    let separated = true;
    for (const point of selected) {
      const dx = point.x - candidate.x;
      const dy = point.y - candidate.y;
      if ((dx * dx) + (dy * dy) < 81) { separated = false; break; }
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
      total += Math.abs(
        grayA[((pointA.y + dy) * widthA) + pointA.x + dx]
        - grayB[((pointB.y + dy) * widthB) + pointB.x + dx],
      );
      count += 1;
    }
  }
  return total / count;
}

function solve3(matrix, values) {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-6) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item < 4; item += 1) rows[column][item] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let item = column; item < 4; item += 1) rows[row][item] -= factor * rows[column][item];
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

function affineFrom(matches) {
  const matrix = matches.map((match) => [match.a.x, match.a.y, 1]);
  const x = solve3(matrix, matches.map((match) => match.b.x));
  const y = solve3(matrix, matches.map((match) => match.b.y));
  if (!x || !y) return null;
  return { a: x[0], b: x[1], tx: x[2], c: y[0], d: y[1], ty: y[2] };
}

function project(model, point) {
  return {
    x: (model.a * point.x) + (model.b * point.y) + model.tx,
    y: (model.c * point.x) + (model.d * point.y) + model.ty,
  };
}

function randomThree(matches) {
  const picked = [];
  const used = new Set();
  while (picked.length < 3) {
    const index = Math.floor(Math.random() * matches.length);
    if (used.has(index)) continue;
    used.add(index);
    picked.push(matches[index]);
  }
  return picked;
}

function affineRansac(matches, iterations = 180, threshold = 5.5) {
  if (matches.length < 3) return { inliers: matches, model: null, ratio: matches.length ? 1 : 0, meanError: 0 };
  let bestInliers = [];
  let bestModel = null;
  let bestError = Infinity;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const model = affineFrom(randomThree(matches));
    if (!model) continue;
    const inliers = [];
    let totalError = 0;
    for (const match of matches) {
      const predicted = project(model, match.a);
      const error = Math.hypot(predicted.x - match.b.x, predicted.y - match.b.y);
      if (error <= threshold) { inliers.push(match); totalError += error; }
    }
    const meanError = inliers.length ? totalError / inliers.length : Infinity;
    if (inliers.length > bestInliers.length || (inliers.length === bestInliers.length && meanError < bestError)) {
      bestInliers = inliers;
      bestModel = model;
      bestError = meanError;
    }
  }
  const rotation = bestModel ? Math.atan2(bestModel.c, bestModel.a) * (180 / Math.PI) : 0;
  const scaleX = bestModel ? Math.hypot(bestModel.a, bestModel.c) : 1;
  const scaleY = bestModel ? Math.hypot(bestModel.b, bestModel.d) : 1;
  return {
    inliers: bestInliers,
    ratio: matches.length ? bestInliers.length / matches.length : 0,
    meanError: Number.isFinite(bestError) ? Math.round(bestError * 10) / 10 : 0,
    model: bestModel ? {
      tx: Math.round(bestModel.tx * 10) / 10,
      ty: Math.round(bestModel.ty * 10) / 10,
      rotation: Math.round(rotation * 10) / 10,
      scale: Math.round(((scaleX + scaleY) / 2) * 1000) / 1000,
    } : null,
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
      if (!best || distance < best.distance) { second = best; best = { point: pointB, distance }; }
      else if (!second || distance < second.distance) second = { point: pointB, distance };
    }
    if (best && second && best.distance < 34 && best.distance < second.distance * 0.84) {
      accepted.push({ a: { x: pointA.x, y: pointA.y }, b: { x: best.point.x, y: best.point.y }, distance: Math.round(best.distance * 10) / 10 });
    }
  }
  accepted.sort((a, b) => a.distance - b.distance);
  self.postMessage({ id, progress: 'ransac', rawMatches: accepted.length });
  const filtered = affineRansac(accepted);
  return {
    keypointsA: pointsA.length,
    keypointsB: pointsB.length,
    rawMatches: accepted.length,
    matches: filtered.inliers.length,
    inlierRatio: Math.round(filtered.ratio * 100),
    meanError: filtered.meanError,
    motion: filtered.model,
    points: filtered.inliers.slice(0, 100),
    rawPoints: accepted.slice(0, 100),
    algorithm: 'central-roi-patch-affine-ransac-v1',
  };
}

self.postMessage({ type: 'ready', version: '20260728-19' });
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try { self.postMessage({ id, ok: true, result: matchFeatures(id, payload.left, payload.right) }); }
  catch (error) { self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
});