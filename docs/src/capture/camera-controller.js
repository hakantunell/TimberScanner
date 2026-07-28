const video = document.querySelector('#camera');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const placeholder = document.querySelector('#camera-placeholder');
const status = document.querySelector('#camera-status');

let starting = false;

function isUsbMode() {
  return document.body.dataset.cameraSource === 'usb';
}

function setStatus(message) {
  if (status) status.textContent = message;
  console.info(`[camera] ${message}`);
}

function describeCameraError(error) {
  const name = error?.name ?? 'Error';
  if (!window.isSecureContext) return 'Kameran kräver HTTPS.';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Kameraåtkomst nekades. Tillåt kamera för timberscanner.tunell.org i webbläsaren.';
  }
  if (name === 'NotFoundError') return 'Ingen kamera hittades.';
  if (name === 'NotReadableError') return 'Kameran används av en annan app eller kunde inte öppnas.';
  if (name === 'CameraTimeoutError') return 'Webbläsaren svarade inte på kameraförfrågan inom 12 sekunder.';
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

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function preferredUsbDevice(devices) {
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const externalPattern = /(usb|logitech|c920|c922|brio|webcam|external)/i;
  const integratedPattern = /(integrated|inbyggd|facetime|front|internal)/i;
  return cameras.find((device) => externalPattern.test(device.label))
    ?? cameras.find((device) => device.label && !integratedPattern.test(device.label))
    ?? null;
}

async function openInitialStream() {
  const videoConstraints = isUsbMode()
    ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
    : { facingMode: { ideal: 'environment' } };
  return withTimeout(
    navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false }),
    12000,
  );
}

async function preferExternalUsbCamera(initialStream) {
  if (!isUsbMode() || !navigator.mediaDevices.enumerateDevices) return initialStream;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const preferred = preferredUsbDevice(devices);
  const currentId = initialStream.getVideoTracks()[0]?.getSettings?.().deviceId;
  if (!preferred?.deviceId || preferred.deviceId === currentId) return initialStream;

  setStatus(`Byter till USB-kamera: ${preferred.label || 'extern kamera'}…`);
  stopStream(initialStream);
  return withTimeout(
    navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: preferred.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    }),
    12000,
  );
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Webbläsaren saknar stöd för getUserMedia.');

  setStatus(isUsbMode() ? 'Begär åtkomst till USB-webbkamera…' : 'Begär kameraåtkomst…');
  let mediaStream = await openInitialStream();
  mediaStream = await preferExternalUsbCamera(mediaStream);

  stopStream(window.__timberCameraStream);
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

  const track = mediaStream.getVideoTracks()[0];
  const label = track?.label ? ` · ${track.label}` : '';
  if (placeholder) placeholder.hidden = true;
  if (captureButton) captureButton.disabled = false;
  if (newPassButton) newPassButton.disabled = false;
  setStatus(`Kamera klar · ${video.videoWidth}×${video.videoHeight}${label}`);
  window.dispatchEvent(new CustomEvent('timberscanner:camera-ready', {
    detail: { width: video.videoWidth, height: video.videoHeight, label: track?.label ?? '' },
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
    stopStream(window.__timberCameraStream);
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

setStatus(`Kameramodul v20260728-26 redo · källa: ${isUsbMode() ? 'USB' : 'mobil'} · säker anslutning: ${window.isSecureContext ? 'ja' : 'nej'}`);
window.addEventListener('pagehide', () => window.TimberCamera?.stop());
