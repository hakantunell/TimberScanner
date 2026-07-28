function toGray(image) {
  const rgba = new Uint8Array(image.buffer);
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round((rgba[offset] * 0.299) + (rgba[offset + 1] * 0.587) + (rgba[offset + 2] * 0.114));
  }
  return gray;
}

function detectCorners(gray, width, height, limit = 220) {
  const candidates = [];
  const margin = 8;
  for (let y = margin; y < height - margin; y += 3) {
    for (let x = margin; x < width - margin; x += 3) {
      const index = (y * width) + x;
      const gx = Math.abs(gray[index + 1] - gray[index - 1]);
      const gy = Math.abs(gray[index + width] - gray[index - width]);
      const diagonal = Math.abs(gray[index + width + 1] - gray[index - width - 1]);
      const score = gx + gy + Math.round(diagonal * 0.5);
      if (score >= 42) candidates.push({ x, y, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);

  const selected = [];
  const minDistanceSquared = 9 * 9;
  for (const candidate of candidates) {
    if (selected.every((point) => {
      const dx = point.x - candidate.x;
      const dy = point.y - candidate.y;
      return (dx * dx) + (dy * dy) >= minDistanceSquared;
    })) {
      selected.push(candidate);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function patchDistance(grayA, widthA, pointA, grayB, widthB, pointB, radius = 3) {
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

function matchFeatures(left, right) {
  const grayA = toGray(left);
  const grayB = toGray(right);
  const pointsA = detectCorners(grayA, left.width, left.height);
  const pointsB = detectCorners(grayB, right.width, right.height);
  const accepted = [];
  const maxShiftX = Math.round(Math.max(left.width, right.width) * 0.28);
  const maxShiftY = Math.round(Math.max(left.height, right.height) * 0.18);

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
    if (best && second && best.distance < 32 && best.distance < second.distance * 0.82) {
      accepted.push({
        a: { x: pointA.x, y: pointA.y },
        b: { x: best.point.x, y: best.point.y },
        distance: Math.round(best.distance * 10) / 10,
      });
    }
  }

  accepted.sort((leftMatch, rightMatch) => leftMatch.distance - rightMatch.distance);
  return {
    keypointsA: pointsA.length,
    keypointsB: pointsB.length,
    matches: accepted.length,
    points: accepted.slice(0, 100),
    algorithm: 'gradient-corners-patch-sad-v1',
  };
}

self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    const result = matchFeatures(payload.left, payload.right);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});