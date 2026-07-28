const NativeWorker = window.Worker;

window.Worker = class TimberScannerWorker extends NativeWorker {
  constructor(url, options) {
    const source = String(url);
    if (source.includes('/orb-worker.js') || source.endsWith('orb-worker.js')) {
      const replacement = new URL('./orb-worker-v24.js?v=20260728-24', import.meta.url);
      super(replacement, options);
      return;
    }
    super(url, options);
  }
};