const VERSION = '20260728-29';
const DESCRIPTOR_BITS = 256;
const DESCRIPTOR_WORDS = DESCRIPTOR_BITS / 32;
const PATCH_RADIUS = 15;
const MAX_KEYPOINTS = 550;

function progress(id, stage, extra = {}) {
  self.postMessage({ id, progress: stage, ...extra });
}

function rgbaToGray(image) {
  const rgba = new Uint8Array(image.buffer);
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    gray[p] = Math.round(rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114);
  }
  return gray;
}

function sample(gray, width, height, x, y) {
  const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
  return gray[yi * width + xi];
}

function detectCorners(gray, width, height) {
  const margin = PATCH_RADIUS + 3;
  const candidates = [];
  const step = 2;
  for (let y = margin; y < height - margin; y += step) {
    for (let x = margin; x < width - margin; x += step) {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        const row = (y + dy) * width;
        for (let dx = -2; dx <= 2; dx += 1) {
          const index = row + x + dx;
          const gx = gray[index + 1] - gray[index - 1];
          const gy = gray[index + width] - gray[index - width];
          sxx += gx * gx;
          syy += gy * gy;
          sxy += gx * gy;
        }
      }
      const det = sxx * syy - sxy * sxy;
      const trace = sxx + syy;
      const score = det - 0.045 * trace * trace;
      if (score > 1800000) candidates.push({ x, y, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  const minDistanceSq = 10 * 10;
  for (const candidate of candidates) {
    let close = false;
    for (const existing of selected) {
      const dx = existing.x - candidate.x;
      const dy = existing.y - candidate.y;
      if (dx * dx + dy * dy < minDistanceSq) {
        close = true;
        break;
      }
    }
    if (!close) selected.push(candidate);
    if (selected.length >= MAX_KEYPOINTS) break;
  }
  return selected;
}

function orientation(gray, width, height, point) {
  let m10 = 0;
  let m01 = 0;
  const radius = 9;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const value = sample(gray, width, height, point.x + dx, point.y + dy);
      m10 += dx * value;
      m01 += dy * value;
    }
  }
  return Math.atan2(m01, m10);
}

function createPattern() {
  let state = 0x13579bdf;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  const points = [];
  for (let i = 0; i < DESCRIPTOR_BITS; i += 1) {
    const makePoint = () => {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * PATCH_RADIUS;
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    };
    points.push([makePoint(), makePoint()]);
  }
  return points;
}

const BRIEF_PATTERN = createPattern();

function describe(gray, width, height, points) {
  return points.map((point) => {
    const angle = orientation(gray, width, height, point);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const descriptor = new Uint32Array(DESCRIPTOR_WORDS);
    for (let bit = 0; bit < DESCRIPTOR_BITS; bit += 1) {
      const [a, b] = BRIEF_PATTERN[bit];
      const ax = point.x + a.x * cos - a.y * sin;
      const ay = point.y + a.x * sin + a.y * cos;
      const bx = point.x + b.x * cos - b.y * sin;
      const by = point.y + b.x * sin + b.y * cos;
      if (sample(gray, width, height, ax, ay) < sample(gray, width, height, bx, by)) {
        descriptor[bit >>> 5] |= 1 << (bit & 31);
      }
    }
    return { ...point, angle, descriptor };
  });
}

function popcount32(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function hamming(a, b) {
  let distance = 0;
  for (let i = 0; i < DESCRIPTOR_WORDS; i += 1) distance += popcount32(a[i] ^ b[i]);
  return distance;
}

function directionalMatches(source, target, ratio = 0.78, maxDistance = 92) {
  const matches = [];
  for (let i = 0; i < source.length; i += 1) {
    let bestIndex = -1;
    let best = Infinity;
    let second = Infinity;
    for (let j = 0; j < target.length; j += 1) {
      const distance = hamming(source[i].descriptor, target[j].descriptor);
      if (distance < best) {
        second = best;
        best = distance;
        bestIndex = j;
      } else if (distance < second) second = distance;
    }
    if (bestIndex >= 0 && best <= maxDistance && best < second * ratio) {
      matches.push({ queryIdx: i, trainIdx: bestIndex, distance: best });
    }
  }
  return matches;
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
  return x && y ? { a: x[0], b: x[1], tx: x[2], c: y[0], d: y[1], ty: y[2] } : null;
}

function project(model, point) {
  return {
    x: model.a * point.x + model.b * point.y + model.tx,
    y: model.c * point.x + model.d * point.y + model.ty,
  };
}

function randomThree(matches) {
  const used = new Set();
  const result = [];
  while (result.length < 3) {
    const index = Math.floor(Math.random() * matches.length);
    if (!used.has(index)) {
      used.add(index);
      result.push(matches[index]);
    }
  }
  return result;
}

function affineRansac(matches, iterations = 450, threshold = 5) {
  if (matches.length < 3) return { inliers: [], ratio: 0, meanError: 0, model: null };
  let bestInliers = [];
  let bestModel = null;
  let bestError = Infinity;
  for (let i = 0; i < iterations; i += 1) {
    const model = affineFrom(randomThree(matches));
    if (!model) continue;
    const inliers = [];
    let totalError = 0;
    for (const match of matches) {
      const predicted = project(model, match.a);
      const error = Math.hypot(predicted.x - match.b.x, predicted.y - match.b.y);
      if (error <= threshold) {
        inliers.push(match);
        totalError += error;
      }
    }
    const meanError = inliers.length ? totalError / inliers.length : Infinity;
    if (inliers.length > bestInliers.length || (inliers.length === bestInliers.length && meanError < bestError)) {
      bestInliers = inliers;
      bestModel = model;
      bestError = meanError;
    }
  }
  const rotation = bestModel ? Math.atan2(bestModel.c, bestModel.a) * 180 / Math.PI : 0;
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

async function match(id, left, right) {
  progress(id, 'grayscale');
  const grayA = rgbaToGray(left);
  const grayB = rgbaToGray(right);

  progress(id, 'corners');
  const cornersA = detectCorners(grayA, left.width, left.height);
  const cornersB = detectCorners(grayB, right.width, right.height);
  if (cornersA.length < 12 || cornersB.length < 12) throw new Error(`För få hörnpunkter: ${cornersA.length}/${cornersB.length}`);

  progress(id, 'descriptors', { keypointsA: cornersA.length, keypointsB: cornersB.length });
  const featuresA = describe(grayA, left.width, left.height, cornersA);
  const featuresB = describe(grayB, right.width, right.height, cornersB);

  progress(id, 'matching', { keypointsA: featuresA.length, keypointsB: featuresB.length });
  const forward = directionalMatches(featuresA, featuresB);
  const reverse = directionalMatches(featuresB, featuresA);
  const reversePairs = new Set(reverse.map((item) => `${item.trainIdx}:${item.queryIdx}`));
  const mutual = forward.filter((item) => reversePairs.has(`${item.queryIdx}:${item.trainIdx}`));
  const points = mutual.map((item) => ({
    a: { x: featuresA[item.queryIdx].x, y: featuresA[item.queryIdx].y },
    b: { x: featuresB[item.trainIdx].x, y: featuresB[item.trainIdx].y },
    distance: item.distance,
  }));

  progress(id, 'ransac', { rawMatches: points.length });
  const filtered = affineRansac(points);
  return {
    keypointsA: featuresA.length,
    keypointsB: featuresB.length,
    ratioMatches: forward.length,
    rawMatches: points.length,
    matches: filtered.inliers.length,
    inlierRatio: Math.round(filtered.ratio * 100),
    meanError: filtered.meanError,
    motion: filtered.model,
    maskCoverageA: 100,
    maskCoverageB: 100,
    points: filtered.inliers.slice(0, 140),
    rawPoints: points.slice(0, 140),
    algorithm: 'local-oriented-brief-mutual-ratio-affine-ransac-v1',
  };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Lokal ORB-liknande JavaScript-matcher' });
self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    const result = await match(id, payload.left, payload.right);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
