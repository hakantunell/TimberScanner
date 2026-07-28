const VERSION = '20260728-6';
const params = new URLSearchParams(window.location.search);
const captureMode = params.get('mode') === 'capture';

async function load(path) {
  return import(`${path}?v=${VERSION}`);
}

// Gemensam sessions- och UI-kod.
await load('../../app.js');

if (captureMode) {
  // Telefonen laddar endast kamera, automatisk bildtagning och uppladdningsflöde.
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
} else {
  // Datorn laddar diagnostik och 3D-analys. Ingen av dessa moduler hämtas av telefonen.
  await load('../debug/viewer-trace.js');
  await load('../vision/sparse-reconstruction.js');
  await load('../vision/opencv-loader.js');
  await load('../vision/opencv-reconstruction.js');
  await load('../vision/feature-matching.js');
  await load('../vision/contour-diagnostics.js');
}
