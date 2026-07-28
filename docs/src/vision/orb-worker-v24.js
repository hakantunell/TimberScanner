// OpenCV-bootstrap som normaliserar paketets thenable innan den befintliga ORB-kärnan laddas.
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const nativeImportScripts = self.importScripts.bind(self);
const queuedMessages = [];
let coreReady = false;

function queueUntilReady(event) {
  if (!coreReady) queuedMessages.push(event.data);
}

self.addEventListener('message', queueUntilReady);
self.postMessage({ type: 'bootstrap', version: '20260728-24', stage: 'opencv-loading' });

try {
  nativeImportScripts(OPENCV_URL);
} catch (error) {
  self.postMessage({
    type: 'bootstrap-error',
    version: '20260728-24',
    error: `OpenCV kunde inte laddas från jsDelivr: ${error.message}`,
  });
  throw error;
}

Promise.resolve(self.cv).then((resolvedCv) => {
  if (!resolvedCv?.Mat || !resolvedCv?.ORB || !resolvedCv?.BFMatcher) {
    throw new Error('OpenCV initierades men saknar Mat, ORB eller BFMatcher');
  }

  // Den äldre kärnan testar felaktigt .then före den testar om OpenCV redan är redo.
  // En proxy döljer endast then-egenskapen men vidarebefordrar hela OpenCV-API:t.
  self.cv = new Proxy(resolvedCv, {
    get(target, property, receiver) {
      if (property === 'then') return undefined;
      return Reflect.get(target, property, receiver);
    },
  });

  // Kärnan försöker importera OpenCV en gång till. Ignorera just det anropet.
  self.importScripts = (...urls) => {
    const remaining = urls.filter((url) => !String(url).includes('opencv'));
    if (remaining.length) nativeImportScripts(...remaining);
  };

  nativeImportScripts('./orb-worker.js?v=20260728-24-core');
  coreReady = true;
  self.removeEventListener('message', queueUntilReady);
  self.postMessage({ type: 'bootstrap', version: '20260728-24', stage: 'core-ready' });

  for (const data of queuedMessages.splice(0)) {
    self.dispatchEvent(new MessageEvent('message', { data }));
  }
}).catch((error) => {
  self.postMessage({
    type: 'bootstrap-error',
    version: '20260728-24',
    error: error instanceof Error ? error.message : String(error),
  });
});