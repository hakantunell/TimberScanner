const video = document.querySelector('#camera');
const container = document.querySelector('#camera-selection-help')?.closest('.settings-card');
const MAX_WIDTH = 480;

window.__timberScannerBackground = null;

function makeButton(id, text, secondary = false) {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.textContent = text;
  if (secondary) button.className = 'secondary';
  return button;
}

function captureBackground() {
  if (!video?.videoWidth || !video?.videoHeight) throw new Error('Starta USB-kameran först');
  const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(200, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(150, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  window.__timberScannerBackground = {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
    calibratedAt: Date.now(),
  };
  window.dispatchEvent(new CustomEvent('timberscanner:background-calibrated', { detail: { width: image.width, height: image.height } }));
  return window.__timberScannerBackground;
}

if (container) {
  const section = document.createElement('section');
  section.className = 'background-calibration';
  const title = document.createElement('strong');
  title.textContent = 'Stockmask – bakgrundskalibrering';
  const help = document.createElement('small');
  help.id = 'background-calibration-status';
  help.textContent = 'Ta bort stocken och kalibrera den tomma skanningsplatsen.';
  const actions = document.createElement('div');
  actions.className = 'scan-actions';
  const calibrate = makeButton('calibrate-background', 'Kalibrera tom bakgrund');
  const reset = makeButton('reset-background', 'Återställ bakgrund', true);
  reset.disabled = true;
  actions.append(calibrate, reset);
  section.append(title, help, actions);
  container.append(section);

  calibrate.addEventListener('click', () => {
    try {
      const background = captureBackground();
      help.textContent = `Bakgrund kalibrerad · ${background.width}×${background.height}. Lägg tillbaka stocken och börja skanna.`;
      reset.disabled = false;
    } catch (error) {
      help.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  reset.addEventListener('click', () => {
    window.__timberScannerBackground = null;
    reset.disabled = true;
    help.textContent = 'Bakgrunden är återställd. Ta bort stocken och kalibrera igen.';
    window.dispatchEvent(new CustomEvent('timberscanner:background-reset'));
  });
}
