const VERSION = '20260728-9';
const params = new URLSearchParams(window.location.search);
const captureMode = params.get('mode') === 'capture';

async function load(path) {
  return import(`${path}?v=${VERSION}`);
}

await load('../../app.js');

if (captureMode) {
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
} else {
  // Diagnostikversion: endast överföring och viewer-logg. Ingen bildanalys eller OpenCV.
  await load('../debug/viewer-trace.js');
}
