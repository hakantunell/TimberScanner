const VERSION = '20260729-46';
const params = new URLSearchParams(window.location.search);
const mobileMode = params.get('mode') === 'capture' || params.get('mode') === 'mobile';
const photoMode = params.get('analysis') === 'photo' || params.get('analysis') === 'orb';

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
  await load('../vision/analysis-pipeline.js');
  await load('../vision/laser-line-lab-v45.js');
  await load('../vision/auto-laser-profile-collector-v46.js');

  if (photoMode) {
    await load('../vision/segmentation-lab-v43.js');
    await load('../vision/worker-superpixel-v43.js');
    await load('../vision/sequential-feature-matching.js');
    await load('../vision/match-classification-normalizer.js');
    await load('../vision/roi-overlay.js');
    await load('../vision/chain-repair-and-cloud.js');
  }

  await load('../vision/viewer-quality-queue.js');
}
