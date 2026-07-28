const VERSION = '20260728-26';
const params = new URLSearchParams(window.location.search);
const mobileMode = params.get('mode') === 'capture' || params.get('mode') === 'mobile';

async function load(path) {
  return import(`${path}?v=${VERSION}`);
}

if (mobileMode) {
  // Det befintliga mobil-/Cloudflare-spåret ligger kvar för senare tester.
  await load('../../app.js');
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
} else {
  // Standard: USB-webbkamera och hela analyskedjan lokalt på datorn.
  await load('./usb-app.js');
  await load('../capture/camera-controller.js');
  await load('../capture/camera-button-fix.js');
  await load('../scanning/auto-capture.js');
  await load('../vision/analysis-pipeline.js');
  await load('../vision/worker-v23-redirect.js');
  await load('../vision/sequential-feature-matching.js');
  await load('../vision/viewer-quality-queue.js');
}
