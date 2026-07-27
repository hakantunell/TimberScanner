const captures = document.querySelector('#captures');
const panel = document.querySelector('#sparse-reconstruction');
const canvas = document.querySelector('#sparse-point-cloud');
const status = document.querySelector('#sparse-status');
const detail = document.querySelector('#sparse-detail');

const MAX_WIDTH = 720;
const MAX_MATCHES = 300;
let lastSignature = '';
let running = false;

function waitForOpenCv(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const cv = window.cv;
      if (cv?.Mat && cv?.ORB && cv?.BFMatcher) {
        if (cv instanceof Promise) cv.then(resolve).catch(reject);
        else resolve(cv);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('OpenCV.js kunde inte laddas'));
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

function imageToCanvas(image) {
  const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.max(160, Math.round(image.naturalWidth * scale));
  work.height = Math.max(120, Math.round(image.naturalHeight * scale));
  work.getContext('2d').drawImage(image, 0, 0, work.width, work.height);
  return work;
}

function matFromPoints(cv, points) {
  const values = [];
  for (const point of points) values.push(point.x, point.y);
  return cv.matFromArray(points.length, 1, cv.CV_32FC2, values);
}

function keyPointAt(vector, index) {
  const point = vector.get(index);
  return { x: point.pt.x, y: point.pt.y };
}

function collectMatches(cv, descriptorsA, descriptorsB, keypointsA, keypointsB) {
  const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knn = new cv.DMatchVectorVector();
  matcher.knnMatch(descriptorsA, descriptorsB, knn, 2);
  const accepted = [];
  for (let i = 0; i < knn.size(); i += 1) {
    const pair = knn.get(i);
    if (pair.size() >= 2) {
      const first = pair.get(0);
      const second = pair.get(1);
      if (first.distance < second.distance * 0.72 && first.distance < 72) {
        accepted.push({
          a: keyPointAt(keypointsA, first.queryIdx),
          b: keyPointAt(keypointsB, first.trainIdx),
          distance: first.distance,
        });
      }
    }
    pair.delete();
  }
  knn.delete();
  matcher.delete();
  accepted.sort((left, right) => left.distance - right.distance);
  return accepted.slice(0, MAX_MATCHES);
}

function makeCameraMatrix(cv, width, height) {
  const focal = Math.max(width, height) * 1.08;
  return cv.matFromArray(3, 3, cv.CV_64F, [
    focal, 0, width / 2,
    0, focal, height / 2,
    0, 0, 1,
  ]);
}

function projectionMatrices(cv, camera, rotation, translation) {
  const identity = cv.Mat.eye(3, 3, cv.CV_64F);
  const zero = cv.Mat.zeros(3, 1, cv.CV_64F);
  const extrinsicA = new cv.Mat();
  const extrinsicB = new cv.Mat();
  cv.hconcat(identity, zero, extrinsicA);
  cv.hconcat(rotation, translation, extrinsicB);
  const projectionA = new cv.Mat();
  const projectionB = new cv.Mat();
  cv.gemm(camera, extrinsicA, 1, new cv.Mat(), 0, projectionA);
  cv.gemm(camera, extrinsicB, 1, new cv.Mat(), 0, projectionB);
  identity.delete();
  zero.delete();
  extrinsicA.delete();
  extrinsicB.delete();
  return { projectionA, projectionB };
}

function extractPoints(points4d, mask) {
  const points = [];
  const data = points4d.data64F?.length ? points4d.data64F : points4d.data32F;
  for (let column = 0; column < points4d.cols; column += 1) {
    if (mask?.rows && mask.ucharPtr(column, 0)[0] === 0) continue;
    const w = data[(3 * points4d.cols) + column];
    if (!Number.isFinite(w) || Math.abs(w) < 1e-8) continue;
    const x = data[column] / w;
    const y = data[points4d.cols + column] / w;
    const z = data[(2 * points4d.cols) + column] / w;
    if (!Number.isFinite(x + y + z) || z <= 0 || z > 100) continue;
    points.push({ x, y, z });
  }
  return points;
}

function project(point, yaw, pitch, width, height, scale, center) {
  const x = point.x - center.x;
  const y = point.y - center.y;
  const z = point.z - center.z;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  const y1 = y * cp - z1 * sp;
  return { x: width / 2 + x1 * scale, y: height / 2 - y1 * scale, depth: z1 };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function drawPointCloud(points, cameraTranslation) {
  const width = 760;
  const height = 430;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#0d1210';
  context.fillRect(0, 0, width, height);

  if (!points.length) return;
  const center = {
    x: median(points.map((point) => point.x)),
    y: median(points.map((point) => point.y)),
    z: median(points.map((point) => point.z)),
  };
  const spread = Math.max(
    0.1,
    ...points.map((point) => Math.hypot(point.x - center.x, point.y - center.y, (point.z - center.z) * 0.35)),
  );
  const scale = Math.min(width, height) * 0.38 / spread;
  const projected = points
    .map((point) => ({ point, screen: project(point, -0.55, 0.28, width, height, scale, center) }))
    .sort((a, b) => a.screen.depth - b.screen.depth);

  for (const item of projected) {
    context.fillStyle = 'rgba(90,225,145,.82)';
    context.beginPath();
    context.arc(item.screen.x, item.screen.y, 2.2, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = '#f4d35e';
  context.beginPath();
  context.arc(width / 2, height - 32, 6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#f08a5d';
  context.beginPath();
  context.arc(width / 2 + cameraTranslation.x * 45, height - 32 - cameraTranslation.y * 45, 6, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = 'rgba(255,255,255,.86)';
  context.font = '14px system-ui, sans-serif';
  context.fillText('OpenCV: ORB · RANSAC · recoverPose · triangulering', 16, 24);
  context.fillText('Gul/orange = relativa kamerapositioner', 16, 45);
}

function classify({ matches, inliers, points, translation }) {
  const baseline = Math.hypot(translation.x, translation.y, translation.z);
  const inlierRatio = inliers / Math.max(1, matches);
  if (points >= 45 && inlierRatio >= 0.55) {
    return ['Stabil OpenCV-rekonstruktion', `${points} 3D-punkter · ${inliers}/${matches} RANSAC-inliers · relativ baslinje ${baseline.toFixed(2)}`];
  }
  if (points >= 15 && inlierRatio >= 0.3) {
    return ['Användbar men ännu gles rekonstruktion', `${points} 3D-punkter · ${Math.round(inlierRatio * 100)} % geometriskt konsekventa matchningar`];
  }
  return ['Svag geometrisk rekonstruktion', `${points} 3D-punkter · flytta telefonen jämnare i sidled och behåll mer överlappning`];
}

async function reconstructLatestPair() {
  if (running || !captures || !panel) return;
  const images = [...captures.querySelectorAll('img')];
  if (images.length < 2) return;
  const [latest, previous] = images;
  if (!latest.complete || !previous.complete || !latest.naturalWidth || !previous.naturalWidth) return;
  const signature = `${latest.src}|${previous.src}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  running = true;
  panel.hidden = false;
  status.textContent = 'Laddar OpenCV och beräknar kamerageometri…';
  detail.textContent = 'ORB, Hamming-matchning och RANSAC';

  let resources = [];
  try {
    const cv = await waitForOpenCv();
    const canvasA = imageToCanvas(previous);
    const canvasB = imageToCanvas(latest);
    const rgbaA = cv.imread(canvasA);
    const rgbaB = cv.imread(canvasB);
    const grayA = new cv.Mat();
    const grayB = new cv.Mat();
    cv.cvtColor(rgbaA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(rgbaB, grayB, cv.COLOR_RGBA2GRAY);
    const keypointsA = new cv.KeyPointVector();
    const keypointsB = new cv.KeyPointVector();
    const descriptorsA = new cv.Mat();
    const descriptorsB = new cv.Mat();
    const orb = new cv.ORB(1200);
    const emptyMask = new cv.Mat();
    orb.detectAndCompute(grayA, emptyMask, keypointsA, descriptorsA);
    orb.detectAndCompute(grayB, emptyMask, keypointsB, descriptorsB);
    resources = [rgbaA, rgbaB, grayA, grayB, keypointsA, keypointsB, descriptorsA, descriptorsB, orb, emptyMask];

    if (descriptorsA.empty() || descriptorsB.empty()) throw new Error('För få ORB-detaljer i bilderna');
    const matches = collectMatches(cv, descriptorsA, descriptorsB, keypointsA, keypointsB);
    if (matches.length < 8) throw new Error(`Bara ${matches.length} säkra ORB-matchningar`);

    const pointsA = matFromPoints(cv, matches.map((match) => match.a));
    const pointsB = matFromPoints(cv, matches.map((match) => match.b));
    const camera = makeCameraMatrix(cv, grayA.cols, grayA.rows);
    const essentialMask = new cv.Mat();
    const essential = cv.findEssentialMat(pointsA, pointsB, camera, cv.RANSAC, 0.999, 1.2, essentialMask);
    const rotation = new cv.Mat();
    const translation = new cv.Mat();
    const poseMask = essentialMask.clone();
    const inliers = cv.recoverPose(essential, pointsA, pointsB, camera, rotation, translation, poseMask);
    const { projectionA, projectionB } = projectionMatrices(cv, camera, rotation, translation);
    const points4d = new cv.Mat();
    cv.triangulatePoints(projectionA, projectionB, pointsA, pointsB, points4d);
    resources.push(pointsA, pointsB, camera, essentialMask, essential, rotation, translation, poseMask, projectionA, projectionB, points4d);

    const points = extractPoints(points4d, poseMask);
    const cameraTranslation = {
      x: translation.doubleAt(0, 0),
      y: translation.doubleAt(1, 0),
      z: translation.doubleAt(2, 0),
    };
    drawPointCloud(points, cameraTranslation);
    const [headline, description] = classify({ matches: matches.length, inliers, points: points.length, translation: cameraTranslation });
    status.textContent = headline;
    detail.textContent = description;
  } catch (error) {
    status.textContent = 'OpenCV-rekonstruktionen kunde inte slutföras';
    detail.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  } finally {
    for (const resource of resources.reverse()) {
      try { resource?.delete?.(); } catch { /* OpenCV cleanup best effort */ }
    }
    running = false;
  }
}

if (captures && panel) {
  new MutationObserver(reconstructLatestPair).observe(captures, { childList: true, subtree: true });
  window.setInterval(reconstructLatestPair, 1800);
}
