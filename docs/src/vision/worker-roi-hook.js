const NativeWorker = window.Worker;
const roiWorkerUrl = new URL('./orb-worker-v35.js?v=20260728-35', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const effectiveUrl = requested.includes('orb-worker-v29.js') ? roiWorkerUrl : url;
  return new NativeWorker(effectiveUrl, options);
};
window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);
