const VERSION = '20260728-21';
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
let cvPromise = null;

function progress(id, stage, extra = {}) {
  self.postMessage({ id, progress: stage, ...extra });
}

function loadOpenCv(id) {
  if (cvPromise) return cvPromise;

  cvPromise = new Promise((resolve, reject) => {
    progress(id, 'opencv-loading');
    try {
      importScripts(OPENCV_URL);
    } catch (error) {
      reject(new Error(`OpenCV kunde inte laddas från jsDelivr: ${error.message}`));
      return;
    }

    const started = Date.now();
    const finish = (candidate) => {
      if (candidate?.Mat && candidate?.ORB && candidate?.BFMatcher) {
        self.cv = candidate;
        progress(id, 'opencv-ready');
        resolve(candidate);
        return true;
      }
      return false;
    };

    const poll = () => {
      const candidate = self.cv;
      if (candidate && typeof candidate.then === 'function') {
        candidate.then((resolved) => {
          if (!finish(resolved)) reject(new Error('OpenCV saknar ORB eller BFMatcher'));
        }).catch(reject);
        return;
      }
      if (finish(candidate)) return;
      if (Date.now() - started > 45000) {
        reject(new Error('OpenCV initierades inte i workern inom 45 sekunder'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  }).catch((error) => {
    cvPromise = null;
    throw error;
  });

  return cvPromise;
}

function matFromImage(cv, image) {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(new Uint8Array(image.buffer));
  return mat;
}

function buildStockMask(cv, image) {
  const rgba = new Uint8Array(image.buffer);
  const { width, height } = image;
  const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
  const output = mask.data;

  const samples = [];
  const borderX = Math.max(4, Math.round(width * 0.08));
  const borderY = Math.max(4, Math.round(height * 0.08));
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (x > borderX && x < width - borderX && y > borderY && y < height - borderY) continue;
      const offset = ((y * width) + x) * 4;
      samples.push([rgba[offset], rgba[offset + 1], rgba[offset + 2]]);
    }
  }

  const median = (channel) => {
    const values = samples.map((sample) => sample[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? 0;
  };
  const background = [median(0), median(1), median(2)];

  const xMin = Math.round(width * 0.08);
  const xMax = Math.round(width * 0.92);
  const yMin = Math.round(height * 0.12);
  const yMax = Math.round(height * 0.88);
  let selected = 0;

  for (let y = yMin; y < yMax; y += 1) {
    for (let x = xMin; x < xMax; x += 1) {
      const index = (y * width) + x;
      const offset = index * 4;
      const dr = rgba[offset] - background[0];
      const dg = rgba[offset + 1] - background[1];
      const db = rgba[offset + 2] - background[2];
      const colourDistance = Math.hypot(dr, dg, db);
      const centreBand = y >= height * 0.3 && y <= height * 0.72;
      if (colourDistance >= 28 || centreBand) {
        output[index] = 255;
        selected += 1;
      }
    }
  }

  return { mask, coverage: Math.round((selected / (width * height)) * 100) };
}

function keypoint(vector, index) {
  const item = vector.get(index);
  return { x: item.pt.x, y: item.pt.y };
}

function ratioMatches(knn, ratio = 0.72, maximumDistance = 68) {
  const result = [];
  for (let index = 0; index < knn.size(); index += 1) {
    const pair = knn.get(index);
    try {
      if (pair.size() < 2) continue;
      const best = pair.get(0);
      const second = pair.get(1);
      if (best.distance < second.distance * ratio && best.distance <= maximumDistance) {
        result.push({ queryIdx: best.queryIdx, trainIdx: best.trainIdx, distance: best.distance });
      }
    } finally {
      pair.delete();
    }
  }
  return result;
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
  const selected = [];
  const used = new Set();
  while (selected.length < 3) {
    const index = Math.floor(Math.random() * matches.length);
    if (used.has(index)) continue;
    used.add(index);
    selected.push(matches[index]);
  }
  return selected;
}

function affineRansac(matches, iterations = 350, threshold = 4) {
  if (matches.length < 3) return { inliers: [], model: null, ratio: 0, meanError: 0 };
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

async function matchFeatures(id, left, right) {
  const cv = await loadOpenCv(id);
  progress(id, 'mask');

  const rgbaA = matFromImage(cv, left);
  const rgbaB = matFromImage(cv, right);
  const grayA = new cv.Mat();
  const grayB = new cv.Mat();
  const maskA = buildStockMask(cv, left);
  const maskB = buildStockMask(cv, right);
  const keyA = new cv.KeyPointVector();
  const keyB = new cv.KeyPointVector();
  const descA = new cv.Mat();
  const descB = new cv.Mat();
  const orb = new cv.ORB(1200);
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const forwardKnn = new cv.DMatchVectorVector();
  const reverseKnn = new cv.DMatchVectorVector();
  const resources = [rgbaA, rgbaB, grayA, grayB, maskA.mask, maskB.mask, keyA, keyB, descA, descB, orb, matcher, forwardKnn, reverseKnn];

  try {
    cv.cvtColor(rgbaA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(rgbaB, grayB, cv.COLOR_RGBA2GRAY);
    progress(id, 'orb');
    orb.detectAndCompute(grayA, maskA.mask, keyA, descA);
    orb.detectAndCompute(grayB, maskB.mask, keyB, descB);
    if (descA.empty() || descB.empty()) throw new Error('För få ORB-detaljer i stockmasken');

    progress(id, 'matching', { keypointsA: keyA.size(), keypointsB: keyB.size() });
    matcher.knnMatch(descA, descB, forwardKnn, 2);
    matcher.knnMatch(descB, descA, reverseKnn, 2);
    const forward = ratioMatches(forwardKnn);
    const reverse = ratioMatches(reverseKnn);
    const reversePairs = new Set(reverse.map((match) => `${match.trainIdx}:${match.queryIdx}`));
    const mutual = forward.filter((match) => reversePairs.has(`${match.queryIdx}:${match.trainIdx}`));
    const points = mutual.map((match) => ({
      a: keypoint(keyA, match.queryIdx),
      b: keypoint(keyB, match.trainIdx),
      distance: Math.round(match.distance * 10) / 10,
    }));

    progress(id, 'ransac', { rawMatches: points.length });
    const filtered = affineRansac(points);
    return {
      keypointsA: keyA.size(),
      keypointsB: keyB.size(),
      ratioMatches: forward.length,
      rawMatches: points.length,
      matches: filtered.inliers.length,
      inlierRatio: Math.round(filtered.ratio * 100),
      meanError: filtered.meanError,
      motion: filtered.model,
      maskCoverageA: maskA.coverage,
      maskCoverageB: maskB.coverage,
      points: filtered.inliers.slice(0, 120),
      rawPoints: points.slice(0, 120),
      algorithm: 'opencv-orb-jsdelivr-mutual-ratio-affine-ransac-v2',
    };
  } finally {
    for (const resource of resources.reverse()) {
      try { resource.delete(); } catch { /* best effort */ }
    }
  }
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'OpenCV ORB via jsDelivr' });
self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    const result = await matchFeatures(id, payload.left, payload.right);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});