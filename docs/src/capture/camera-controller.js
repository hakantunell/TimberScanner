const video = document.querySelector('#camera');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const placeholder = document.querySelector('#camera-placeholder');
const status = document.querySelector('#camera-status');

let starting = false;
let lastActivationAt = 0;

function setStatus(message) {
  if (status) status.textContent = message;
  console.info(`[camera] ${message}`);
}

function describeCameraError(error) {
  const name = error?.name ?? 'Error';
  if (!window.isSecureContext) return 'Kameran kräver HTTPS. Öppna appen via https://timberscanner.tunell.org.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Kameraåtkomst nekades. Tillåt kamera för timberscanner.tunell.org i webbläsarens webbplatsinställningar och försök igen.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Ingen kamera hittades på enheten.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Kameran används av en annan app eller kunde inte öppnas. Stäng andra kameraappar och försök igen.';
  if (name === 'OverconstrainedError') return 'Telefonen accepterade inte önskad kameraupplösning.';
  if (name === 'AbortError') return 'Kamerastarten avbröts. Försök igen.';
  return `${name}: ${error?.message || 'Okänt kamerafel'}`;
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Webbläsaren saknar stöd för kameraåtkomst via getUserMedia.');
  }

  setStatus('Begär kameraåtkomst…');
  let mediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch (firstError) {
    if (firstError?.name !== 'OverconstrainedError') throw firstError;
    setStatus('Försöker med telefonens standardkamera…');
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }

  window.__timberCameraStream?.getTracks?.().forEach((track) => track.stop());
  window.__timberCameraStream = mediaStream;
  video.srcObject = mediaStream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');

  setStatus('Kameran öppnades – startar förhandsvisning…');
  await video.play();

  const deadline = Date.now() + 8000;
  while ((!video.videoWidth || !video.videoHeight) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  if (!video.videoWidth || !video.videoHeight) throw new Error('Kameran öppnades men gav ingen bild.');

  if (placeholder) placeholder.hidden = true;
  if (captureButton) captureButton.disabled = false;
  if (newPassButton) newPassButton.disabled = false;
  if (startButton) startButton.disabled = true;
  setStatus(`Kamera klar · ${video.videoWidth}×${video.videoHeight}`);
  window.dispatchEvent(new CustomEvent('timberscanner:camera-ready', {
    detail: { width: video.videoWidth, height: video.videoHeight },
  }));
}

async function activateCamera(source = 'program', event = null) {
  event?.preventDefault?.();
  const now = Date.now();
  if (starting || now - lastActivationAt < 500) return;
  lastActivationAt = now;
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
    console.error('[camera] Kunde inte starta kameran', error);
  } finally {
    starting = false;
  }
}

window.startTimberCamera = () => activateCamera('global');
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

if (startButton && video) {
  // onclick-egenskapen fungerar även när inline-script blockeras av CSP.
  startButton.removeAttribute('onclick');
  startButton.onclick = (event) => activateCamera('onclick-property', event);
  startButton.addEventListener('touchend', (event) => activateCamera('touchend-reserv', event), { passive: false });
  setStatus(`Kameramodul v20260728-4 redo · säker anslutning: ${window.isSecureContext ? 'ja' : 'nej'} · direktbindning aktiv`);
}

window.addEventListener('pagehide', () => window.TimberCamera?.stop());
