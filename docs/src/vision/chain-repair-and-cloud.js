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
  const worker = new Worker(new URL('./orb-worker-v29.js?v=20260728-31', import.meta.url), { type: 'classic' });
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

function drawCloud(points) {
  canvas.width = 900;
  canvas.height = 520;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1210';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return;
  const angleY = -0.7;
  const angleX = 0.35;
  const projected = points.map((p) => {
    const x1 = p.x * Math.cos(angleY) - p.z * Math.sin(angleY);
    const z1 = p.x * Math.sin(angleY) + p.z * Math.cos(angleY);
    const y1 = p.y * Math.cos(angleX) - z1 * Math.sin(angleX);
    const z2 = p.y * Math.sin(angleX) + z1 * Math.cos(angleX);
    const perspective = 120 / (20 + z2);
    return { x: 450 + x1 * 75 * perspective, y: 270 + y1 * 75 * perspective, z: z2, quality: p.quality };
  }).sort((a, b) => a.z - b.z);
  for (const p of projected) {
    ctx.globalAlpha = p.quality === 'approved' ? 0.9 : 0.5;
    ctx.fillStyle = p.quality === 'approved' ? '#dcefdc' : '#f2d98b';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.quality === 'approved' ? 2.2 : 1.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
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
  drawCloud(cloud);
  const skipped = path.edges.filter((edge) => edge.skip).map((edge) => edge.skipped + 1);
  status.textContent = `Preliminärt punktmoln: ${cloud.length} punkter`;
  detail.textContent = `${path.nodes.length}/${figures.length} bilder i längsta reparerade kedjan · ${skipApproved} godkända och ${skipWeak} svaga hoppmatchningar${skipped.length ? ` · hoppade över bild ${skipped.join(', ')}` : ''}`;
  window.dispatchEvent(new CustomEvent('timberscanner:sparse-cloud-ready', { detail: { cloud, path, skipApproved, skipWeak } }));
});
