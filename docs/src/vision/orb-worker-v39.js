const VERSION = '20260728-39';
const GRID = 4;
const ROI = Object.freeze({ x: 0.03, y: 0.12, width: 0.94, height: 0.72 });

function crop(image) {
  const src = new Uint8Array(image.buffer);
  const x0 = Math.floor(image.width * ROI.x);
  const y0 = Math.floor(image.height * ROI.y);
  const width = Math.max(96, Math.floor(image.width * ROI.width));
  const height = Math.max(72, Math.floor(image.height * ROI.height));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    rgba.set(src.subarray(from, from + width * 4), y * width * 4);
  }
  return { rgba, width, height, offset: { x: x0, y: y0 }, sourceWidth: image.width, sourceHeight: image.height };
}

function grayAt(rgba, width, x, y) {
  const i = (y * width + x) * 4;
  return rgba[i] * .299 + rgba[i + 1] * .587 + rgba[i + 2] * .114;
}

function morph(input, width, height, dilate, rounds = 1) {
  let current = input;
  for (let r = 0; r < rounds; r += 1) {
    const out = new Uint8Array(current.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += current[(y + dy) * width + x + dx];
        }
        out[y * width + x] = dilate ? (sum >= 2 ? 1 : 0) : (sum >= 6 ? 1 : 0);
      }
    }
    current = out;
  }
  return current;
}

function detectLog(image) {
  const cw = Math.ceil(image.width / GRID);
  const ch = Math.ceil(image.height / GRID);
  const response = new Float32Array(cw * ch);
  const values = [];

  for (let cy = 1; cy < ch - 1; cy += 1) {
    for (let cx = 1; cx < cw - 1; cx += 1) {
      const x = Math.min(image.width - 2, cx * GRID + 2);
      const y = Math.min(image.height - 2, cy * GRID + 2);
      let texture = 0;
      let horizontalEdges = 0;
      let verticalEdges = 0;
      for (let oy = -2; oy <= 2; oy += 2) {
        for (let ox = -2; ox <= 2; ox += 2) {
          const px = Math.max(1, Math.min(image.width - 2, x + ox));
          const py = Math.max(1, Math.min(image.height - 2, y + oy));
          const gx = grayAt(image.rgba, image.width, px + 1, py) - grayAt(image.rgba, image.width, px - 1, py);
          const gy = grayAt(image.rgba, image.width, px, py + 1) - grayAt(image.rgba, image.width, px, py - 1);
          texture += Math.abs(gx) + Math.abs(gy);
          horizontalEdges += Math.abs(gy);
          verticalEdges += Math.abs(gx);
        }
      }
      const centerY = 1 - Math.min(1, Math.abs(cy - ch * .56) / (ch * .56));
      const score = texture / 9 + horizontalEdges * .12 + centerY * 18 - verticalEdges * .015;
      response[cy * cw + cx] = score;
      values.push(score);
    }
  }

  values.sort((a, b) => a - b);
  const threshold = Math.max(34, values[Math.floor(values.length * .68)] || 34);
  let mask = new Uint8Array(cw * ch);
  for (let i = 0; i < response.length; i += 1) mask[i] = response[i] >= threshold ? 1 : 0;
  mask = morph(mask, cw, ch, true, 3);
  mask = morph(mask, cw, ch, false, 2);
  mask = morph(mask, cw, ch, true, 2);

  const visited = new Uint8Array(mask.length);
  let winner = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const pixels = [];
    let minX = cw, maxX = 0, minY = ch, maxY = 0;
    while (stack.length) {
      const index = stack.pop();
      pixels.push(index);
      const x = index % cw;
      const y = Math.floor(index / cw);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
        const ni = ny * cw + nx;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const aspect = width / Math.max(1, height);
    const fill = pixels.length / Math.max(1, width * height);
    const centerY = (minY + maxY) / 2;
    const verticalDistance = Math.abs(centerY - ch * .56) / ch;
    const spansCenter = minY <= ch * .62 && maxY >= ch * .42;
    const widthRatio = width / cw;
    const heightRatio = height / ch;

    if (widthRatio < .28 || aspect < 1.8 || heightRatio > .62 || !spansCenter) continue;
    const score = pixels.length * (1 + Math.min(3, aspect) * .8) * (1 + widthRatio * 2) * (0.8 + fill) * (1.2 - Math.min(.8, verticalDistance * 2));
    if (!winner || score > winner.score) winner = { pixels, minX, maxX, minY, maxY, score, aspect, fill };
  }

  if (!winner) throw new Error('Ingen tydlig horisontell stock eller pinne hittades i mitten av bilden');

  let selected = new Uint8Array(mask.length);
  for (const index of winner.pixels) selected[index] = 1;
  selected = morph(selected, cw, ch, true, 2);
  selected = morph(selected, cw, ch, false, 1);

  const contour = [];
  const stride = Math.max(1, Math.round(cw / 48));
  let count = 0;
  for (const value of selected) count += value;
  for (let x = winner.minX; x <= winner.maxX; x += stride) {
    let top = ch, bottom = -1;
    for (let y = 0; y < ch; y += 1) {
      if (selected[y * cw + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    if (bottom >= top) contour.push({ x: x * GRID, top: top * GRID, bottom: Math.min(image.height - 1, (bottom + 1) * GRID) });
  }

  return {
    mask: selected, cw, ch, contour,
    coverage: Math.round(count / selected.length * 100),
    bbox: { x: winner.minX * GRID, y: winner.minY * GRID, width: (winner.maxX - winner.minX + 1) * GRID, height: (winner.maxY - winner.minY + 1) * GRID },
    aspect: Math.round(winner.aspect * 10) / 10,
  };
}

function maskedImage(image, segmentation) {
  const out = new Uint8Array(image.rgba.length);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < image.height; y += 8) for (let x = 0; x < image.width; x += 8) {
    const i = (y * image.width + x) * 4; r += image.rgba[i]; g += image.rgba[i + 1]; b += image.rgba[i + 2]; n += 1;
  }
  r /= n; g /= n; b /= n;
  for (let y = 0; y < image.height; y += 1) {
    const cy = Math.min(segmentation.ch - 1, Math.floor(y / GRID));
    for (let x = 0; x < image.width; x += 1) {
      const cx = Math.min(segmentation.cw - 1, Math.floor(x / GRID));
      const i = (y * image.width + x) * 4;
      if (segmentation.mask[cy * segmentation.cw + cx]) {
        out[i] = image.rgba[i]; out[i + 1] = image.rgba[i + 1]; out[i + 2] = image.rgba[i + 2];
      } else {
        out[i] = r; out[i + 1] = g; out[i + 2] = b;
      }
      out[i + 3] = 255;
    }
  }
  return { width: image.width, height: image.height, buffer: out.buffer };
}

function inside(seg, point) {
  const x = Math.floor(point.x / GRID), y = Math.floor(point.y / GRID);
  return x >= 0 && x < seg.cw && y >= 0 && y < seg.ch && seg.mask[y * seg.cw + x] === 1;
}

function translateResult(result, left, right, segA, segB) {
  const valid = (m) => inside(segA, m.a) && inside(segB, m.b);
  const shift = (m) => ({ ...m, a: { x: m.a.x + left.offset.x, y: m.a.y + left.offset.y }, b: { x: m.b.x + right.offset.x, y: m.b.y + right.offset.y } });
  const points = (result.points ?? []).filter(valid).map(shift);
  const rawPoints = (result.rawPoints ?? []).filter(valid).map(shift);
  return {
    ...result, points, rawPoints, matches: points.length,
    inlierRatio: rawPoints.length ? Math.round(points.length / rawPoints.length * 100) : 0,
    maskCoverageA: segA.coverage, maskCoverageB: segB.coverage,
    detectorAspectA: segA.aspect, detectorAspectB: segB.aspect,
    maskContourA: segA.contour.map(p => ({ x: p.x + left.offset.x, top: p.top + left.offset.y, bottom: p.bottom + left.offset.y })),
    maskContourB: segB.contour.map(p => ({ x: p.x + right.offset.x, top: p.top + right.offset.y, bottom: p.bottom + right.offset.y })),
    maskRectA: { ...segA.bbox, x: segA.bbox.x + left.offset.x, y: segA.bbox.y + left.offset.y, sourceWidth: left.sourceWidth, sourceHeight: left.sourceHeight },
    maskRectB: { ...segB.bbox, x: segB.bbox.x + right.offset.x, y: segB.bbox.y + right.offset.y, sourceWidth: right.sourceWidth, sourceHeight: right.sourceHeight },
    algorithm: `${result.algorithm ?? 'local-matcher'}-horizontal-log-detector-v1`,
  };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Formbaserad horisontell stockdetektor' });
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  try {
    const left = crop(payload.left), right = crop(payload.right);
    self.postMessage({ id, progress: 'detecting-log' });
    const segA = detectLog(left), segB = detectLog(right);
    self.postMessage({ id, progress: 'mask', coverageA: segA.coverage, coverageB: segB.coverage, aspectA: segA.aspect, aspectB: segB.aspect });
    const maskedA = maskedImage(left, segA), maskedB = maskedImage(right, segB);
    const core = new Worker(new URL('./orb-worker-v29.js?v=20260728-39', self.location.href), { type: 'classic' });
    const finish = () => core.terminate();
    core.onmessage = (coreEvent) => {
      const message = coreEvent.data ?? {};
      if (message.type === 'ready' || message.id !== id) return;
      if (message.progress) { self.postMessage(message); return; }
      finish();
      if (message.ok) self.postMessage({ id, ok: true, result: translateResult(message.result, left, right, segA, segB) });
      else self.postMessage(message);
    };
    core.onerror = (error) => { finish(); self.postMessage({ id, ok: false, error: error.message || 'Matchningskärnan kraschade' }); };
    core.postMessage({ id, type: 'match', payload: { left: maskedA, right: maskedB } }, [maskedA.buffer, maskedB.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});