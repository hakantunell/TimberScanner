import {
  addCapture,
  createCapture,
  createSession,
  nextPass,
  setScaleReference,
} from './src/scanning/scan-session.js';
import { CloudRelay } from './src/transfer/cloud-relay.js';

const required = (id) => {
  const element = document.querySelector(`#${id}`);
  if (!element) throw new Error(`Appens HTML saknar elementet #${id}. Ladda om sidan.`);
  return element;
};

const video = required('camera');
const canvas = required('snapshot');
const placeholder = required('camera-placeholder');
const captures = required('captures');
const startButton = required('start-camera');
const captureButton = required('capture');
const newPassButton = required('new-pass');
const exportButton = required('export');
const resetButton = required('reset');
const scaleInput = required('scale-mm');
const imageCount = required('image-count');
const passCount = required('pass-count');
const analysisCount = required('analysis-count');
const storageStatus = required('storage-status');
const rolePicker = required('role-picker');
const viewerModeButton = required('viewer-mode');
const captureModeButton = required('capture-mode');
const connectionScreen = required('connection-screen');
const workScreen = required('work-screen');
const capturePanel = required('capture-panel');
const pairingHelp = required('pairing-help');
const qrCode = required('qr-code');
const manualConnect = required('manual-connect');
const sessionCode = required('peer-code');
const connectButton = required('connect-peer');
const connectionStatus = required('connection-status');
const showPairingButton = required('show-pairing');
const workStatus = required('work-status');
const workDetail = required('work-detail');
const trace = document.querySelector('#viewer-trace');

const relay = new CloudRelay();
const previewUrls = new Set();
const receivedIds = new Set();
const POLL_DELAY_MS = 2000;
let session = createSession();
let mode = null;
let remoteSession = null;
let pollTimer = null;
let pollGeneration = 0;
let pairingUrl = null;
let cloudRevision = null;
let cloudCount = 0;
let logLines = [];

function log(message) {
  const stamp = new Date().toLocaleTimeString('sv-SE');
  const line = `${stamp} ${message}`;
  console.log(`[diagnostik] ${line}`);
  logLines.push(line);
  if (logLines.length > 40) logLines = logLines.slice(-40);
  if (trace) {
    trace.style.whiteSpace = 'pre-wrap';
    trace.textContent = logLines.join('\n');
  }
}

function showConnectionScreen() {
  connectionScreen.hidden = false;
  workScreen.hidden = true;
  rolePicker.hidden = true;
}

function showWorkScreen() {
  workScreen.hidden = false;
  connectionScreen.hidden = true;
  rolePicker.hidden = true;
  capturePanel.hidden = mode !== 'capture';
}

function showRolePicker() {
  rolePicker.hidden = false;
  connectionScreen.hidden = true;
  workScreen.hidden = true;
}

function refreshStatus() {
  imageCount.textContent = mode === 'viewer' ? `${session.images.length}/${cloudCount}` : String(session.images.length);
  passCount.textContent = String(session.currentPass);
  analysisCount.textContent = '0';
  exportButton.disabled = session.images.length === 0;
  storageStatus.textContent = mode === 'viewer' ? 'Ej aktiv (diagnostik)' : 'Endast minne';
}

function clearPreviews() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
  captures.replaceChildren();
}

function appendCapture(capture) {
  const figure = document.createElement('figure');
  figure.className = 'quality-pending';
  figure.dataset.captureId = capture.id;
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  const url = URL.createObjectURL(capture.blob);
  previewUrls.add(url);
  image.src = url;
  image.alt = `Bildruta ${session.images.length}, rotation ${capture.pass}`;
  const caption = document.createElement('figcaption');
  caption.textContent = `Bild ${session.images.length} · ${(capture.blob.size / 1024).toFixed(0)} kB · Analys avstängd`;
  figure.append(image, caption);
  captures.prepend(figure);
}

function resetMemorySession() {
  session = createSession();
  receivedIds.clear();
  cloudCount = 0;
  scaleInput.value = '';
  clearPreviews();
  refreshStatus();
  log('Lokal minnessession rensad');
}

function canvasToBlob() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Kunde inte skapa bildfil')), 'image/jpeg', 0.9);
  });
}

async function captureImage() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob();
  const capture = createCapture({ blob, width: canvas.width, height: canvas.height, pass: session.currentPass });
  session = addCapture(session, capture);
  appendCapture(capture);
  refreshStatus();

  if (mode === 'capture' && remoteSession?.uploadToken) {
    workDetail.textContent = 'Laddar upp bildruta…';
    await relay.uploadCapture(remoteSession, capture);
    workDetail.textContent = `${session.images.length} bildrutor tagna`;
  }
}

async function downloadOne(result) {
  const next = result.images.find((image) => !receivedIds.has(image.id));
  if (!next) return false;

  const ordinal = session.images.length + 1;
  log(`START bild ${ordinal}/${result.images.length}: ${next.id}`);
  workDetail.textContent = `Hämtar bild ${ordinal}/${result.images.length}…`;
  const started = performance.now();
  const blob = await relay.downloadImage(remoteSession, next.id);
  const elapsed = Math.round(performance.now() - started);
  log(`NEDLADDAD bild ${ordinal}: ${(blob.size / 1024).toFixed(0)} kB på ${elapsed} ms`);

  const metadata = next.metadata ?? {};
  const capture = {
    id: next.id,
    pass: Number(metadata.pass) || 1,
    width: Number(metadata.width) || 0,
    height: Number(metadata.height) || 0,
    capturedAt: metadata.capturedAt ?? next.uploadedAt,
    markerObservations: [],
    depthFrame: null,
    blob,
  };
  session = addCapture(session, capture);
  session = { ...session, currentPass: Math.max(session.currentPass, capture.pass) };
  receivedIds.add(next.id);
  log(`TILLAGD bild ${ordinal}: session=${session.images.length}`);
  appendCapture(capture);
  log(`VISAD bild ${ordinal}: DOM-bilder=${captures.querySelectorAll('img').length}`);
  refreshStatus();
  return true;
}

async function receiveCloudState() {
  if (!remoteSession?.viewToken) return;
  log('Begär bildlista');
  const result = await relay.listImages(remoteSession);
  cloudCount = result.images.length;
  const revision = result.live?.revision ?? 0;
  log(`METADATA: ${cloudCount} bilder, revision ${revision}`);

  if (cloudRevision !== null && revision !== cloudRevision && cloudCount === 0) resetMemorySession();
  cloudRevision = revision;
  await downloadOne(result);

  if (result.live?.connected) {
    showWorkScreen();
    workStatus.textContent = 'Telefon ansluten · diagnostik';
    workDetail.textContent = `${session.images.length}/${cloudCount} bildrutor mottagna`;
  } else {
    connectionStatus.textContent = 'Väntar på telefonen';
  }
  refreshStatus();
}

function startPolling() {
  stopPolling();
  const generation = pollGeneration;
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      await receiveCloudState();
    } catch (error) {
      log(`FEL: ${error instanceof Error ? error.message : String(error)}`);
      const target = workScreen.hidden ? connectionStatus : workDetail;
      target.textContent = `Synkfel: ${error.message}`;
      console.error(error);
    } finally {
      if (generation === pollGeneration) pollTimer = window.setTimeout(poll, POLL_DELAY_MS);
    }
  };
  log('Polling startad: en bild per varv');
  poll();
}

function stopPolling() {
  pollGeneration += 1;
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = null;
}

function encodeCaptureCode(value) {
  return `${value.sessionId}.${value.uploadToken}`;
}

function decodeCaptureCode(code) {
  const separator = code.indexOf('.');
  if (separator < 1) throw new Error('Ogiltig sessionskod');
  return { sessionId: code.slice(0, separator), uploadToken: code.slice(separator + 1) };
}

function renderPairingCode() {
  qrCode.hidden = false;
  qrCode.replaceChildren();
  if (!pairingUrl || !remoteSession) return;
  new window.QRCode(qrCode, { text: pairingUrl, width: 220, height: 220 });
  const code = document.createElement('code');
  code.textContent = encodeCaptureCode(remoteSession);
  qrCode.append(code);
}

async function startViewerMode() {
  mode = 'viewer';
  resetMemorySession();
  showConnectionScreen();
  qrCode.hidden = false;
  manualConnect.hidden = true;
  pairingHelp.textContent = 'Skapar en privat diagnostiksession i Cloudflare…';
  connectionStatus.textContent = 'Kontrollerar backend';
  await relay.health();
  remoteSession = await relay.createSession();
  cloudRevision = 0;

  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('mode', 'capture');
  url.searchParams.set('session', remoteSession.sessionId);
  url.searchParams.set('uploadToken', remoteSession.uploadToken);
  pairingUrl = url.toString();
  renderPairingCode();
  pairingHelp.textContent = 'Skanna QR-koden med telefonen.';
  connectionStatus.textContent = 'Väntar på telefonen';
  startPolling();
}

async function activateCaptureConnection(cloudSession) {
  remoteSession = cloudSession;
  sessionCode.value = encodeCaptureCode(cloudSession);
  workStatus.textContent = 'Kopplad till datorn';
  workDetail.textContent = 'Starta kameran för att börja skanna';
  showWorkScreen();
  await relay.markConnected(remoteSession);
}

async function startCaptureMode(cloudSession = null) {
  mode = 'capture';
  resetMemorySession();
  if (cloudSession) await activateCaptureConnection(cloudSession);
  else {
    showConnectionScreen();
    manualConnect.hidden = false;
    qrCode.hidden = true;
    pairingHelp.textContent = 'Skriv sessionskoden från datorn.';
    connectionStatus.textContent = 'Inte ansluten';
  }
}

async function resetSession() {
  if (!confirm('Rensa hela skanningen på telefonen, datorn och i molnet?')) return;
  if (remoteSession?.sessionId && (remoteSession.uploadToken || remoteSession.viewToken)) await relay.clearImages(remoteSession);
  resetMemorySession();
  workDetail.textContent = 'Skanningen är rensad';
}

async function initialise() {
  refreshStatus();
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'capture') {
    const sessionId = params.get('session');
    const uploadToken = params.get('uploadToken');
    await startCaptureMode(sessionId && uploadToken ? { sessionId, uploadToken } : null);
  } else showRolePicker();
}

viewerModeButton.addEventListener('click', () => startViewerMode().catch((error) => {
  showConnectionScreen();
  connectionStatus.textContent = `Kunde inte skapa session: ${error.message}`;
  log(`STARTFEL: ${error.message}`);
}));
captureModeButton.addEventListener('click', () => startCaptureMode().catch(console.error));
connectButton.addEventListener('click', () => activateCaptureConnection(decodeCaptureCode(sessionCode.value.trim())).catch(console.error));
showPairingButton.addEventListener('click', () => { renderPairingCode(); showConnectionScreen(); });
captureButton.addEventListener('click', () => captureImage().catch((error) => { workDetail.textContent = error.message; }));
newPassButton.addEventListener('click', () => { session = nextPass(session); refreshStatus(); });
resetButton.addEventListener('click', () => resetSession().catch((error) => { workDetail.textContent = error.message; }));
scaleInput.addEventListener('change', () => {
  const value = Number(scaleInput.value);
  session = setScaleReference(session, value > 0 ? value : null);
});

// Kamerastarten hanteras enbart av camera-controller i telefonläge.
startButton.dataset.diagnosticVersion = '20260728-9';
analysisCount.title = 'Analys är avstängd i diagnostikversionen';
exportButton.disabled = true;

window.addEventListener('pagehide', () => {
  stopPolling();
  clearPreviews();
});

initialise().catch((error) => {
  console.error(error);
  showRolePicker();
  alert(`TimberScanner kunde inte starta: ${error.message}`);
});
