const NativeWorker = window.Worker;

window.Worker = class TimberScannerWorker extends NativeWorker {
  constructor(url, options) {
    const resolved = new URL(String(url), window.location.href);
    if (resolved.pathname.endsWith('/src/vision/orb-worker.js')) {
      resolved.pathname = resolved.pathname.replace('/orb-worker.js', '/orb-worker-v22.js');
      resolved.search = '?v=20260728-22';
    }
    super(resolved, options);
  }
};
