const panel = document.querySelector('#sparse-reconstruction');
const canvas = document.querySelector('#sparse-point-cloud');
const status = document.querySelector('#sparse-status');
const detail = document.querySelector('#sparse-detail');

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustMotion(matches) {
  const dx = matches.map((match) => match.bx - match.ax);
  const dy = matches.map((match) => match.by - match.ay);
  return { dx: median(dx), dy: median(dy) };
}

function reconstruct(detailEvent) {
  const { matches, frameA } = detailEvent;
  if (!panel || !canvas || matches.length < 8) {
    if (panel) panel.hidden = true;
    return null;
  }

  const motion = robustMotion(matches);
  const focal = Math.max(frameA.width, frameA.height) * 0.9;
  const cx = frameA.width / 2;
  const cy = frameA.height / 2;
  const points = [];

  for (const match of matches) {
    const residualX = (match.bx - match.ax) - motion.dx;
    const residualY = (match.by - match.ay) - motion.dy;
    const parallax = Math.hypot(residualX, residualY);
    if (parallax < 0.55 || parallax > 35) continue;

    const depth = Math.min(12, Math.max(0.8, focal / (parallax * 7)));
    points.push({
      x: ((match.ax - cx) / focal) * depth,
      y: -((match.ay - cy) / focal) * depth,
      z: depth,
      confidence: match.score,
      parallax,
    });
  }

  return { points, motion };
}

function project(point, rotationY, rotationX, width, height) {
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const x1 = (point.x * cosY) - (point.z * sinY);
  const z1 = (point.x * sinY) + (point.z * cosY);
  const y1 = (point.y * cosX) - (z1 * sinX);
  const z2 = (point.y * sinX) + (z1 * cosX);
  const scale = 190 / Math.max(2.5, z2 + 6);
  return {
    x: width / 2 + x1 * scale,
    y: height / 2 + y1 * scale,
    size: Math.max(1.5, 4.5 - z2 * 0.15),
  };
}

function draw(result) {
  const width = 760;
  const height = 420;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#0d1210';
  context.fillRect(0, 0, width, height);

  context.strokeStyle = 'rgba(180, 200, 185, .2)';
  context.lineWidth = 1;
  for (let i = 1; i < 8; i += 1) {
    context.beginPath();
    context.moveTo((width / 8) * i, 0);
    context.lineTo((width / 8) * i, height);
    context.stroke();
  }
  for (let i = 1; i < 5; i += 1) {
    context.beginPath();
    context.moveTo(0, (height / 5) * i);
    context.lineTo(width, (height / 5) * i);
    context.stroke();
  }

  const projected = result.points
    .map((point) => ({ point, screen: project(point, -0.48, 0.24, width, height) }))
    .sort((a, b) => b.point.z - a.point.z);

  for (const item of projected) {
    const alpha = Math.min(1, Math.max(0.35, item.point.confidence));
    context.fillStyle = `rgba(90, 225, 145, ${alpha})`;
    context.beginPath();
    context.arc(item.screen.x, item.screen.y, item.screen.size, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = 'rgba(255,255,255,.82)';
  context.font = '14px system-ui, sans-serif';
  context.fillText('Relativ tvåbildsrekonstruktion – ej skalenlig', 16, 24);
}

function classify(result) {
  const count = result.points.length;
  const motion = Math.hypot(result.motion.dx, result.motion.dy);
  if (count >= 24 && motion >= 2) return ['Stabil grund för triangulering', `${count} relativa 3D-punkter · kameraflöde ${motion.toFixed(1)} px`];
  if (count >= 10) return ['Punktmoln skapat, men svagt', `${count} relativa 3D-punkter · flytta kameran lite mer i sidled`];
  return ['Otillräcklig parallax', `${count} relativa 3D-punkter · undvik att bara rotera telefonen på samma plats`];
}

window.addEventListener('timberscanner:feature-matches', (event) => {
  const result = reconstruct(event.detail);
  if (!result || !panel) return;
  panel.hidden = false;
  draw(result);
  const [headline, description] = classify(result);
  status.textContent = headline;
  detail.textContent = description;
});
