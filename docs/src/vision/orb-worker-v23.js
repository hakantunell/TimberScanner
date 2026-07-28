// Robust bootstrap för OpenCV.js-paketets thenable-initiering.
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const nativeImportScripts = self.importScripts.bind(self);
const queuedMessages = [];
let coreReady = false;

function queueUntilReady(event) {
  if (!coreReady) queuedMessages.push(event.data);
}

self.addEventListener('message', queueUntilReady);
self.postMessage({ type: 'bootstrap', version: '20260728-23', stage: 'opencv-loading' });

try {
  nativeImportScripts(OPENCV_URL);
} catch (error) {
  self.postMessage({
    type: 'bootstrap-error',
    version: '20260728-23',
    error: `OpenCV kunde inte laddas från jsDelivr: ${error.message}`,
  });
  throw error;
}

Promise.resolve(self.cv)
  .then((resolvedCv) => {
    if (!resolvedCv?.Mat || !resolvedCv?.ORB || !resolvedCv?.BFMatcher) {
      throw new Error('OpenCV initierades men saknar Mat, ORB eller BFMatcher');
    }

    self.cv = resolvedCv;

    // Den äldre kärnan försöker ladda OpenCV igen. Låt just OpenCV-anropet bli en no-op,
    // men behåll native importScripts för andra lokala beroenden.
    self.importScripts = (...urls) => {
      const remaining = urls.filter((url) => !String(url).includes('opencv'));
      if (remaining.length) nativeImportScripts(...remaining);
    };

    nativeImportScripts('./orb-worker.js?v=20260728-23-core');
    coreReady = true;
    self.removeEventListener('message', queueUntilReady);
    self.postMessage({ type: 'bootstrap', version: '20260728-23', stage: 'core-ready' });

    for (const data of queuedMessages.splice(0)) {
      self.dispatchEvent(new MessageEvent('message', { data }));
    }
  })
  .catch((error) => {
    self.postMessage({
      type: 'bootstrap-error',
      version: '20260728-23',
      error: error instanceof Error ? error.message : String(error),
    });
  });