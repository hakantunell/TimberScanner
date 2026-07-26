const health = document.querySelector('#health');
const pointCount = document.querySelector('#point-count');
const confidence = document.querySelector('#confidence');
const phase = document.querySelector('#phase');

async function refreshStatus() {
  try {
    const [healthResponse, statusResponse] = await Promise.all([
      fetch('/api/health'),
      fetch('/api/scanner/status'),
    ]);
    if (!healthResponse.ok || !statusResponse.ok) throw new Error('API unavailable');
    const status = await statusResponse.json();
    health.textContent = 'Klar';
    pointCount.textContent = status.laserPointCount;
    confidence.textContent = `${Math.round(status.laserConfidence * 100)} %`;
    phase.textContent = status.phase;
  } catch {
    health.textContent = 'Ingen kontakt';
  }
}

refreshStatus();
setInterval(refreshStatus, 1000);
