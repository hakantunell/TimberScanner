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

const video = document.querySelector('#camera');
const canvas = document.querySelector('#snapshot');
const placeholder = document.querySelector('#camera-placeholder');
const captures = document.querySelector('#captures');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const exportButton = document.querySelector('#export');
const resetButton = document.querySelector('#reset');
const scaleInput = document.querySelector('#scale-mm');
const imageCount = document.querySelector('#image-count');
const passCount = document.querySelector('#pass-count');
const depthSource = document.querySelector('#depth-source');
const storageStatus = document.querySelector('#storage-status');
const rolePicker = document.querySelector('#role-picker');
const viewerModeButton = document.querySelector('#viewer-mode');
const captureModeButton = document.querySelector('#capture-mode');
const pairingPanel = document.querySelector('#pairing-panel');
const pairingHelp = document.querySelector('#pairing-help');
const qrCode = document.querySelector('#qr-code');
const sessionCode = document.querySelector('#peer-code');
const sessionLabel = document.querySelector('#peer-label');
const connectButton = document.querySelector('#connect-peer');
const connectionStatus = document.querySelector('#connection-status');
const capturePanel = document.querySelector('#capture-panel');

const relay = new CloudRelay();
const previewUrls = new Set();
let session = createSession();
let stream = null;
let mode = null;
let remoteSession = null;
let pollTimer = null;

function refreshStatus() {
  imageCount.textContent = String(session.images.length);
  passCount.textContent = String(session.currentPass);
  depthSource.textContent = session.depthSource === 'rgb-only' ? 'Endast RGB' : session.depthSource;
  exportButton.disabled = session.images.length === 0;
}

function clearPreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
}

function renderCaptures() {
  clearPreviewUrls();
  captures.replaceChildren();
  for (const [index, capture] of [...session.images].reverse().entries()) {
    const figure = document.createElement('figure');
    const image = document.createElement('img');
    const url = URL.createObjectURL(capture.blob);
    previewUrls.add(url);
    image.src = url;
    image.alt = `Bild ${session.images.length - index}, rotation ${capture.pass}`;
    const caption = document.createElement('figcaption');
    caption.textContent = `Rotation ${capture.pass} · ${capture.width}×${capture.height}`;
    figure.append(image, caption);
    captures.append(figure);
  }
}

async function persistSession() {
  storageStatus.textContent = 'Sparar';
  await saveSession(session);
  storageStatus.textContent = 'Sparad lokalt';
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
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
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Kunde inte skapa bildfil')),
      'image/jpeg',
      0.9,
    );
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
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await canvasToBlob();
  const capture = createCapture({
    blob,
    width: canvas.width,
    height: canvas.height,
    pass: session.currentPass,
  });
  session = addCapture(session, capture);
  await persistSession();
  renderCaptures();
  refreshStatus();

  if (mode === 'capture' && remoteSession?.uploadToken) {
    connectionStatus.textContent = 'Laddar upp bild';
    try {
      await relay.uploadCapture(remoteSession, capture);
      connectionStatus.textContent = 'Bild uppladdad';
    } catch (error) {
      connectionStatus.textContent = `Uppladdning misslyckades: ${error.message}`;
      console.error(error);
    }
  }
}

async function receiveCloudImages() {
  if (!remoteSession?.viewToken) return;
  const result = await relay.listImages(remoteSession);
  const missing = result.images.filter((image) => !session.images.some((item) => item.id === image.id));

  for (const imageInfo of missing) {
    const blob = await relay.downloadImage(remoteSession, imageInfo.id);
    const metadata = imageInfo.metadata ?? {};
    const capture = {
      id: imageInfo.id,
      pass: Number(metadata.pass) || 1,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
      capturedAt: metadata.capturedAt ?? imageInfo.uploadedAt,
      markerObservations: [],
      depthFrame: null,
      blob,
    };
    session = addCapture(session, capture);
    session = { ...session, currentPass: Math.max(session.currentPass, capture.pass) };
  }

  if (missing.length) {
    await persistSession();
    renderCaptures();
    refreshStatus();
  }
  connectionStatus.textContent = `Ansluten · ${result.images.length} bilder i molnet`;
}

function startPolling() {
  stopPolling();
  const poll = async () => {
    try {
      await receiveCloudImages();
    } catch (error) {
      connectionStatus.textContent = `Synkfel: ${error.message}`;
      console.error(error);
    }
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
  storageStatus.textContent = 'Exporterar';
  const images = await Promise.all(session.images.map(async ({ blob, ...metadata }) => ({
    ...metadata,
    imageDataUrl: await blobToDataUrl(blob),
  })));
  const payload = { ...session, images, exportedAt: new Date().toISOString() };
  const file = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `timber-scan-${new Date().toISOString().replaceAll(':', '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  storageStatus.textContent = 'Sparad lokalt';
}

async function resetSession() {
  if (!confirm('Ta bort alla lokala bilder i den aktiva skanningen?')) return;
  await deleteSession(ACTIVE_SESSION_ID);
  session = createSession();
  scaleInput.value = '';
  renderCaptures();
  refreshStatus();
  storageStatus.textContent = 'Ny session';
}

function showMode(selectedMode) {
  mode = selectedMode;
  rolePicker.hidden = true;
  pairingPanel.hidden = false;
  capturePanel.hidden = selectedMode !== 'capture';
  qrCode.replaceChildren();
}

function encodeCaptureCode(value) {
  return `${value.sessionId}.${value.uploadToken}`;
}

function decodeCaptureCode(code) {
  const separator = code.indexOf('.');
  if (separator < 1) throw new Error('Ogiltig sessionskod');
  return {
    sessionId: code.slice(0, separator),
    uploadToken: code.slice(separator + 1),
  };
}

async function startViewerMode() {
  showMode('viewer');
  sessionLabel.hidden = true;
  sessionCode.hidden = true;
  connectButton.hidden = true;
  pairingHelp.textContent = 'Skapar en privat session i Cloudflare…';
  connectionStatus.textContent = 'Kontrollerar backend';

  await relay.health();
  remoteSession = await relay.createSession();
  sessionStorage.setItem('timber-view-session', JSON.stringify(remoteSession));

  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('mode', 'capture');
  url.searchParams.set('session', remoteSession.sessionId);
  url.searchParams.set('uploadToken', remoteSession.uploadToken);
  new window.QRCode(qrCode, { text: url.toString(), width: 220, height: 220 });

  const code = document.createElement('code');
  code.textContent = encodeCaptureCode(remoteSession);
  qrCode.append(code);
  pairingHelp.textContent = `Skanna QR-koden. Sessionen raderas automatiskt ${new Date(remoteSession.expiresAt).toLocaleString('sv-SE')}.`;
  startPolling();
}

async function startCaptureMode(cloudSession = null) {
  showMode('capture');
  sessionLabel.hidden = false;
  sessionCode.hidden = false;
  connectButton.hidden = false;
  pairingHelp.textContent = cloudSession
    ? 'Telefonen är kopplad till molnsessionen. Starta kameran.'
    : 'Skanna QR-koden från datorn eller skriv sessionskoden manuellt.';

  if (cloudSession) {
    remoteSession = cloudSession;
    sessionCode.value = encodeCaptureCode(cloudSession);
    connectionStatus.textContent = 'Klar för uppladdning';
  }
}

async function connectCaptureCode() {
  remoteSession = decodeCaptureCode(sessionCode.value.trim());
  connectionStatus.textContent = 'Klar för uppladdning';
}

async function initialise() {
  try {
    session = await loadSession(ACTIVE_SESSION_ID) ?? createSession();
    scaleInput.value = session.scaleReferenceMm ?? '';
    renderCaptures();
    refreshStatus();
    storageStatus.textContent = session.images.length ? 'Återställd' : 'Klar';

    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'capture') {
      const sessionId = params.get('session');
      const uploadToken = params.get('uploadToken');
      await startCaptureMode(sessionId && uploadToken ? { sessionId, uploadToken } : null);
    }
  } catch (error) {
    storageStatus.textContent = 'Startfel';
    connectionStatus.textContent = error.message;
    console.error(error);
  }
}

viewerModeButton.addEventListener('click', () => startViewerMode().catch((error) => {
  connectionStatus.textContent = `Kunde inte skapa session: ${error.message}`;
  console.error(error);
}));
captureModeButton.addEventListener('click', () => startCaptureMode().catch(console.error));
connectButton.addEventListener('click', () => connectCaptureCode().catch((error) => {
  connectionStatus.textContent = error.message;
}));
startButton.addEventListener('click', async () => {
  try {
    await startCamera();
    startButton.disabled = true;
  } catch (error) {
    placeholder.hidden = false;
    placeholder.textContent = `Kameran kunde inte startas: ${error.message}`;
  }
});
captureButton.addEventListener('click', () => captureImage().catch(console.error));
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

initialise();
