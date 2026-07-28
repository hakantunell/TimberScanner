const canvas = document.querySelector('#feature-match-canvas');

function drawMask(contour, rect, xOffset = 0) {
  if (!canvas?.width || !contour?.length || !rect) return;
  const ctx = canvas.getContext('2d');
  const half = canvas.width / 2;
  const scale = Math.min(half / rect.sourceWidth, 360 / rect.sourceHeight);
  const top = contour.map((p) => ({ x: xOffset + p.x * scale, y: p.top * scale }));
  const bottom = [...contour].reverse().map((p) => ({ x: xOffset + p.x * scale, y: p.bottom * scale }));
  const polygon = [...top, ...bottom];
  if (polygon.length < 4) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i += 1) ctx.lineTo(polygon[i].x, polygon[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(55, 205, 255, .12)';
  ctx.fill();
  ctx.setLineDash([7, 5]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(90, 220, 255, .96)';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(90, 220, 255, .98)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText('Segmenterad stock', polygon[0].x + 6, Math.max(16, polygon[0].y + 16));
  ctx.restore();
}

window.addEventListener('timberscanner:pair-matched', (event) => {
  const result = event.detail ?? {};
  window.requestAnimationFrame(() => {
    drawMask(result.maskContourA, result.maskRectA, 0);
    drawMask(result.maskContourB, result.maskRectB, canvas.width / 2);
  });
});
