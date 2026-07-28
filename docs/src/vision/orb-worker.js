let cvReadyPromise = null;

function ensureOpenCv() {
  if (cvReadyPromise) return cvReadyPromise;
  cvReadyPromise = new Promise((resolve, reject) => {
    try {
      importScripts('https://docs.opencv.org/4.x/opencv.js');
    } catch (error) {
      reject(new Error(`OpenCV kunde inte laddas i worker: ${error.message}`));
      return;
    }

    const started = Date.now();
    const poll = () => {
      const candidate = self.cv;
      if (candidate?.Mat && candidate?.ORB && candidate?.BFMatcher) {
        resolve(candidate);
        return;
      }
      if (candidate instanceof Promise) {
        candidate.then(resolve).catch(reject);
        return;
      }
      if (Date.now() - started > 30000) {
        reject(new Error('OpenCV initierades inte i worker'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
  return cvReadyPromise;
}

function point(vector, index) {
  const item = vector.get(index);
  return { x: item.pt.x, y: item.pt.y };
}

function matFromImageData(cv, image) {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(new Uint8Array(image.buffer));
  return mat;
}

async function matchPair(payload) {
  const cv = await ensureOpenCv();
  const rgbaA = matFromImageData(cv, payload.left);
  const rgbaB = matFromImageData(cv, payload.right);
  const grayA = new cv.Mat();
  const grayB = new cv.Mat();
  const keyA = new cv.KeyPointVector();
  const keyB = new cv.KeyPointVector();
  const descA = new cv.Mat();
  const descB = new cv.Mat();
  const mask = new cv.Mat();
  const orb = new cv.ORB(700);
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
      try {
        if (pair.size() >= 2) {
          const best = pair.get(0);
          const second = pair.get(1);
          if (best.distance < second.distance * 0.72 && best.distance < 72) {
            accepted.push({
              a: point(keyA, best.queryIdx),
              b: point(keyB, best.trainIdx),
              distance: best.distance,
            });
          }
        }
      } finally {
        pair.delete();
      }
    }
    accepted.sort((left, right) => left.distance - right.distance);
    return {
      keypointsA: keyA.size(),
      keypointsB: keyB.size(),
      matches: accepted.length,
      points: accepted.slice(0, 100),
    };
  } finally {
    for (const resource of resources.reverse()) {
      try { resource.delete(); } catch { /* best effort */ }
    }
  }
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    const result = await matchPair(payload);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
