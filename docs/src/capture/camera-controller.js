const video = document.querySelector('#camera');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const placeholder = document.querySelector('#camera-placeholder');
const status = document.querySelector('#camera-status');

let starting = false;

function setStatus(message) {
  if (status) status.textContent = message;
  console.info(`[camera] ${message}`);
}

function describeCameraError(error) {
  const name = error?.name ?? 'Error';
  if (!window.isSecureContext) return 'Kameran kräver HTTPS.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Kameraåtkomst nekades. Öppna Safari-inställningar för timberscanner.tunell.org och välj Tillåt kamera.';
  }
  if (name === 'NotFoundError') return 'Ingen kamera hittades.';
  if (name === 'NotReadableError') return 'Kameran används av en annan app eller kunde inte öppnas.';
  if (name === 'CameraTimeoutError') return 'Safari svarade inte på kameraförfrågan inom 12 sekunder.';
  return `${name}: ${error?.message || 'Okänt kamerafel'}`;
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => {
      const error = new Error('Kameraförfrågan tog för lång tid');
      error.name = 'CameraTimeoutError';
      reject(error);
    }, milliseconds)),
  ]);
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Webbläsaren saknar stöd för getUserMedia.');
  }

  setStatus('Begär kameraåtkomst från Safari…');
  const mediaStream = await withTimeout(
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    }),
    12000,
  );

  window.__timberCameraStream?.getTracks?.().forEach((track) => track.stop());
  window.__timberCameraStream = mediaStream;
  video.srcObject = mediaStream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');

  setStatus('Kameraåtkomst godkänd – startar bild…');
  await video.play();

  const deadline = Date.now() + 8000;
  while ((!video.videoWidth || !video.videoHeight) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  if (!video.videoWidth || !video.videoHeight) throw new Error('Kameran öppnades men gav ingen bild.');

  if (placeholder) placeholder.hidden = true;
  if (captureButton) captureButton.disabled = false;
  if (newPassButton) newPassButton.disabled = false;
  setStatus(`Kamera klar · ${video.videoWidth}×${video.videoHeight}`);
  window.dispatchEvent(new CustomEvent('timberscanner:camera-ready', {
    detail: { width: video.videoWidth, height: video.videoHeight },
  }));
}

async function activateCamera(source = 'program') {
  if (starting) return;
  starting = true;
  if (startButton) startButton.disabled = true;
  setStatus(`Startkommando mottaget (${source})`);

  try {
    await requestCamera();
  } catch (error) {
    if (startButton) startButton.disabled = false;
    const message = describeCameraError(error);
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = message;
    }
    setStatus(message);
    console.error('[camera]', error);
  } finally {
    starting = false;
  }
}

window.TimberCamera = Object.freeze({
  start: () => activateCamera('api'),
  isReady: () => Boolean(video?.videoWidth && video?.videoHeight),
  getStream: () => window.__timberCameraStream ?? null,
  stop: () => {
    window.__timberCameraStream?.getTracks?.().forEach((track) => track.stop());
    window.__timberCameraStream = null;
    if (video) video.srcObject = null;
    if (startButton) startButton.disabled = false;
    if (captureButton) captureButton.disabled = true;
    if (newPassButton) newPassButton.disabled = true;
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = 'Kameran är inte startad';
    }
    setStatus('Kameran stoppad');
  },
});

setStatus(`Kameramodul v20260728-6 redo · endast telefonkod laddad · säker anslutning: ${window.isSecureContext ? 'ja' : 'nej'}`);
window.addEventListener('pagehide', () => window.TimberCamera?.stop());
