const VERSION = '20260728-13';
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
  // Stabil viewer: överföring, skärpeanalys och bildurval.
  // OpenCV/ORB är avstängt tills det körs isolerat i en Web Worker.
  await load('../debug/viewer-trace.js');
  await load('../vision/viewer-quality-queue.js');
}
