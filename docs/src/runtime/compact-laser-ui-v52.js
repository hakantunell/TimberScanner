const video = document.querySelector('#camera');
const cameraCard = video?.closest('.camera-card');
const laserPanel = document.querySelector('#laser-line-lab');

let latestLaser = null;
let latestRotation = null;
let raf = 0;

function buildOverlay() {
  if (!cameraCard || document.querySelector('#scanner-overlay')) return;
  cameraCard.style.position = 'relative';
  const overlay = document.createElement('canvas');
  overlay.id = 'scanner-overlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '3';
  cameraCard.append(overlay);
}

function compactPanels() {
  const grid = document.querySelector('#laser-line-grid');
  if (grid) grid.hidden = true;
  const oldRotation = document.querySelector('#rotation-scale-panel');
  if (oldRotation) oldRotation.hidden = true;

  const strict = document.querySelector('#t51-panel');
  if (strict) {
    const strictGrid = strict.querySelector('.segmentation-lab-grid');
    if (strictGrid) strictGrid.hidden = true;
    const candidates = strict.querySelector('#t51-candidates');
    const log = strict.querySelector('#t51-log')?.closest('label');
    if (candidates && !candidates.closest('details')) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Visa felsökning och T-kandidater';
      details.append(summary);
      candidates.before(details);
      details.append(candidates);
      if (log) details.append(log);
    }
  }

  for (const selector of ['#segmentation-lab', '#sparse-reconstruction', '#feature-matching', '#contour-diagnostics', '.analysis-section', '.status-grid', '.scan-controller']) {
    const element = document.querySelector(selector);
    if (element) element.hidden = true;
  }

  const manualCapture = document.querySelector('#capture');
  const newPass = document.querySelector('#new-pass');
  const exportButton = document.querySelector('#export');
  if (manualCapture) manualCapture.hidden = true;
  if (newPass) newPass.hidden = true;
  if (exportButton) exportButton.hidden = true;

  if (laserPanel) {
    const note = laserPanel.querySelector('.diagnostic-note');
    if (note) note.textContent = 'Laserprofil och rotationsmarkör visas i den stora kamerabilden. Öppna felsökning endast när diagnostik behövs.';
  }
}

function resizeOverlay(overlay) {
  if (!video?.videoWidth || !video?.videoHeight) return false;
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  return true;
}

function drawOverlay() {
  const overlay = document.querySelector('#scanner-overlay');
  if (!overlay || !resizeOverlay(overlay)) {
    raf = requestAnimationFrame(drawOverlay);
    return;
  }
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);

  if (latestLaser?.points?.length) {
    const sx = overlay.width / latestLaser.width;
    const sy = overlay.height / latestLaser.height;
    context.strokeStyle = '#35ff75';
    context.lineWidth = 2;
    context.beginPath();
    latestLaser.points.forEach((point, index) => {
      const x = point.x * sx;
      const y = point.y * sy;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
  }

  if (latestRotation?.centerX != null && latestRotation?.centerY != null) {
    const sourceWidth = 560;
    const sourceHeight = sourceWidth / overlay.width * overlay.height;
    const sx = overlay.width / sourceWidth;
    const sy = overlay.height / sourceHeight;
    const cx = latestRotation.centerX * sx;
    const cy = latestRotation.centerY * sy;
    const radius = (latestRotation.radius || 42) * (sx + sy) / 2;
    const angle = Number(latestRotation.angleDeg || 0) * Math.PI / 180;
    context.strokeStyle = '#ffd45e';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.moveTo(cx, cy);
    context.lineTo(cx + Math.cos(angle) * radius * .8, cy + Math.sin(angle) * radius * .8);
    context.stroke();
  }
  raf = requestAnimationFrame(drawOverlay);
}

window.addEventListener('timberscanner:laser-line-detected', event => { latestLaser = event.detail; });
window.addEventListener('timberscanner:rotation-v51', event => { latestRotation = event.detail; });
window.addEventListener('pagehide', () => cancelAnimationFrame(raf));

buildOverlay();
compactPanels();
new MutationObserver(compactPanels).observe(document.body, { childList: true, subtree: true });
raf = requestAnimationFrame(drawOverlay);