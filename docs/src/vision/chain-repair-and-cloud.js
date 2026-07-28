const panel = document.querySelector('#sparse-reconstruction');
const status = document.querySelector('#sparse-status');
const detail = document.querySelector('#sparse-detail');
const canvas = document.querySelector('#sparse-point-cloud');

function classify(result) {
  if (!result || result.error) return 'rejected';
  if (result.matches >= 12 && result.inlierRatio >= 35 && result.meanError <= 5) return 'approved';
  if (result.matches >= 6 && result.inlierRatio >= 20 && result.meanError <= 8) return 'weak';
  return 'rejected';
}

function selectedFigures() {
  return [...document.querySelectorAll('#captures figure[data-selection="selected"]')].reverse();
}

function imageData(image, maxWidth = 480) {
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  const work = document.createElement('canvas');
  work.width = Math.max(200, Math.round(image.naturalWidth * scale));
  work.height = Math.max(150, Math.round(image.naturalHeight * scale));
  const context = work.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, work.width, work.height);
  return context.getImageData(0, 0, work.width, work.height);
}

function runMatch(firstFigure, secondFigure) {
  const first = imageData(firstFigure.querySelector('img'));
  const second = imageData(secondFigure.querySelector('img'));
  const worker = new Worker(new URL('./orb-worker-v29.js?v=20260728-32', import.meta.url), { type: 'classic' });
  const id = crypto.randomUUID?.() ?? String(Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Hoppmatchningen tog för lång tid')); }, 25000);
    worker.onmessage = (event) => {
      const message = event.data ?? {};
      if (message.id !== id || message.progress) return;
      clearTimeout(timer);
      worker.terminate();
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error || 'Hoppmatchningen misslyckades'));
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || 'Hoppworkern kraschade')); };
    worker.postMessage({ id, type: 'match', payload: {
      left: { width: first.width, height: first.height, buffer: first.data.buffer },
      right: { width: second.width, height: second.height, buffer: second.data.buffer },
    } }, [first.data.buffer, second.data.buffer]);
  });
}

function buildBestPath(nodeCount, edges) {
  const best = Array.from({ length: nodeCount }, (_, i) => ({ nodes: [i], edges: [], score: 0 }));
  for (let to = 0; to < nodeCount; to += 1) {
    for (const edge of edges.filter((item) => item.to === to)) {
      const source = best[edge.from];
      const quality = edge.classification === 'approved' ? 2 : 1;
      const candidate = { nodes: [...source.nodes, to], edges: [...source.edges, edge], score: source.score + quality - (edge.skip ? 0.2 : 0) };
      if (candidate.nodes.length > best[to].nodes.length || (candidate.nodes.length === best[to].nodes.length && candidate.score > best[to].score)) best[to] = candidate;
    }
  }
  return best.reduce((winner, item) => item.nodes.length > winner.nodes.length || (item.nodes.length === winner.nodes.length && item.score > winner.score) ? item : winner, best[0]);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function makeCloud(path) {
  const cloud = [];
  path.edges.forEach((edge, edgeIndex) => {
    const points = edge.result.points ?? [];
    const dx0 = median(points.map((p) => p.b.x - p.a.x));
    const dy0 = median(points.map((p) => p.b.y - p.a.y));
    for (const p of points) {
      const rx = (p.b.x - p.a.x) - dx0;
      const ry = (p.b.y - p.a.y) - dy0;
      const parallax = Math.max(0.7, Math.hypot(rx, ry));
      const depth = Math.min(8, 12 / parallax);
      cloud.push({
        x: (p.a.x - 240) / 90,
        y: (p.a.y - 180) / 90,
        z: edgeIndex * 0.42 + depth * 0.18,
        quality: edge.classification,
      });
    }
  });
  return cloud;
}

function bounds2d(points) {
  if (!points.length) return null;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY };
}

function fitPoints(points, rect, padding = 28) {
  const bounds = bounds2d(points);
  if (!bounds) return [];
  const spanX = Math.max(0.001, bounds.maxX - bounds.minX);
  const spanY = Math.max(0.001, bounds.maxY - bounds.minY);
  const scale = Math.min((rect.width - padding * 2) / spanX, (rect.height - padding * 2) / spanY);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return points.map((p) => ({
    ...p,
    sx: rect.x + rect.width / 2 + (p.x - centerX) * scale,
    sy: rect.y + rect.height / 2 + (p.y - centerY) * scale,
  }));
}

function drawView(ctx, title, points, rect) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText(title, rect.x + 14, rect.y + 22);

  const fitted = fitPoints(points, rect, 34);
  let drawn = 0;
  for (const p of fitted.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))) {
    if (p.sx < rect.x || p.sx > rect.x + rect.width || p.sy < rect.y || p.sy > rect.y + rect.height) continue;
    ctx.globalAlpha = p.quality === 'approved' ? 0.92 : 0.58;
    ctx.fillStyle = p.quality === 'approved' ? '#dcefdc' : '#f2d98b';
    const radius = p.quality === 'approved' ? 2.6 : 2.1;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2);
    ctx.fill();
    drawn += 1;
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,.65)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`${drawn}/${points.length} punkter ritade`, rect.x + 14, rect.y + rect.height - 12);
  ctx.restore();
  return drawn;
}

function drawCloud(points) {
  canvas.width = 960;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1210';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return { side: 0, top: 0 };

  const angleY = -0.72;
  const angleX = 0.38;
  const perspectivePoints = points.map((p) => {
    const x1 = p.x * Math.cos(angleY) - p.z * Math.sin(angleY);
    const z1 = p.x * Math.sin(angleY) + p.z * Math.cos(angleY);
    const y1 = p.y * Math.cos(angleX) - z1 * Math.sin(angleX);
    const z2 = p.y * Math.sin(angleX) + z1 * Math.cos(angleX);
    const perspective = 1 / Math.max(0.35, 1 + z2 * 0.035);
    return { x: x1 * perspective, y: y1 * perspective, depth: z2, quality: p.quality };
  });

  const topPoints = points.map((p) => ({ x: p.z, y: p.x, depth: p.y, quality: p.quality }));
  const gap = 18;
  const rectWidth = (canvas.width - gap * 3) / 2;
  const rect = { x: gap, y: 46, width: rectWidth, height: canvas.height - 64 };
  const rect2 = { x: gap * 2 + rectWidth, y: 46, width: rectWidth, height: canvas.height - 64 };

  ctx.fillStyle = 'rgba(255,255,255,.96)';
  ctx.font = '700 16px system-ui, sans-serif';
  ctx.fillText('Preliminär parallaxrekonstruktion', 18, 26);

  return {
    side: drawView(ctx, 'Perspektivvy', perspectivePoints, rect),
    top: drawView(ctx, 'Ovanifrån (kedjeriktning ↔ tvärled)', topPoints, rect2),
  };
}

window.addEventListener('timberscanner:match-chain-ready', async (event) => {
  const figures = selectedFigures();
  if (figures.length < 3) return;
  panel.hidden = false;
  status.textContent = 'Reparerar bildkedjan…';
  detail.textContent = 'Provar hopp över en underkänd bild';

  const adjacent = event.detail.results ?? [];
  const edges = [];
  adjacent.forEach((result, index) => {
    const classification = classify(result);
    if (classification !== 'rejected') edges.push({ from: index, to: index + 1, classification, result, skip: false });
  });

  let skipApproved = 0;
  let skipWeak = 0;
  for (let middle = 1; middle < figures.length - 1; middle += 1) {
    const leftClass = classify(adjacent[middle - 1]);
    const rightClass = classify(adjacent[middle]);
    if (leftClass !== 'rejected' && rightClass !== 'rejected') continue;
    status.textContent = `Provar hoppmatchning Bild ${middle} ↔ Bild ${middle + 2}…`;
    try {
      const result = await runMatch(figures[middle - 1], figures[middle + 1]);
      const classification = classify(result);
      if (classification !== 'rejected') {
        edges.push({ from: middle - 1, to: middle + 1, classification, result, skip: true, skipped: middle });
        if (classification === 'approved') skipApproved += 1; else skipWeak += 1;
      }
    } catch (error) {
      console.warn('[chain-repair]', error);
    }
  }

  const path = buildBestPath(figures.length, edges);
  const cloud = makeCloud(path);
  const rendered = drawCloud(cloud);
  const skipped = path.edges.filter((edge) => edge.skip).map((edge) => edge.skipped + 1);
  status.textContent = `Preliminärt punktmoln: ${cloud.length} punkter`;
  detail.textContent = `${path.nodes.length}/${figures.length} bilder i längsta reparerade kedjan · ${skipApproved} godkända och ${skipWeak} svaga hoppmatchningar · ritade ${rendered.side}/${cloud.length} i perspektivvy och ${rendered.top}/${cloud.length} ovanifrån${skipped.length ? ` · hoppade över bild ${skipped.join(', ')}` : ''}`;
  window.dispatchEvent(new CustomEvent('timberscanner:sparse-cloud-ready', { detail: { cloud, path, skipApproved, skipWeak, rendered } }));
});
