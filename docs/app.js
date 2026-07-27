import {
  ACTIVE_SESSION_ID,
  addCapture,
  createCapture,
  createSession,
  nextPass,
  setScaleReference,
} from './src/scanning/scan-session.js';
import { deleteSession, loadSession, saveSession } from './src/storage/session-store.js';

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

let session = createSession();
let stream = null;
const previewUrls = new Set();

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
      0.92,
    );
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
}

async function startNewPass() {
  session = nextPass(session);
  await persistSession();
  refreshStatus();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function exportSession() {
  storageStatus.textContent = 'Exporterar';
  const images = await Promise.all(session.images.map(async ({ blob, ...metadata }) => ({
    ...metadata,
    imageDataUrl: await blobToDataUrl(blob),
  })));
  const payload = {
    ...session,
    images,
    exportedAt: new Date().toISOString(),
  };
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

async function initialise() {
  try {
    session = await loadSession(ACTIVE_SESSION_ID) ?? createSession();
    scaleInput.value = session.scaleReferenceMm ?? '';
    renderCaptures();
    refreshStatus();
    storageStatus.textContent = session.images.length ? 'Återställd' : 'Klar';
  } catch (error) {
    storageStatus.textContent = 'Lagringsfel';
    console.error(error);
  }
}

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
  clearPreviewUrls();
});

initialise();
