const VERSION = '20260728-27';
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const queuedMessages = [];
let coreReady = false;

function post(stage, extra = {}) {
  self.postMessage({ type: 'bootstrap', version: VERSION, stage, ...extra });
}

function queueUntilReady(event) {
  if (!coreReady) queuedMessages.push(event.data);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('message', queueUntilReady);

(async () => {
  post('opencv-fetch-start');
  const response = await fetchWithTimeout(OPENCV_URL, 20000);
  post('opencv-fetch-response', {
    status: response.status,
    contentLength: response.headers.get('content-length') || '',
    contentType: response.headers.get('content-type') || '',
  });
  if (!response.ok) throw new Error(`OpenCV-hämtning gav HTTP ${response.status}`);

  const source = await response.text();
  post('opencv-source-ready', { bytes: source.length });
  if (source.length < 1000000) throw new Error(`OpenCV-filen var oväntat liten (${source.length} byte)`);

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    post('opencv-evaluating');
    importScripts(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  post('opencv-initializing');
  const resolvedCv = await Promise.resolve(self.cv);
  if (!resolvedCv?.Mat || !resolvedCv?.ORB || !resolvedCv?.BFMatcher) {
    throw new Error('OpenCV initierades men saknar Mat, ORB eller BFMatcher');
  }

  self.cv = new Proxy(resolvedCv, {
    get(target, property, receiver) {
      if (property === 'then') return undefined;
      return Reflect.get(target, property, receiver);
    },
  });

  const nativeImportScripts = self.importScripts.bind(self);
  self.importScripts = (...urls) => {
    const remaining = urls.filter((url) => !String(url).includes('opencv'));
    if (remaining.length) nativeImportScripts(...remaining);
  };

  post('core-loading');
  nativeImportScripts('./orb-worker.js?v=20260728-27-core');
  coreReady = true;
  self.removeEventListener('message', queueUntilReady);
  post('core-ready');

  for (const data of queuedMessages.splice(0)) {
    self.dispatchEvent(new MessageEvent('message', { data }));
  }
})().catch((error) => {
  self.postMessage({
    type: 'bootstrap-error',
    version: VERSION,
    error: error?.name === 'AbortError'
      ? 'OpenCV-hämtningen tog längre än 20 sekunder'
      : (error instanceof Error ? error.message : String(error)),
  });
});
