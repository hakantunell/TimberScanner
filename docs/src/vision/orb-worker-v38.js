const VERSION = '20260728-38';

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function estimateCorrection(image, background) {
  const current = new Uint8Array(image.buffer);
  const reference = new Uint8Array(background.buffer);
  const width = Math.min(image.width, background.width);
  const height = Math.min(image.height, background.height);
  const dr = [];
  const dg = [];
  const db = [];
  const step = 6;

  for (let y = 0; y < height; y += step) {
    const cy = Math.min(image.height - 1, Math.round(y * (image.height - 1) / Math.max(1, height - 1)));
    const by = Math.min(background.height - 1, Math.round(y * (background.height - 1) / Math.max(1, height - 1)));
    for (let x = 0; x < width; x += step) {
      const cx = Math.min(image.width - 1, Math.round(x * (image.width - 1) / Math.max(1, width - 1)));
      const bx = Math.min(background.width - 1, Math.round(x * (background.width - 1) / Math.max(1, width - 1)));
      const ci = (cy * image.width + cx) * 4;
      const bi = (by * background.width + bx) * 4;
      dr.push(current[ci] - reference[bi]);
      dg.push(current[ci + 1] - reference[bi + 1]);
      db.push(current[ci + 2] - reference[bi + 2]);
    }
  }

  return {
    r: Math.max(-45, Math.min(45, median(dr))),
    g: Math.max(-45, Math.min(45, median(dg))),
    b: Math.max(-45, Math.min(45, median(db))),
  };
}

function correctedImage(image, correction) {
  const source = new Uint8Array(image.buffer);
  const output = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 4) {
    output[i] = clamp(source[i] - correction.r);
    output[i + 1] = clamp(source[i + 1] - correction.g);
    output[i + 2] = clamp(source[i + 2] - correction.b);
    output[i + 3] = 255;
  }
  return { width: image.width, height: image.height, buffer: output.buffer };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Exponeringsnormaliserad bakgrundssubtraktion' });

self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  if (!payload?.background) {
    self.postMessage({ id, ok: false, error: 'Bakgrunden är inte kalibrerad' });
    return;
  }

  const leftCorrection = estimateCorrection(payload.left, payload.background);
  const rightCorrection = estimateCorrection(payload.right, payload.background);
  self.postMessage({
    id,
    progress: 'exposure-normalization',
    leftCorrection,
    rightCorrection,
  });

  const left = correctedImage(payload.left, leftCorrection);
  const right = correctedImage(payload.right, rightCorrection);
  const backgroundCopy = new Uint8Array(payload.background.buffer.slice(0));
  const background = {
    width: payload.background.width,
    height: payload.background.height,
    buffer: backgroundCopy.buffer,
  };

  const core = new Worker(new URL('./orb-worker-v37.js?v=20260728-38', self.location.href), { type: 'classic' });
  const finish = () => core.terminate();

  core.onmessage = (coreEvent) => {
    const message = coreEvent.data ?? {};
    if (message.type === 'ready' || message.id !== id) return;
    if (message.progress) {
      self.postMessage(message);
      return;
    }
    finish();
    if (message.ok) {
      self.postMessage({
        id,
        ok: true,
        result: {
          ...message.result,
          exposureCorrectionA: leftCorrection,
          exposureCorrectionB: rightCorrection,
          algorithm: `${message.result?.algorithm ?? 'background'}-exposure-normalized-v1`,
        },
      });
    } else {
      self.postMessage(message);
    }
  };

  core.onerror = (error) => {
    finish();
    self.postMessage({ id, ok: false, error: error.message || 'Bakgrundsworkern kraschade' });
  };

  core.postMessage({
    id,
    type: 'match',
    payload: { left, right, background },
  }, [left.buffer, right.buffer, background.buffer]);
});
