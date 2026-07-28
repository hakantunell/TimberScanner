const VERSION = '20260728-35';
const ROI = Object.freeze({ x: 0.08, y: 0.18, width: 0.84, height: 0.64 });

function cropImage(image) {
  const source = new Uint8Array(image.buffer);
  const x = Math.max(0, Math.floor(image.width * ROI.x));
  const y = Math.max(0, Math.floor(image.height * ROI.y));
  const width = Math.max(64, Math.floor(image.width * ROI.width));
  const height = Math.max(64, Math.floor(image.height * ROI.height));
  const cropped = new Uint8Array(width * height * 4);

  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * image.width + x) * 4;
    const targetOffset = row * width * 4;
    cropped.set(source.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }

  return {
    image: { width, height, buffer: cropped.buffer },
    offset: { x, y },
    rect: { x, y, width, height, sourceWidth: image.width, sourceHeight: image.height },
  };
}

function translatePoint(point, offset) {
  return { x: point.x + offset.x, y: point.y + offset.y };
}

function translateResult(result, left, right) {
  const translateMatch = (match) => ({
    ...match,
    a: translatePoint(match.a, left.offset),
    b: translatePoint(match.b, right.offset),
  });

  return {
    ...result,
    points: (result.points ?? []).map(translateMatch),
    rawPoints: (result.rawPoints ?? []).map(translateMatch),
    maskCoverageA: Math.round((left.rect.width * left.rect.height) / (left.rect.sourceWidth * left.rect.sourceHeight) * 100),
    maskCoverageB: Math.round((right.rect.width * right.rect.height) / (right.rect.sourceWidth * right.rect.sourceHeight) * 100),
    maskRectA: left.rect,
    maskRectB: right.rect,
    algorithm: `${result.algorithm ?? 'local-matcher'}-central-stock-roi-v1`,
  };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Lokal matcher med centralt stockområde' });

self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;

  const left = cropImage(payload.left);
  const right = cropImage(payload.right);
  self.postMessage({ id, progress: 'mask', coverage: Math.round(ROI.width * ROI.height * 100) });

  const core = new Worker(new URL('./orb-worker-v29.js?v=20260728-35', self.location.href), { type: 'classic' });
  const finish = () => core.terminate();

  core.addEventListener('message', (coreEvent) => {
    const message = coreEvent.data ?? {};
    if (message.type === 'ready') return;
    if (message.id !== id) return;
    if (message.progress) {
      self.postMessage(message);
      return;
    }
    finish();
    if (message.ok) {
      self.postMessage({ id, ok: true, result: translateResult(message.result, left, right) });
    } else {
      self.postMessage(message);
    }
  });

  core.addEventListener('error', (error) => {
    finish();
    self.postMessage({ id, ok: false, error: error.message || 'Matchningskärnan kraschade' });
  });

  core.postMessage({
    id,
    type: 'match',
    payload: { left: left.image, right: right.image },
  }, [left.image.buffer, right.image.buffer]);
});
