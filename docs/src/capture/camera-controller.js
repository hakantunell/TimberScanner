const video = document.querySelector('#camera');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const placeholder = document.querySelector('#camera-placeholder');
const status = document.querySelector('#camera-status');
const deviceSelect = document.querySelector('#camera-device');
const resolutionSelect = document.querySelector('#camera-resolution');
const selectionHelp = document.querySelector('#camera-selection-help');

const DEVICE_STORAGE_KEY = 'timberscanner.camera.deviceId';
const RESOLUTION_STORAGE_KEY = 'timberscanner.camera.resolution';
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
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Den valda kameran eller upplösningen kunde inte öppnas.';
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

function selectedResolution() {
  const saved = localStorage.getItem(RESOLUTION_STORAGE_KEY);
  if (resolutionSelect && saved && [...resolutionSelect.options].some((option) => option.value === saved)) {
    resolutionSelect.value = saved;
  }
  const [width, height] = (resolutionSelect?.value || saved || '1280x720').split('x').map(Number);
  return {
    width: Number.isFinite(width) ? width : 1280,
    height: Number.isFinite(height) ? height : 720,
  };
}

function selectedDeviceId() {
  return deviceSelect?.value || localStorage.getItem(DEVICE_STORAGE_KEY) || '';
}

function videoConstraints() {
  if (!isUsbMode()) return { facingMode: { ideal: 'environment' } };
  const { width, height } = selectedResolution();
  const deviceId = selectedDeviceId();
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: 30 },
  };
}

async function refreshCameraList(preferredId = selectedDeviceId()) {
  if (!deviceSelect || !navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  const current = preferredId || deviceSelect.value;
  deviceSelect.replaceChildren();

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Webbläsarens standardkamera';
  deviceSelect.append(defaultOption);

  cameras.forEach((camera, index) => {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Kamera ${index + 1}`;
    deviceSelect.append(option);
  });

  if (current && cameras.some((camera) => camera.deviceId === current)) deviceSelect.value = current;
  else deviceSelect.value = '';

  if (selectionHelp) {
    selectionHelp.textContent = cameras.some((camera) => camera.label)
      ? `${cameras.length} kamera${cameras.length === 1 ? '' : 'or'} hittades. Valet sparas automatiskt.`
      : 'Starta kameran en gång för att visa kamerornas riktiga namn.';
  }
}

async function requestCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Webbläsaren saknar stöd för getUserMedia.');

  const deviceId = selectedDeviceId();
  const resolution = selectedResolution();
  setStatus(deviceId ? 'Öppnar vald kamera…' : 'Öppnar standardkameran…');

  const mediaStream = await withTimeout(
    navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false }),
    12000,
  );

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
  const settings = track?.getSettings?.() ?? {};
  const activeDeviceId = settings.deviceId || deviceId;
  if (activeDeviceId) localStorage.setItem(DEVICE_STORAGE_KEY, activeDeviceId);
  localStorage.setItem(RESOLUTION_STORAGE_KEY, `${resolution.width}x${resolution.height}`);
  await refreshCameraList(activeDeviceId);

  const label = track?.label ? ` · ${track.label}` : '';
  if (placeholder) placeholder.hidden = true;
  if (captureButton) captureButton.disabled = false;
  if (newPassButton) newPassButton.disabled = false;
  if (startButton) {
    startButton.disabled = false;
    startButton.textContent = 'Starta om vald kamera';
  }
  setStatus(`Kamera klar · ${video.videoWidth}×${video.videoHeight}${label}`);
  window.dispatchEvent(new CustomEvent('timberscanner:camera-ready', {
    detail: { width: video.videoWidth, height: video.videoHeight, label: track?.label ?? '', deviceId: activeDeviceId },
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

async function restartForSelectionChange() {
  if (deviceSelect) localStorage.setItem(DEVICE_STORAGE_KEY, deviceSelect.value);
  if (resolutionSelect) localStorage.setItem(RESOLUTION_STORAGE_KEY, resolutionSelect.value);
  if (window.__timberCameraStream) await activateCamera('kameraval ändrat');
}

window.TimberCamera = Object.freeze({
  start: () => activateCamera('api'),
  refreshDevices: () => refreshCameraList(),
  isReady: () => Boolean(video?.videoWidth && video?.videoHeight),
  getStream: () => window.__timberCameraStream ?? null,
  stop: () => {
    stopStream(window.__timberCameraStream);
    window.__timberCameraStream = null;
    if (video) video.srcObject = null;
    if (startButton) {
      startButton.disabled = false;
      startButton.textContent = 'Starta vald kamera';
    }
    if (captureButton) captureButton.disabled = true;
    if (newPassButton) newPassButton.disabled = true;
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent = 'Kameran är inte startad';
    }
    setStatus('Kameran stoppad');
  },
});

if (resolutionSelect) {
  const savedResolution = localStorage.getItem(RESOLUTION_STORAGE_KEY);
  if (savedResolution && [...resolutionSelect.options].some((option) => option.value === savedResolution)) {
    resolutionSelect.value = savedResolution;
  }
  resolutionSelect.addEventListener('change', () => restartForSelectionChange().catch(console.error));
}
if (deviceSelect) deviceSelect.addEventListener('change', () => restartForSelectionChange().catch(console.error));
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshCameraList().catch(console.error));
refreshCameraList().catch(console.error);

setStatus(`Kameramodul v20260728-28 redo · källa: ${isUsbMode() ? 'USB' : 'mobil'} · säker anslutning: ${window.isSecureContext ? 'ja' : 'nej'}`);
window.addEventListener('pagehide', () => window.TimberCamera?.stop());