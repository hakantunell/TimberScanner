const VERSION = '20260729-57';
const startedAt = performance.now();
const video = document.querySelector('#camera');
const startCameraButton = document.querySelector('#start-camera');
const laserPanel = document.querySelector('#laser-line-lab');

const state = { analysisLoaded: false, analysisLoading: false, analysisFailed: false, rows: [] };

function elapsed() { return `${(performance.now() - startedAt).toFixed(1)} ms`; }
function log(message) {
  state.rows.push(`${elapsed()}\t${message}`);
  if (state.rows.length > 160) state.rows.shift();
  const output = document.querySelector('#bootstrap-log');
  if (output) { output.value = state.rows.join('\n'); output.scrollTop = output.scrollHeight; }
  console.info(`[TimberScanner bootstrap ${elapsed()}] ${message}`);
}

function hideLegacyUiOnce() {
  for (const selector of ['#segmentation-lab','#sparse-reconstruction','#feature-matching','#contour-diagnostics','.analysis-section','.status-grid','.scan-controller']) {
    const element = document.querySelector(selector); if (element) element.hidden = true;
  }
  for (const selector of ['#capture','#new-pass','#export']) {
    const element = document.querySelector(selector); if (element) element.hidden = true;
  }
}

function buildUi() {
  if (document.querySelector('#bootstrap-panel')) return;
  const panel = document.createElement('section');
  panel.id = 'bootstrap-panel';
  panel.className = 'diagnostic-panel';
  panel.innerHTML = `
    <div class="diagnostic-heading">
      <div><p class="eyebrow">Uppstart och prestanda</p><h2>Kontrollerad analysstart</h2></div>
      <div><strong id="bootstrap-status">Grundgränssnitt laddat</strong><span id="bootstrap-detail">Ingen bildanalys körs ännu</span></div>
    </div>
    <div class="segmentation-lab-actions">
      <button id="load-analysis" type="button" disabled>Ladda laseranalys</button>
      <button id="copy-bootstrap-log" class="secondary" type="button">Kopiera uppstartslogg</button>
    </div>
    <label class="laser-setting" style="margin-top:12px">Uppstartslogg
      <textarea id="bootstrap-log" rows="10" readonly style="width:100%;font-family:ui-monospace,monospace;white-space:pre"></textarea>
    </label>
    <p class="diagnostic-note">Profiler jämförs efter registrering. Rå rörelse, bästa justering och kvarvarande residual visas för varje sparad profil.</p>`;
  const target = laserPanel || document.querySelector('#capture-panel');
  target?.insertAdjacentElement('afterend', panel);
  panel.querySelector('#load-analysis').addEventListener('click', loadAnalysis);
  panel.querySelector('#copy-bootstrap-log').addEventListener('click', async () => {
    const text = panel.querySelector('#bootstrap-log').value;
    try { await navigator.clipboard.writeText(text); }
    catch { panel.querySelector('#bootstrap-log').select(); document.execCommand('copy'); }
  });
}

function updateCameraReady() {
  const ready = Boolean(video?.videoWidth && video?.videoHeight && !video.paused);
  const button = document.querySelector('#load-analysis');
  if (button && !state.analysisLoaded && !state.analysisLoading && !state.analysisFailed) button.disabled = !ready;
  const status = document.querySelector('#bootstrap-status');
  const detail = document.querySelector('#bootstrap-detail');
  if (ready) {
    if (status) status.textContent = 'Kameran spelar';
    if (detail) detail.textContent = `${video.videoWidth} × ${video.videoHeight} · laseranalys kan laddas`;
    log(`camera playing ${video.videoWidth}x${video.videoHeight}`);
  }
}

async function importTimed(path, label) {
  const before = performance.now();
  log(`import start ${label}`);
  await import(`${path}?v=${VERSION}`);
  log(`import klar ${label} ${(performance.now() - before).toFixed(1)} ms`);
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function loadAnalysis() {
  if (state.analysisLoaded || state.analysisLoading || state.analysisFailed) return;
  if (!video?.videoWidth || !video?.videoHeight || video.paused) { log('analysis nekad: kameran spelar inte'); return; }
  state.analysisLoading = true;
  const button = document.querySelector('#load-analysis');
  const status = document.querySelector('#bootstrap-status');
  const detail = document.querySelector('#bootstrap-detail');
  if (button) { button.disabled = true; button.textContent = 'Laddar laseranalys…'; }
  if (status) status.textContent = 'Laddar laseranalys';
  try {
    await importTimed('../vision/lean-laser-line-v52.js', 'laserlinje');
    await importTimed('../vision/auto-laser-profile-collector-v57.js', 'registrerad profildiagnostik');
    state.analysisLoaded = true;
    if (button) button.textContent = 'Laseranalys laddad';
    if (status) status.textContent = 'Laseranalys laddad';
    if (detail) detail.textContent = 'Profiler registreras före kvalitetsbedömning; T-rotation är fortfarande avstängd';
    log('analysis ready med registrerad profildiagnostik');
  } catch (error) {
    state.analysisFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (button) { button.disabled = true; button.textContent = 'Analysfel – ladda om sidan'; }
    if (status) status.textContent = 'Analysladdningen misslyckades';
    if (detail) detail.textContent = message;
    log(`analysis error ${message}`);
  } finally { state.analysisLoading = false; }
}

hideLegacyUiOnce();
buildUi();
log('bootstrap module evaluated');
startCameraButton?.addEventListener('click', () => log('start camera clicked'), { capture: true });
video?.addEventListener('loadedmetadata', () => { log(`loadedmetadata ${video.videoWidth}x${video.videoHeight}`); updateCameraReady(); });
video?.addEventListener('playing', updateCameraReady);
video?.addEventListener('pause', () => log('camera paused'));
video?.addEventListener('error', () => log(`camera error ${video.error?.message || video.error?.code || 'unknown'}`));
window.addEventListener('load', () => log('window load'));
window.addEventListener('pageshow', event => log(`pageshow persisted=${event.persisted}`));
window.addEventListener('pagehide', event => log(`pagehide persisted=${event.persisted}`));