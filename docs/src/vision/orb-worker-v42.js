const VERSION = '20260729-42';
const GRID = 4;
const K = 5;
const ROI = Object.freeze({ x: 0.02, y: 0.08, width: 0.96, height: 0.82 });

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

function srgb(v) {
  v /= 255;
  return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  r = srgb(r); g = srgb(g); b = srgb(b);
  const x = (r * .4124 + g * .3576 + b * .1805) / .95047;
  const y = r * .2126 + g * .7152 + b * .0722;
  const z = (r * .0193 + g * .1192 + b * .9505) / 1.08883;
  const f = (v) => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function coarseFeatures(image) {
  const cw = Math.ceil(image.width / GRID);
  const ch = Math.ceil(image.height / GRID);
  const features = new Float32Array(cw * ch * 3);
  for (let cy = 0; cy < ch; cy += 1) {
    for (let cx = 0; cx < cw; cx += 1) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let oy = 0; oy < GRID; oy += 1) {
        const y = cy * GRID + oy; if (y >= image.height) continue;
        for (let ox = 0; ox < GRID; ox += 1) {
          const x = cx * GRID + ox; if (x >= image.width) continue;
          const i = (y * image.width + x) * 4;
          r += image.rgba[i]; g += image.rgba[i + 1]; b += image.rgba[i + 2]; n += 1;
        }
      }
      const lab = rgbToLab(r / n, g / n, b / n);
      const p = (cy * cw + cx) * 3;
      features[p] = lab[0]; features[p + 1] = lab[1]; features[p + 2] = lab[2];
    }
  }
  return { features, cw, ch };
}

function kmeans(features, count, k = K) {
  const centers = new Float32Array(k * 3);
  const seeds = [.08, .27, .47, .68, .90];
  const luminances = Array.from({ length: count }, (_, i) => ({ i, l: features[i * 3] })).sort((a, b) => a.l - b.l);
  for (let c = 0; c < k; c += 1) {
    const sample = luminances[Math.min(count - 1, Math.floor((count - 1) * seeds[c]))].i;
    centers.set(features.subarray(sample * 3, sample * 3 + 3), c * 3);
  }
  const labels = new Uint8Array(count);
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const sums = new Float64Array(k * 3);
    const totals = new Uint32Array(k);
    for (let i = 0; i < count; i += 1) {
      const p = i * 3; let best = 0; let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const q = c * 3;
        const dl = features[p] - centers[q];
        const da = features[p + 1] - centers[q + 1];
        const db = features[p + 2] - centers[q + 2];
        const d = dl * dl * .8 + da * da + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      labels[i] = best;
      const q = best * 3;
      sums[q] += features[p]; sums[q + 1] += features[p + 1]; sums[q + 2] += features[p + 2]; totals[best] += 1;
    }
    for (let c = 0; c < k; c += 1) {
      if (!totals[c]) continue;
      const q = c * 3;
      centers[q] = sums[q] / totals[c]; centers[q + 1] = sums[q + 1] / totals[c]; centers[q + 2] = sums[q + 2] / totals[c];
    }
  }
  return { labels, centers };
}

function morph(input, width, height, dilate) {
  const out = new Uint8Array(input.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += input[(y + dy) * width + x + dx];
      out[y * width + x] = dilate ? (sum >= 3 ? 1 : 0) : (sum >= 5 ? 1 : 0);
    }
  }
  return out;
}

function scoreComponent(component, cw, ch) {
  const width = component.maxX - component.minX + 1;
  const height = component.maxY - component.minY + 1;
  const area = component.pixels.length;
  const aspect = width / Math.max(1, height);
  const widthRatio = width / cw;
  const heightRatio = height / ch;
  const fill = area / Math.max(1, width * height);
  const centerX = (component.minX + component.maxX) / 2 / cw;
  const centerY = (component.minY + component.maxY) / 2 / ch;
  const centerDistance = Math.hypot((centerX - .5) * .8, centerY - .52);
  const touches = Number(component.minX <= 1) + Number(component.maxX >= cw - 2) + Number(component.minY <= 1) + Number(component.maxY >= ch - 2);
  const horizontal = Math.max(0, Math.min(4, aspect) - .7) * 34;
  const size = widthRatio * 115 + Math.min(.28, area / (cw * ch)) * 250;
  const central = Math.max(-20, 58 - centerDistance * 150);
  const compact = Math.min(30, fill * 42);
  const penalties = Math.max(0, heightRatio - .48) * 170 + touches * 24 + (widthRatio > .88 ? 90 : 0);
  return { ...component, width, height, area, aspect, widthRatio, heightRatio, fill, centerX, centerY, score: horizontal + size + central + compact - penalties };
}

function findCandidates(labels, cw, ch) {
  const candidates = [];
  for (let cluster = 0; cluster < K; cluster += 1) {
    let mask = new Uint8Array(labels.length);
    for (let i = 0; i < labels.length; i += 1) mask[i] = labels[i] === cluster ? 1 : 0;
    mask = morph(morph(mask, cw, ch, true), cw, ch, false);
    const visited = new Uint8Array(mask.length);
    for (let start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;
      const stack = [start]; visited[start] = 1;
      const pixels = []; let minX = cw, minY = ch, maxX = 0, maxY = 0;
      while (stack.length) {
        const index = stack.pop(); pixels.push(index);
        const x = index % cw, y = Math.floor(index / cw);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
          const ni = ny * cw + nx;
          if (mask[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
        }
      }
      if (pixels.length < Math.max(10, labels.length * .0015)) continue;
      candidates.push(scoreComponent({ pixels, minX, minY, maxX, maxY, cluster }, cw, ch));
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function detectLog(image) {
  const coarse = coarseFeatures(image);
  const clustered = kmeans(coarse.features, coarse.cw * coarse.ch);
  const candidates = findCandidates(clustered.labels, coarse.cw, coarse.ch);
  const winner = candidates.find(c => c.aspect > 1.25 && c.widthRatio > .16 && c.centerY > .22 && c.centerY < .78 && c.heightRatio < .58) || candidates[0];
  if (!winner || winner.score < 20) throw new Error('Ingen stockliknande färgregion hittades');
  let mask = new Uint8Array(coarse.cw * coarse.ch);
  for (const index of winner.pixels) mask[index] = 1;
  mask = morph(mask, coarse.cw, coarse.ch, true);
  const contour = [];
  const stride = Math.max(1, Math.round(coarse.cw / 48));
  for (let x = winner.minX; x <= winner.maxX; x += stride) {
    let top = coarse.ch, bottom = -1;
    for (let y = 0; y < coarse.ch; y += 1) if (mask[y * coarse.cw + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    if (bottom >= top) contour.push({ x: x * GRID, top: top * GRID, bottom: Math.min(image.height - 1, (bottom + 1) * GRID) });
  }
  return { mask, cw: coarse.cw, ch: coarse.ch, contour, coverage: Math.round(winner.area / mask.length * 100), bbox: { x: winner.minX * GRID, y: winner.minY * GRID, width: winner.width * GRID, height: winner.height * GRID }, aspect: Math.round(winner.aspect * 100) / 100, cluster: winner.cluster, score: Math.round(winner.score) };
}

function maskedImage(image, seg) {
  const out = new Uint8Array(image.rgba.length);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < image.height; y += 12) for (let x = 0; x < image.width; x += 12) { const i = (y * image.width + x) * 4; r += image.rgba[i]; g += image.rgba[i + 1]; b += image.rgba[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  for (let y = 0; y < image.height; y += 1) {
    const cy = Math.min(seg.ch - 1, Math.floor(y / GRID));
    for (let x = 0; x < image.width; x += 1) {
      const cx = Math.min(seg.cw - 1, Math.floor(x / GRID));
      const i = (y * image.width + x) * 4;
      if (seg.mask[cy * seg.cw + cx]) { out[i] = image.rgba[i]; out[i + 1] = image.rgba[i + 1]; out[i + 2] = image.rgba[i + 2]; }
      else { out[i] = r; out[i + 1] = g; out[i + 2] = b; }
      out[i + 3] = 255;
    }
  }
  return { width: image.width, height: image.height, buffer: out.buffer };
}

function inside(seg, p) { const x = Math.floor(p.x / GRID), y = Math.floor(p.y / GRID); return x >= 0 && x < seg.cw && y >= 0 && y < seg.ch && seg.mask[y * seg.cw + x] === 1; }
function translateResult(result, left, right, a, b) {
  const valid = m => inside(a, m.a) && inside(b, m.b);
  const shift = m => ({ ...m, a: { x: m.a.x + left.offset.x, y: m.a.y + left.offset.y }, b: { x: m.b.x + right.offset.x, y: m.b.y + right.offset.y } });
  const points = (result.points || []).filter(valid).map(shift);
  const rawPoints = (result.rawPoints || []).filter(valid).map(shift);
  return { ...result, points, rawPoints, matches: points.length, inlierRatio: rawPoints.length ? Math.round(points.length / rawPoints.length * 100) : 0, maskCoverageA: a.coverage, maskCoverageB: b.coverage, detectorAspectA: a.aspect, detectorAspectB: b.aspect, detectorScoreA: a.score, detectorScoreB: b.score, maskContourA: a.contour.map(p => ({ x: p.x + left.offset.x, top: p.top + left.offset.y, bottom: p.bottom + left.offset.y })), maskContourB: b.contour.map(p => ({ x: p.x + right.offset.x, top: p.top + right.offset.y, bottom: p.bottom + right.offset.y })), maskRectA: { ...a.bbox, x: a.bbox.x + left.offset.x, y: a.bbox.y + left.offset.y, sourceWidth: left.sourceWidth, sourceHeight: left.sourceHeight }, maskRectB: { ...b.bbox, x: b.bbox.x + right.offset.x, y: b.bbox.y + right.offset.y, sourceWidth: right.sourceWidth, sourceHeight: right.sourceHeight }, algorithm: `${result.algorithm || 'local-matcher'}-lab-kmeans-region-v1` };
}

self.postMessage({ type: 'ready', version: VERSION, engine: 'Lab K-means regionbaserad stockdetektor' });
self.addEventListener('message', event => {
  const { id, type, payload } = event.data || {}; if (type !== 'match') return;
  try {
    const left = crop(payload.left), right = crop(payload.right);
    self.postMessage({ id, progress: 'region-clustering' });
    const segA = detectLog(left), segB = detectLog(right);
    self.postMessage({ id, progress: 'mask', coverageA: segA.coverage, coverageB: segB.coverage, scoreA: segA.score, scoreB: segB.score });
    const maskedA = maskedImage(left, segA), maskedB = maskedImage(right, segB);
    const core = new Worker(new URL('./orb-worker-v29.js?v=20260729-42', self.location.href), { type: 'classic' });
    const finish = () => core.terminate();
    core.onmessage = e => { const m = e.data || {}; if (m.type === 'ready' || m.id !== id) return; if (m.progress) { self.postMessage(m); return; } finish(); if (m.ok) self.postMessage({ id, ok: true, result: translateResult(m.result, left, right, segA, segB) }); else self.postMessage(m); };
    core.onerror = error => { finish(); self.postMessage({ id, ok: false, error: error.message || 'Matchningskärnan kraschade' }); };
    core.postMessage({ id, type: 'match', payload: { left: maskedA, right: maskedB } }, [maskedA.buffer, maskedB.buffer]);
  } catch (error) { self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
