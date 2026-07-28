const NativeWorker = window.Worker;
const segmentedWorkerUrl = new URL('./orb-worker-v36.js?v=20260728-36', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const effectiveUrl = requested.includes('orb-worker-v29.js') ? segmentedWorkerUrl : url;
  return new NativeWorker(effectiveUrl, options);
};
window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);
