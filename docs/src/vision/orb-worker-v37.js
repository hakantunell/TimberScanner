const VERSION = '20260728-37';
const ROI = Object.freeze({ x: 0.04, y: 0.08, width: 0.92, height: 0.84 });
const GRID = 4;

function crop(image) {
  const source = new Uint8Array(image.buffer);
  const x = Math.floor(image.width * ROI.x);
  const y = Math.floor(image.height * ROI.y);
  const width = Math.max(64, Math.floor(image.width * ROI.width));
  const height = Math.max(64, Math.floor(image.height * ROI.height));
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    rgba.set(source.subarray(from, from + width * 4), row * width * 4);
  }
  return { rgba, width, height, offset: { x, y }, sourceWidth: image.width, sourceHeight: image.height };
}

function resizeBackground(background, width, height) {
  const source = new Uint8Array(background.buffer);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(background.height - 1, Math.round(y * (background.height - 1) / Math.max(1, height - 1)));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(background.width - 1, Math.round(x * (background.width - 1) / Math.max(1, width - 1)));
      const si = (sy * background.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = source[si]; out[di + 1] = source[si + 1]; out[di + 2] = source[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

function morph(input, width, height, dilate, rounds = 1) {
  let current = input;
  for (let round = 0; round < rounds; round += 1) {
    const output = new Uint8Array(current.length);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += current[(y + dy) * width + x + dx];
        output[y * width + x] = dilate ? (sum >= 2 ? 1 : 0) : (sum >= 6 ? 1 : 0);
      }
    }
    current = output;
  }
  return current;
}

function segment(current, background) {
  const cw = Math.ceil(current.width / GRID);
  const ch = Math.ceil(current.height / GRID);
  const bg = resizeBackground(background, current.width, current.height);
  const mask = new Uint8Array(cw * ch);

  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      const x = Math.min(current.width - 1, cx * GRID + 2);
      const y = Math.min(current.height - 1, cy * GRID + 2);
      const i = (y * current.width + x) * 4;
      const cr = current.rgba[i], cg = current.rgba[i + 1], cb = current.rgba[i + 2];
      const br = bg[i], bgc = bg[i + 1], bb = bg[i + 2];
      const lumC = cr * .299 + cg * .587 + cb * .114;
      const lumB = br * .299 + bgc * .587 + bb * .114;
      const chroma = Math.abs((cr - cg) - (br - bgc)) + Math.abs((cb - cg) - (bb - bgc));
      const color = Math.hypot(cr - br, cg - bgc, cb - bb);
      const darkerOnly = lumC < lumB - 12 && chroma < 16 && color < 55;
      const changed = color > 38 || chroma > 24 || Math.abs(lumC - lumB) > 32;
      mask[cy * cw + cx] = changed && !darkerOnly ? 1 : 0;
    }
  }

  let cleaned = morph(mask, cw, ch, true, 2);
  cleaned = morph(cleaned, cw, ch, false, 1);
  cleaned = morph(cleaned, cw, ch, true, 1);

  const visited = new Uint8Array(cleaned.length);
  let best = [];
  let bestScore = -Infinity;
  for (let start = 0; start < cleaned.length; start += 1) {
    if (!cleaned[start] || visited[start]) continue;
    const queue = [start]; visited[start] = 1; const component = [];
    let minX = cw, maxX = 0, minY = ch, maxY = 0;
    while (queue.length) {
      const index = queue.pop(); component.push(index);
      const x = index % cw, y = Math.floor(index / cw);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
        const ni = ny * cw + nx;
        if (cleaned[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
      }
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const centrality = 1 - Math.min(1, Math.hypot((centerX - cw / 2) / cw, (centerY - ch / 2) / ch) * 1.8);
    const elongation = Math.max(width / Math.max(1, height), height / Math.max(1, width));
    const score = component.length * (0.8 + centrality * 0.8) * Math.min(2.2, 0.8 + elongation * 0.25);
    if (score > bestScore) { bestScore = score; best = component; }
  }

  const selected = new Uint8Array(cleaned.length);
  for (const index of best) selected[index] = 1;
  selected.set(morph(selected, cw, ch, true, 2));
  const filled = morph(selected, cw, ch, false, 1);

  let count = 0, minX = cw, minY = ch, maxX = 0, maxY = 0;
  for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) if (filled[y * cw + x]) {
    count += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }

  const contour = [];
  const stride = Math.max(1, Math.round(cw / 45));
  for (let x = minX; x <= maxX; x += stride) {
    let top = ch, bottom = -1;
    for (let y = minY; y <= maxY; y += 1) if (filled[y * cw + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    if (bottom >= top) contour.push({ x: x * GRID, top: top * GRID, bottom: Math.min(current.height - 1, (bottom + 1) * GRID) });
  }

  return { mask: filled, cw, ch, bg, coverage: Math.round(count / filled.length * 100), contour,
    bbox: { x: minX * GRID, y: minY * GRID, width: Math.max(1, (maxX - minX + 1) * GRID), height: Math.max(1, (maxY - minY + 1) * GRID) } };
}

function maskedImage(image, segmentation) {
  const output = new Uint8Array(image.rgba.length);
  for (let y = 0; y < image.height; y += 1) {
    const cy = Math.min(segmentation.ch - 1, Math.floor(y / GRID));
    for (let x = 0; x < image.width; x += 1) {
      const cx = Math.min(segmentation.cw - 1, Math.floor(x / GRID));
      const i = (y * image.width + x) * 4;
      if (segmentation.mask[cy * segmentation.cw + cx]) {
        output[i] = image.rgba[i]; output[i + 1] = image.rgba[i + 1]; output[i + 2] = image.rgba[i + 2];
      } else {
        output[i] = segmentation.bg[i]; output[i + 1] = segmentation.bg[i + 1]; output[i + 2] = segmentation.bg[i + 2];
      }
      output[i + 3] = 255;
    }
  }
  return { width: image.width, height: image.height, buffer: output.buffer };
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
  return { ...result, points, rawPoints, matches: points.length, inlierRatio: rawPoints.length ? Math.round(points.length / rawPoints.length * 100) : 0,
    maskCoverageA: segA.coverage, maskCoverageB: segB.coverage,
    maskContourA: segA.contour.map(p => ({ x: p.x + left.offset.x, top: p.top + left.offset.y, bottom: p.bottom + left.offset.y })),
    maskContourB: segB.contour.map(p => ({ x: p.x + right.offset.x, top: p.top + right.offset.y, bottom: p.bottom + right.offset.y })),
    maskRectA: { ...segA.bbox, x: segA.bbox.x + left.offset.x, y: segA.bbox.y + left.offset.y, sourceWidth: left.sourceWidth, sourceHeight: left.sourceHeight },
    maskRectB: { ...segB.bbox, x: segB.bbox.x + right.offset.x, y: segB.bbox.y + right.offset.y, sourceWidth: right.sourceWidth, sourceHeight: right.sourceHeight },
    algorithm: `${result.algorithm ?? 'local-matcher'}-calibrated-background-v1` };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Kalibrerad bakgrundssubtraktion' });
self.addEventListener('message', (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== 'match') return;
  if (!payload.background) { self.postMessage({ id, ok: false, error: 'Bakgrunden är inte kalibrerad' }); return; }
  const left = crop(payload.left), right = crop(payload.right);
  const background = crop(payload.background);
  self.postMessage({ id, progress: 'segmenting' });
  const segA = segment(left, { width: background.width, height: background.height, buffer: background.rgba.buffer.slice(0) });
  const segB = segment(right, { width: background.width, height: background.height, buffer: background.rgba.buffer.slice(0) });
  self.postMessage({ id, progress: 'mask', coverageA: segA.coverage, coverageB: segB.coverage });
  const maskedA = maskedImage(left, segA), maskedB = maskedImage(right, segB);
  const core = new Worker(new URL('./orb-worker-v29.js?v=20260728-37', self.location.href), { type: 'classic' });
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
});