const NativeWorker = window.Worker;
const stockDetectorWorkerUrl = new URL('./orb-worker-v39.js?v=20260728-39', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const isMatcher = requested.includes('orb-worker-v29.js');
  return new NativeWorker(isMatcher ? stockDetectorWorkerUrl : url, options);
};
window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);