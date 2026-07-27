const video = document.querySelector('#camera');
const canvas = document.querySelector('#snapshot');
const placeholder = document.querySelector('#camera-placeholder');
const captures = document.querySelector('#captures');
const startButton = document.querySelector('#start-camera');
const captureButton = document.querySelector('#capture');
const newPassButton = document.querySelector('#new-pass');
const resetButton = document.querySelector('#reset');
const imageCount = document.querySelector('#image-count');
const passCount = document.querySelector('#pass-count');
const depthSource = document.querySelector('#depth-source');

const session = { pass: 1, images: [], stream: null };

function refreshStatus() {
  imageCount.textContent = String(session.images.length);
  passCount.textContent = String(session.pass);
}

async function startCamera() {
  session.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
    audio: false,
  });
  video.srcObject = session.stream;
  await video.play();
  placeholder.hidden = true;
  captureButton.disabled = false;
  newPassButton.disabled = false;

  const track = session.stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities?.() ?? {};
  depthSource.textContent = capabilities.depthNear || capabilities.depthFar
    ? 'Kamera + djup'
    : 'Kamera';
}

function captureImage() {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const preview = document.createElement('figure');
  const image = document.createElement('img');
  image.src = canvas.toDataURL('image/jpeg', 0.9);
  image.alt = `Bild ${session.images.length + 1}, rotation ${session.pass}`;
  const caption = document.createElement('figcaption');
  caption.textContent = `Rotation ${session.pass} · bild ${session.images.length + 1}`;
  preview.append(image, caption);
  captures.prepend(preview);

  session.images.push({ pass: session.pass, dataUrl: image.src, capturedAt: new Date().toISOString() });
  refreshStatus();
}

function newPass() {
  session.pass += 1;
  refreshStatus();
}

function resetSession() {
  session.pass = 1;
  session.images = [];
  captures.replaceChildren();
  refreshStatus();
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

captureButton.addEventListener('click', captureImage);
newPassButton.addEventListener('click', newPass);
resetButton.addEventListener('click', resetSession);
refreshStatus();