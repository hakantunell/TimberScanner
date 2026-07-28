const canvas = document.querySelector('#feature-match-canvas');

function drawRoi() {
  if (!canvas?.width || !canvas?.height) return;
  const ctx = canvas.getContext('2d');
  const half = canvas.width / 2;
  const imageHeight = Math.min(360, canvas.height - 60);
  const xInset = half * 0.08;
  const yInset = imageHeight * 0.18;
  const width = half * 0.84;
  const height = imageHeight * 0.64;

  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(90, 220, 255, .95)';
  ctx.strokeRect(xInset, yInset, width, height);
  ctx.strokeRect(half + xInset, yInset, width, height);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(90, 220, 255, .95)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('Aktivt stockområde', xInset + 8, yInset + 18);
  ctx.fillText('Aktivt stockområde', half + xInset + 8, yInset + 18);
  ctx.restore();
}

window.addEventListener('timberscanner:pair-matched', () => window.requestAnimationFrame(drawRoi));
