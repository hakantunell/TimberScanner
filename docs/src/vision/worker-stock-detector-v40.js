const NativeWorker = window.Worker;
const stockDetectorWorkerUrl = new URL('./orb-worker-v39.js?v=20260729-40', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const isFeatureMatcher = requested.includes('orb-worker-v29.js');
  return new NativeWorker(isFeatureMatcher ? stockDetectorWorkerUrl : url, options);
};

window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);

window.__timberScannerMatcherMode = 'horizontal-log-detector-v40';
