const VERSION = '20260728-8';
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
  // Felsökningsläge för datorn: ta endast emot och visa bilder.
  // OpenCV, bildmatchning, punktmoln och konturdiagnostik är avstängda
  // tills hela överföringskedjan fungerar stabilt.
  await load('../debug/viewer-trace.js');
}
