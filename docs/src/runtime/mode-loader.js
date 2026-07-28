const VERSION = '20260728-22';
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
  // Viewer: skärpa -> urval -> foreground-mask -> OpenCV ORB/BFMatcher -> affin RANSAC i Web Worker.
  // Ny fysisk workerfil används för att kringgå gammal browser/CDN-cache.
  await load('../debug/viewer-trace.js');
  await load('../vision/analysis-pipeline.js');
  await load('../vision/worker-cache-fix-v22.js');
  await load('../vision/sequential-feature-matching.js');
  await load('../vision/viewer-quality-queue.js');
}
