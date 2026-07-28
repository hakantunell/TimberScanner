import {
  addCapture,
  createCapture,
  createSession,
  nextPass,
  setScaleReference,
} from '../scanning/scan-session.js';

const required = (id) => {
  const element = document.querySelector(`#${id}`);
  if (!element) throw new Error(`USB-appen saknar elementet #${id}`);
  return element;
};

const video = required('camera');
const snapshot = required('snapshot');
const captures = required('captures');
const captureButton = required('capture');
const newPassButton = required('new-pass');
const resetButton = required('reset');
const exportButton = required('export');
const scaleInput = required('scale-mm');
const imageCount = required('image-count');
const passCount = required('pass-count');
const storageStatus = required('storage-status');
const rolePicker = required('role-picker');
const connectionScreen = required('connection-screen');
const workScreen = required('work-screen');
const capturePanel = required('capture-panel');
const workStatus = required('work-status');
const workDetail = required('work-detail');
const showPairingButton = required('show-pairing');

let session = createSession();
const previewUrls = new Set();

function refreshStatus() {
  imageCount.textContent = String(session.images.length);
  passCount.textContent = String(session.currentPass);
  storageStatus.textContent = 'Lokalt i minnet';
  exportButton.disabled = session.images.length === 0;
  newPassButton.disabled = session.images.length === 0;
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
  image.loading = 'eager';
  image.decoding = 'async';
  const url = URL.createObjectURL(capture.blob);
  previewUrls.add(url);
  image.src = url;
  image.alt = `USB-bild ${session.images.length}, rotation ${capture.pass}`;

  const caption = document.createElement('figcaption');
  caption.textContent = `Bild ${session.images.length} · ${(capture.blob.size / 1024).toFixed(0)} kB · Analys väntar`;
  figure.append(image, caption);
  captures.prepend(figure);

  window.dispatchEvent(new CustomEvent('timberscanner:local-capture', {
    detail: { captureId: capture.id, count: session.images.length },
  }));
}

function canvasToBlob() {
  return new Promise((resolve, reject) => {
    snapshot.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Kunde inte skapa bildfil')),
      'image/jpeg',
      0.92,
    );
  });
}

async function captureImage() {
  if (!video.videoWidth || !video.videoHeight) throw new Error('USB-kameran är inte startad');
  snapshot.width = video.videoWidth;
  snapshot.height = video.videoHeight;
  snapshot.getContext('2d', { alpha: false }).drawImage(video, 0, 0, snapshot.width, snapshot.height);
  const blob = await canvasToBlob();
  const capture = createCapture({
    blob,
    width: snapshot.width,
    height: snapshot.height,
    pass: session.currentPass,
  });
  session = addCapture(session, capture);
  appendCapture(capture);
  refreshStatus();
  workDetail.textContent = `${session.images.length} lokala bildrutor · analysen körs på datorn`;
}

function resetSession() {
  if (session.images.length && !window.confirm('Rensa den lokala USB-skanningen?')) return;
  session = createSession();
  scaleInput.value = '';
  clearPreviews();
  refreshStatus();
  workDetail.textContent = 'USB-skanningen är rensad';
  window.dispatchEvent(new CustomEvent('timberscanner:scan-reset'));
}

function initialiseUsbMode() {
  rolePicker.hidden = true;
  connectionScreen.hidden = true;
  workScreen.hidden = false;
  capturePanel.hidden = false;
  showPairingButton.hidden = true;
  workStatus.textContent = 'USB-webbkamera · lokalt läge';
  workDetail.textContent = 'Starta kameran och rikta den mot testobjektet';
  document.body.dataset.cameraSource = 'usb';
  refreshStatus();
}

captureButton.addEventListener('click', () => {
  captureImage().catch((error) => { workDetail.textContent = error.message; });
});
newPassButton.addEventListener('click', () => {
  session = nextPass(session);
  refreshStatus();
  workDetail.textContent = `Rotation ${session.currentPass} startad`;
});
resetButton.addEventListener('click', resetSession);
scaleInput.addEventListener('change', () => {
  const value = Number(scaleInput.value);
  session = setScaleReference(session, value > 0 ? value : null);
});
exportButton.addEventListener('click', () => {
  workDetail.textContent = 'Export kopplas in när analysformatet är fastställt';
});

window.addEventListener('pagehide', clearPreviews);
initialiseUsbMode();
