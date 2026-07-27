import {
  ACTIVE_SESSION_ID,
  addCapture,
  createCapture,
  createSession,
  nextPass,
  setScaleReference,
} from './src/scanning/scan-session.js';
import { deleteSession, loadSession, saveSession } from './src/storage/session-store.js';
import { PeerTransfer } from './src/transfer/peer-transfer.js';

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
const peerCode = document.querySelector('#peer-code');
const peerLabel = document.querySelector('#peer-label');
const connectPeerButton = document.querySelector('#connect-peer');
const connectionStatus = document.querySelector('#connection-status');
const capturePanel = document.querySelector('#capture-panel');

let session = createSession();
let stream = null;
let mode = null;
const previewUrls = new Set();
const transfer = new PeerTransfer({
  onStatus: (status) => { connectionStatus.textContent = status; },
  onCapture: (remoteCapture) => receiveRemoteCapture(remoteCapture).catch(console.error),
});

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

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
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

  if (transfer.isConnected()) {
    connectionStatus.textContent = 'Skickar bild';
    transfer.sendCapture({
      id: capture.id,
      pass: capture.pass,
      width: capture.width,
      height: capture.height,
      capturedAt: capture.capturedAt,
      imageDataUrl: await blobToDataUrl(blob),
    });
    connectionStatus.textContent = 'Ansluten';
  }
}

async function receiveRemoteCapture(remote) {
  if (!remote?.imageDataUrl) return;
  const blob = await dataUrlToBlob(remote.imageDataUrl);
  const capture = {
    id: remote.id,
    pass: remote.pass,
    width: remote.width,
    height: remote.height,
    capturedAt: remote.capturedAt,
    markerObservations: [],
    depthFrame: null,
    blob,
  };
  if (session.images.some((item) => item.id === capture.id)) return;
  session = addCapture(session, capture);
  session = { ...session, currentPass: Math.max(session.currentPass, capture.pass) };
  await persistSession();
  renderCaptures();
  refreshStatus();
}

async function startNewPass() {
  session = nextPass(session);
  await persistSession();
  refreshStatus();
  transfer.sendState({ currentPass: session.currentPass });
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
  if (!confirm('Ta bort alla bilder i den aktiva skanningen?')) return;
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

async function startViewerMode() {
  showMode('viewer');
  pairingHelp.textContent = 'Skanna QR-koden med telefonens kamera. Bilderna visas här när de tas.';
  peerLabel.hidden = true;
  peerCode.hidden = true;
  connectPeerButton.hidden = true;
  const id = await transfer.startViewer();
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('mode', 'capture');
  url.searchParams.set('peer', id);
  new window.QRCode(qrCode, { text: url.toString(), width: 220, height: 220 });
  const code = document.createElement('code');
  code.textContent = id;
  qrCode.append(code);
}

async function startCaptureMode(viewerId = '') {
  showMode('capture');
  pairingHelp.textContent = viewerId
    ? 'Ansluter automatiskt till datorn.'
    : 'Skriv parkopplingskoden från datorn eller öppna QR-länken.';
  peerLabel.hidden = false;
  peerCode.hidden = false;
  connectPeerButton.hidden = false;
  peerCode.value = viewerId;
  if (viewerId) await transfer.connectToViewer(viewerId);
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
      await startCaptureMode(params.get('peer') ?? '');
    }
  } catch (error) {
    storageStatus.textContent = 'Startfel';
    console.error(error);
  }
}

viewerModeButton.addEventListener('click', () => startViewerMode().catch(console.error));
captureModeButton.addEventListener('click', () => startCaptureMode().catch(console.error));
connectPeerButton.addEventListener('click', () => transfer.connectToViewer(peerCode.value.trim()).catch(console.error));
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
  transfer.dispose();
  clearPreviewUrls();
});

initialise();
