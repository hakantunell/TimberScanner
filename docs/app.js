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

const relay = new CloudRelay();
const previewUrls = new Set();
const MAX_PREVIEWS = 8;
const POLL_DELAY_MS = 1500;
let session = createSession();
let stream = null;
let mode = null;
let remoteSession = null;
let pollTimer = null;
let pollGeneration = 0;
let pairingUrl = null;
let cloudRevision = null;

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
  imageCount.textContent = String(session.images.length);
  passCount.textContent = String(session.currentPass);
  analysisCount.textContent = String(session.images.filter((item) => item.quality).length);
  exportButton.disabled = session.images.length === 0;
}

function clearPreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
}

function renderCaptures() {
  clearPreviewUrls();
  captures.replaceChildren();
  const recent = [...session.images].reverse().slice(0, MAX_PREVIEWS);
  for (const capture of recent) {
    const figure = document.createElement('figure');
    figure.className = capture.quality ? `quality-${capture.quality.sharpness}` : 'quality-pending';
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.decoding = 'async';
    const url = URL.createObjectURL(capture.blob);
    previewUrls.add(url);
    image.src = url;
    image.alt = `Bildruta, rotation ${capture.pass}`;
    const caption = document.createElement('figcaption');
    caption.textContent = `Rotation ${capture.pass} · ${capture.quality ? describeSharpness(capture.quality) : 'Analys väntar'}`;
    figure.append(image, caption);
    captures.append(figure);
  }
}

async function persistSession() {
  storageStatus.textContent = 'Sparar';
  await saveSession(session);
  storageStatus.textContent = 'Sparad lokalt';
}

async function clearLocalSession() {
  await deleteSession(ACTIVE_SESSION_ID);
  session = createSession();
  scaleInput.value = '';
  renderCaptures();
  refreshStatus();
  storageStatus.textContent = 'Ny skanning';
}

async function analyseBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / bitmap.width);
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = Math.max(1, Math.round(bitmap.width * scale));
    analysisCanvas.height = Math.max(1, Math.round(bitmap.height * scale));
    analysisCanvas.getContext('2d').drawImage(bitmap, 0, 0, analysisCanvas.width, analysisCanvas.height);
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

function addUnanalysedCapture(capture) {
  session = addCapture(session, capture);
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

async function replaceWithCloudImages(result) {
  const cloudIds = new Set(result.images.map((image) => image.id));
  const removedLocally = session.images.some((image) => !cloudIds.has(image.id));
  if (removedLocally) {
    session = { ...session, images: session.images.filter((image) => cloudIds.has(image.id)) };
  }

  const localIds = new Set(session.images.map((image) => image.id));
  const missing = result.images.filter((image) => !localIds.has(image.id));
  let received = 0;
  for (const imageInfo of missing) {
    workDetail.textContent = `Hämtar bilder ${session.images.length + 1}/${result.images.length}…`;
    const blob = await relay.downloadImage(remoteSession, imageInfo.id);
    const metadata = imageInfo.metadata ?? {};
    addUnanalysedCapture({
      id: imageInfo.id,
      pass: Number(metadata.pass) || 1,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
      capturedAt: metadata.capturedAt ?? imageInfo.uploadedAt,
      markerObservations: [],
      depthFrame: null,
      blob,
    });
    localIds.add(imageInfo.id);
    received += 1;
    refreshStatus();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  if (removedLocally || received) {
    await persistSession();
    renderCaptures();
    refreshStatus();
  }
  return received;
}

async function receiveCloudState() {
  if (!remoteSession?.viewToken) return;
  const result = await relay.listImages(remoteSession);
  const revision = result.live?.revision ?? 0;
  if (cloudRevision !== null && revision !== cloudRevision && result.images.length === 0) {
    await clearLocalSession();
  }
  cloudRevision = revision;
  await replaceWithCloudImages(result);

  if (result.live?.connected) {
    showWorkScreen();
    workStatus.textContent = 'Telefon ansluten';
    workDetail.textContent = `${session.images.length}/${result.images.length} bildrutor mottagna`;
  } else {
    connectionStatus.textContent = 'Väntar på telefonen';
  }
}

function startPolling() {
  stopPolling();
  const generation = pollGeneration;
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      await receiveCloudState();
    } catch (error) {
      const target = workScreen.hidden ? connectionStatus : workDetail;
      target.textContent = `Synkfel: ${error.message}`;
      console.error(error);
    } finally {
      if (generation === pollGeneration) pollTimer = window.setTimeout(poll, POLL_DELAY_MS);
    }
  };
  poll();
}

function stopPolling() {
  pollGeneration += 1;
  if (pollTimer) window.clearTimeout(pollTimer);
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

async function resetSession() {
  if (!confirm('Rensa hela skanningen på både telefonen, datorn och i molnet?')) return;
  workDetail.textContent = 'Rensar skanningen…';
  if (remoteSession?.sessionId && (remoteSession.uploadToken || remoteSession.viewToken)) {
    await relay.clearImages(remoteSession);
  }
  await clearLocalSession();
  workDetail.textContent = 'Skanningen är rensad';
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
  showConnectionScreen();
  qrCode.hidden = false;
  manualConnect.hidden = true;
  pairingHelp.textContent = 'Skapar en privat session i Cloudflare…';
  connectionStatus.textContent = 'Kontrollerar backend';
  await clearLocalSession();
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
  if (cloudSession) {
    await activateCaptureConnection(cloudSession);
  } else {
    showConnectionScreen();
    manualConnect.hidden = false;
    qrCode.hidden = true;
    pairingHelp.textContent = 'Skriv sessionskoden från datorn.';
    connectionStatus.textContent = 'Inte ansluten';
  }
}

async function connectCaptureCode() {
  await activateCaptureConnection(decodeCaptureCode(sessionCode.value.trim()));
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
  } else {
    showRolePicker();
  }
}

viewerModeButton.addEventListener('click', () => startViewerMode().catch((error) => {
  showConnectionScreen();
  connectionStatus.textContent = `Kunde inte skapa session: ${error.message}`;
  console.error(error);
}));
captureModeButton.addEventListener('click', () => startCaptureMode().catch((error) => {
  showConnectionScreen();
  connectionStatus.textContent = error.message;
  console.error(error);
}));
connectButton.addEventListener('click', () => connectCaptureCode().catch((error) => { connectionStatus.textContent = error.message; }));
showPairingButton.addEventListener('click', () => { renderPairingCode(); showConnectionScreen(); });
startButton.addEventListener('click', () => startCamera().then(() => { startButton.disabled = true; }).catch((error) => {
  placeholder.textContent = `Kameran kunde inte startas: ${error.message}`;
}));
captureButton.addEventListener('click', () => captureImage().catch((error) => { workDetail.textContent = error.message; }));
newPassButton.addEventListener('click', () => startNewPass().catch(console.error));
exportButton.addEventListener('click', () => exportSession().catch(console.error));
resetButton.addEventListener('click', () => resetSession().catch((error) => { workDetail.textContent = `Kunde inte rensa: ${error.message}`; }));
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

initialise().catch((error) => {
  console.error(error);
  showRolePicker();
  alert(`TimberScanner kunde inte starta: ${error.message}`);
});