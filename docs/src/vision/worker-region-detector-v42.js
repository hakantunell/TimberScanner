const NativeWorker = window.Worker;
const regionDetectorWorkerUrl = new URL('./orb-worker-v42.js?v=20260729-42', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const isFeatureMatcher = requested.includes('orb-worker-v29.js');
  return new NativeWorker(isFeatureMatcher ? regionDetectorWorkerUrl : url, options);
};
window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);
window.__timberScannerMatcherMode = 'lab-kmeans-region-v42';
