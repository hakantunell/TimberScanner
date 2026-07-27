import {
  ACTIVE_SESSION_ID,
  addCapture,
  createCapture,
  createSession,
  nextPass,
  setScaleReference,
} from './src/scanning/scan-session.js';
import { deleteSession, loadSession, saveSession } from './src/storage/session-store.js';
import { CloudRelay } from './src/transfer/cloud-relay.js';
import { analyseCanvasQuality, describeSharpness } from './src/vision/image-quality.js';

const byId = (id) => document.querySelector(`#${id}`);
const video = byId('camera');
const canvas = byId('snapshot');
const placeholder = byId('camera-placeholder');
const captures = byId('captures');
const startButton = byId('start-camera');
const captureButton = byId('capture');
const newPassButton = byId('new-pass');
const exportButton = byId('export');
const resetButton = byId('reset');
const scaleInput = byId('scale-mm');
const imageCount = byId('image-count');
const passCount = byId('pass-count');
const analysisCount = byId('analysis-count');
const storageStatus = byId('storage-status');
const rolePicker = byId('role-picker');
const viewerModeButton = byId('viewer-mode');
const captureModeButton = byId('capture-mode');
const connectionScreen = byId('connection-screen');
const workScreen = byId('work-screen');
const capturePanel = byId('capture-panel');
const pairingHelp = byId('pairing-help');
const qrCode = byId('qr-code');
const manualConnect = byId('manual-connect');
const sessionCode = byId('peer-code');
const connectButton = byId('connect-peer');
const connectionStatus = byId('connection-status');
const showPairingButton = byId('show-pairing');
const workStatus = byId('work-status');
const workDetail = byId('work-detail');

const relay = new CloudRelay();
const previewUrls = new Set();
let session = createSession();
let stream = null;
let mode = null;
let remoteSession = null;
let pollTimer = null;
let pairingUrl = null;

function showConnectionScreen() {
  rolePicker.hidden = true;
  connectionScreen.hidden = false;
  workScreen.hidden = true;
}

function showWorkScreen() {
  rolePicker.hidden = true;
  connectionScreen.hidden = true;
  workScreen.hidden = false;
  capturePanel.hidden = mode !== 'capture';
}

function refreshStatus() {
  imageCount.textContent = String(session.images.length);
  passCount.textContent = String(session.currentPass);
  analysisCount.textContent = String(session.images.filter((item) => item.quality).length);
  if (exportButton) exportButton.disabled = session.images.length === 0;
}

function clearPreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
}

function qualityClass(quality) {
  if (!quality) return 'quality-pending';
  return `quality-${quality.sharpness}`;
}

function renderCaptures() {
  clearPreviewUrls();
  captures.replaceChildren();
  for (const capture of [...session.images].reverse()) {
    const figure = document.createElement('figure');
    figure.className = qualityClass(capture.quality);
    const image = document.createElement('img');
    const url = URL.createObjectURL(capture.blob);
    previewUrls.add(url);
    image.src = url;
    image.alt = `Bildruta, rotation ${capture.pass}`;
    const caption = document.createElement('figcaption');
    const qualityText = capture.quality ? describeSharpness(capture.quality) : 'Analys väntar';
    caption.textContent = `Rotation ${capture.pass} · ${qualityText}`;
    figure.append(image, caption);
    captures.append(figure);
  }
}

async function persistSession() {
  storageStatus.textContent = 'Sparar';
  await saveSession(session);
  storageStatus.textContent = 'Sparad lokalt';
}

async function analyseBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = bitmap.width;
    analysisCanvas.height = bitmap.height;
    analysisCanvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return analyseCanvasQuality(analysisCanvas);
  } catch (error) {
    console.error('Bildanalys misslyckades', error);
    return { sharpness: 'blurry', sharpnessScore: 0, error: error.message };
  }
}

async function addAnalysedCapture(capture) {
  const quality = await analyseBlob(capture.blob);
  session = addCapture(session, { ...capture, quality });
  session = { ...session, currentPass: Math.max(session.currentPass, capture.pass) };
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  placeholder.hidden = true;
  captureButton.disabled = false;
  newPassButton.disabled = false;
}

function canvasToBlob() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Kunde inte skapa bildfil')), 'image/jpeg', 0.9);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function captureImage() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob();
  const capture = createCapture({ blob, width: canvas.width, height: canvas.height, pass: session.currentPass });
  await addAnalysedCapture(capture);
  await persistSession();
  renderCaptures();
  refreshStatus();

  if (mode === 'capture' && remoteSession?.uploadToken) {
    workDetail.textContent = 'Laddar upp bildruta…';
    await relay.uploadCapture(remoteSession, capture);
    workDetail.textContent = 'Bildruta uppladdad';
  }
}

async function receiveCloudImages() {
  if (!remoteSession?.viewToken) return;
  const result = await relay.listImages(remoteSession);
  const missing = result.images.filter((image) => !session.images.some((item) => item.id === image.id));

  for (const imageInfo of missing) {
    const blob = await relay.downloadImage(remoteSession, imageInfo.id);
    const metadata = imageInfo.metadata ?? {};
    await addAnalysedCapture({
      id: imageInfo.id,
      pass: Number(metadata.pass) || 1,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
      capturedAt: metadata.capturedAt ?? imageInfo.uploadedAt,
      markerObservations: [],
      depthFrame: null,
      blob,
    });
  }

  if (missing.length) {
    await persistSession();
    renderCaptures();
    refreshStatus();
    showWorkScreen();
    workStatus.textContent = 'Telefon ansluten';
  }
  workDetail.textContent = `${result.images.length} bildrutor i molnet`;
}

function startPolling() {
  stopPolling();
  const poll = async () => {
    try { await receiveCloudImages(); }
    catch (error) { workDetail.textContent = `Synkfel: ${error.message}`; console.error(error); }
  };
  poll();
  pollTimer = window.setInterval(poll, 2000);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}

async function startNewPass() {
  session = nextPass(session);
  await persistSession();
  refreshStatus();
}

async function exportSession() {
  const images = await Promise.all(session.images.map(async ({ blob, ...metadata }) => ({
    ...metadata,
    imageDataUrl: await blobToDataUrl(blob),
  })));
  const file = new Blob([JSON.stringify({ ...session, images, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `timber-scan-${new Date().toISOString().replaceAll(':', '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function clearLocalSession() {
  await deleteSession(ACTIVE_SESSION_ID);
  session = createSession();
  if (scaleInput) scaleInput.value = '';
  renderCaptures();
  refreshStatus();
  storageStatus.textContent = 'Ny skanning';
}

async function resetSession() {
  if (!confirm('Rensa den lokala skanningen på den här enheten?')) return;
  await clearLocalSession();
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
  qrCode.replaceChildren();
  if (!pairingUrl || !remoteSession) return;
  new window.QRCode(qrCode, { text: pairingUrl, width: 220, height: 220 });
  const code = document.createElement('code');
  code.textContent = encodeCaptureCode(remoteSession);
  qrCode.append(code);
}

async function startViewerMode() {
  mode = 'viewer';
  showConnectionScreen();
  manualConnect.hidden = true;
  pairingHelp.textContent = 'Skapar en privat session i Cloudflare…';
  connectionStatus.textContent = 'Kontrollerar backend';
  await clearLocalSession();
  await relay.health();
  remoteSession = await relay.createSession();

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

async function startCaptureMode(cloudSession = null) {
  mode = 'capture';
  remoteSession = cloudSession;
  capturePanel.hidden = false;
  if (cloudSession) {
    sessionCode.value = encodeCaptureCode(cloudSession);
    workStatus.textContent = 'Kopplad till datorn';
    workDetail.textContent = 'Starta kameran för att börja skanna';
    showWorkScreen();
  } else {
    showConnectionScreen();
    manualConnect.hidden = false;
    qrCode.hidden = true;
    pairingHelp.textContent = 'Skriv sessionskoden från datorn.';
  }
}

async function connectCaptureCode() {
  remoteSession = decodeCaptureCode(sessionCode.value.trim());
  workStatus.textContent = 'Kopplad till datorn';
  workDetail.textContent = 'Starta kameran för att börja skanna';
  showWorkScreen();
}

async function initialise() {
  session = await loadSession(ACTIVE_SESSION_ID) ?? createSession();
  renderCaptures();
  refreshStatus();
  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'capture') {
    const sessionId = params.get('session');
    const uploadToken = params.get('uploadToken');
    await startCaptureMode(sessionId && uploadToken ? { sessionId, uploadToken } : null);
  }
}

viewerModeButton.addEventListener('click', () => startViewerMode().catch((error) => {
  connectionStatus.textContent = `Kunde inte skapa session: ${error.message}`;
}));
captureModeButton.addEventListener('click', () => startCaptureMode().catch(console.error));
connectButton.addEventListener('click', () => connectCaptureCode().catch((error) => { connectionStatus.textContent = error.message; }));
showPairingButton.addEventListener('click', () => { renderPairingCode(); showConnectionScreen(); });
startButton.addEventListener('click', () => startCamera().then(() => { startButton.disabled = true; }).catch((error) => {
  placeholder.textContent = `Kameran kunde inte startas: ${error.message}`;
}));
captureButton.addEventListener('click', () => captureImage().catch((error) => { workDetail.textContent = error.message; }));
newPassButton.addEventListener('click', () => startNewPass().catch(console.error));
exportButton.addEventListener('click', () => exportSession().catch(console.error));
resetButton.addEventListener('click', () => resetSession().catch(console.error));
scaleInput.addEventListener('change', async () => {
  const value = Number(scaleInput.value);
  session = setScaleReference(session, value > 0 ? value : null);
  await persistSession();
});
window.addEventListener('pagehide', () => {
  stream?.getTracks().forEach((track) => track.stop());
  stopPolling();
  clearPreviewUrls();
});

initialise().catch(console.error);