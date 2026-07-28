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

async function activateCamera(sourceEvent) {
  const now = Date.now();
  if (starting || now - lastActivationAt < 700) return;
  lastActivationAt = now;
  starting = true;
  sourceEvent?.preventDefault?.();
  sourceEvent?.stopImmediatePropagation?.();

  if (startButton) startButton.disabled = true;
  setStatus(`Startkommando mottaget (${sourceEvent?.type ?? 'program'})`);
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

function isCameraStartTarget(event) {
  const target = event.target instanceof Element ? event.target.closest('#start-camera') : null;
  return Boolean(target);
}

// Delegerad lyssning fungerar även i iOS när vyn visas efter att modulen laddats.
for (const eventName of ['pointerup', 'touchend', 'click']) {
  document.addEventListener(eventName, (event) => {
    if (!isCameraStartTarget(event)) return;
    activateCamera(event);
  }, { capture: true, passive: false });
}

window.TimberCamera = Object.freeze({
  start: () => activateCamera(),
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
  setStatus(`Kameramodul redo · säker anslutning: ${window.isSecureContext ? 'ja' : 'nej'} · iOS-säker knapphantering aktiv`);
}

window.addEventListener('pagehide', () => window.TimberCamera?.stop());
