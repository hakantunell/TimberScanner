const VERSION = '20260728-38';
const params = new URLSearchParams(window.location.search);
const mobileMode = params.get('mode') === 'capture' || params.get('mode') === 'mobile';

async function load(path) {
  return import(`${path}?v=${VERSION}`);
}

if (mobileMode) {
  await load('../../app.js');
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
} else {
  await load('./usb-app.js');
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
  await load('../vision/background-calibration.js');
  await load('../vision/analysis-pipeline.js');
  await load('../vision/worker-roi-hook.js');
  await load('../vision/sequential-feature-matching.js');
  await load('../vision/match-classification-normalizer.js');
  await load('../vision/roi-overlay.js');
  await load('../vision/chain-repair-and-cloud.js');
  await load('../vision/viewer-quality-queue.js');
}
