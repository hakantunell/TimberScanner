const VERSION = '20260728-36';
const ROI = Object.freeze({ x: 0.05, y: 0.10, width: 0.90, height: 0.80 });
const GRID = 4;

function cropImage(image) {
  const source = new Uint8Array(image.buffer);
  const x = Math.max(0, Math.floor(image.width * ROI.x));
  const y = Math.max(0, Math.floor(image.height * ROI.y));
  const width = Math.max(64, Math.floor(image.width * ROI.width));
  const height = Math.max(64, Math.floor(image.height * ROI.height));
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y + row) * image.width + x) * 4;
    rgba.set(source.subarray(sourceOffset, sourceOffset + width * 4), row * width * 4);
  }
  return {
    rgba,
    image: { width, height, buffer: rgba.buffer },
    offset: { x, y },
    rect: { x, y, width, height, sourceWidth: image.width, sourceHeight: image.height },
  };
}

function borderBackground(rgba, width, height) {
  let r = 0; let g = 0; let b = 0; let count = 0;
  const bandX = Math.max(2, Math.round(width * 0.06));
  const bandY = Math.max(2, Math.round(height * 0.08));
  for (let y = 0; y < height; y += GRID) {
    for (let x = 0; x < width; x += GRID) {
      if (x >= bandX && x < width - bandX && y >= bandY && y < height - bandY) continue;
      const i = (y * width + x) * 4;
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; count += 1;
    }
  }
  return { r: r / count, g: g / count, b: b / count };
}

function makeCoarseMask(rgba, width, height) {
  const cw = Math.ceil(width / GRID);
  const ch = Math.ceil(height / GRID);
  const score = new Float32Array(cw * ch);
  const bg = borderBackground(rgba, width, height);
  const samples = [];

  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      const x = Math.min(width - 2, cx * GRID + Math.floor(GRID / 2));
      const y = Math.min(height - 2, cy * GRID + Math.floor(GRID / 2));
      const i = (y * width + x) * 4;
      const dr = rgba[i] - bg.r;
      const dg = rgba[i + 1] - bg.g;
      const db = rgba[i + 2] - bg.b;
      const colorDistance = Math.sqrt(dr * dr + dg * dg + db * db);
      const ix = (y * width + Math.min(width - 1, x + 1)) * 4;
      const iy = (Math.min(height - 1, y + 1) * width + x) * 4;
      const gray = rgba[i] * .299 + rgba[i + 1] * .587 + rgba[i + 2] * .114;
      const grayX = rgba[ix] * .299 + rgba[ix + 1] * .587 + rgba[ix + 2] * .114;
      const grayY = rgba[iy] * .299 + rgba[iy + 1] * .587 + rgba[iy + 2] * .114;
      const texture = Math.abs(grayX - gray) + Math.abs(grayY - gray);
      const centerBias = 12 * (1 - Math.min(1, Math.abs(cx - cw / 2) / (cw / 2)));
      const value = colorDistance * .72 + texture * 1.25 + centerBias;
      score[cy * cw + cx] = value;
      samples.push(value);
    }
  }

  samples.sort((a, b) => a - b);
  const p58 = samples[Math.floor(samples.length * .58)] || 35;
  const threshold = Math.max(34, Math.min(82, p58 + 10));
  let mask = new Uint8Array(cw * ch);
  for (let i = 0; i < score.length; i += 1) mask[i] = score[i] >= threshold ? 1 : 0;

  const morph = (input, dilate) => {
    const output = new Uint8Array(input.length);
    for (let y = 1; y < ch - 1; y += 1) {
      for (let x = 1; x < cw - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += input[(y + dy) * cw + x + dx];
        }
        output[y * cw + x] = dilate ? (sum >= 2 ? 1 : 0) : (sum >= 6 ? 1 : 0);
      }
    }
    return output;
  };
  mask = morph(morph(mask, true), false);
  mask = morph(morph(mask, true), false);

  const visited = new Uint8Array(mask.length);
  let best = [];
  let bestScore = -Infinity;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start]; visited[start] = 1; const component = [];
    let centerDistance = 0;
    while (queue.length) {
      const current = queue.pop(); component.push(current);
      const x = current % cw; const y = Math.floor(current / cw);
      centerDistance += Math.abs(x - cw / 2) / cw + Math.abs(y - ch / 2) / ch;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
        const ni = ny * cw + nx;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
      }
    }
    const centrality = component.length ? centerDistance / component.length : 2;
    const candidateScore = component.length * (1.35 - Math.min(1, centrality));
    if (candidateScore > bestScore) { bestScore = candidateScore; best = component; }
  }

  const selected = new Uint8Array(mask.length);
  if (best.length >= Math.max(40, mask.length * .012)) {
    for (const index of best) selected[index] = 1;
  } else {
    for (let y = Math.floor(ch * .22); y < Math.ceil(ch * .78); y += 1) {
      for (let x = Math.floor(cw * .08); x < Math.ceil(cw * .92); x += 1) selected[y * cw + x] = 1;
    }
  }

  let minX = cw; let minY = ch; let maxX = 0; let maxY = 0; let count = 0;
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      if (!selected[y * cw + x]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count += 1;
    }
  }

  const contour = [];
  const stride = Math.max(1, Math.round(cw / 40));
  for (let x = minX; x <= maxX; x += stride) {
    let top = ch; let bottom = -1;
    for (let y = minY; y <= maxY; y += 1) {
      if (selected[y * cw + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    if (bottom >= top) contour.push({ x: x * GRID, top: top * GRID, bottom: Math.min(height - 1, (bottom + 1) * GRID) });
  }

  return {
    coarse: selected, cw, ch, bg,
    coverage: Math.round(count / selected.length * 100),
    bbox: { x: minX * GRID, y: minY * GRID, width: Math.min(width, (maxX + 1) * GRID) - minX * GRID, height: Math.min(height, (maxY + 1) * GRID) - minY * GRID },
    contour,
  };
}

function maskedImage(crop, segmentation) {
  const rgba = crop.rgba;
  const output = new Uint8Array(rgba.length);
  output.set(rgba);
  for (let y = 0; y < crop.image.height; y += 1) {
    const cy = Math.min(segmentation.ch - 1, Math.floor(y / GRID));
    for (let x = 0; x < crop.image.width; x += 1) {
      const cx = Math.min(segmentation.cw - 1, Math.floor(x / GRID));
      if (segmentation.coarse[cy * segmentation.cw + cx]) continue;
      const i = (y * crop.image.width + x) * 4;
      output[i] = segmentation.bg.r; output[i + 1] = segmentation.bg.g; output[i + 2] = segmentation.bg.b; output[i + 3] = 255;
    }
  }
  return { width: crop.image.width, height: crop.image.height, buffer: output.buffer };
}

function inside(segmentation, point) {
  const x = Math.floor(point.x / GRID); const y = Math.floor(point.y / GRID);
  return x >= 0 && x < segmentation.cw && y >= 0 && y < segmentation.ch && segmentation.coarse[y * segmentation.cw + x] === 1;
}

function translatePoint(point, offset) { return { x: point.x + offset.x, y: point.y + offset.y }; }

function translateResult(result, left, right, segA, segB) {
  const valid = (match) => inside(segA, match.a) && inside(segB, match.b);
  const translateMatch = (match) => ({ ...match, a: translatePoint(match.a, left.offset), b: translatePoint(match.b, right.offset) });
  const points = (result.points ?? []).filter(valid).map(translateMatch);
  const rawPoints = (result.rawPoints ?? []).filter(valid).map(translateMatch);
  return {
    ...result,
    points,
    rawPoints,
    matches: points.length,
    inlierRatio: rawPoints.length ? Math.round(points.length / rawPoints.length * 100) : 0,
    maskCoverageA: segA.coverage,
    maskCoverageB: segB.coverage,
    maskRectA: { ...segA.bbox, x: segA.bbox.x + left.offset.x, y: segA.bbox.y + left.offset.y, sourceWidth: left.rect.sourceWidth, sourceHeight: left.rect.sourceHeight },
    maskRectB: { ...segB.bbox, x: segB.bbox.x + right.offset.x, y: segB.bbox.y + right.offset.y, sourceWidth: right.rect.sourceWidth, sourceHeight: right.rect.sourceHeight },
    maskContourA: segA.contour.map((p) => ({ x: p.x + left.offset.x, top: p.top + left.offset.y, bottom: p.bottom + left.offset.y })),
    maskContourB: segB.contour.map((p) => ({ x: p.x + right.offset.x, top: p.top + right.offset.y, bottom: p.bottom + right.offset.y })),
    algorithm: `${result.algorithm ?? 'local-matcher'}-adaptive-stock-segmentation-v1`,
  };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Lokal matcher med adaptiv stocksegmentering' });
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  const left = cropImage(payload.left); const right = cropImage(payload.right);
  self.postMessage({ id, progress: 'segmenting' });
  const segA = makeCoarseMask(left.rgba, left.image.width, left.image.height);
  const segB = makeCoarseMask(right.rgba, right.image.width, right.image.height);
  self.postMessage({ id, progress: 'mask', coverageA: segA.coverage, coverageB: segB.coverage });
  const maskedA = maskedImage(left, segA); const maskedB = maskedImage(right, segB);
  const core = new Worker(new URL('./orb-worker-v29.js?v=20260728-36', self.location.href), { type: 'classic' });
  const finish = () => core.terminate();
  core.addEventListener('message', (coreEvent) => {
    const message = coreEvent.data ?? {};
    if (message.type === 'ready') return;
    if (message.id !== id) return;
    if (message.progress) { self.postMessage(message); return; }
    finish();
    if (message.ok) self.postMessage({ id, ok: true, result: translateResult(message.result, left, right, segA, segB) });
    else self.postMessage(message);
  });
  core.addEventListener('error', (error) => { finish(); self.postMessage({ id, ok: false, error: error.message || 'Matchningskärnan kraschade' }); });
  core.postMessage({ id, type: 'match', payload: { left: maskedA, right: maskedB } }, [maskedA.buffer, maskedB.buffer]);
});
