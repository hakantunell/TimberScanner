const NativeWorker = window.Worker;
const segmentedWorkerUrl = new URL('./orb-worker-v37.js?v=20260728-37', import.meta.url);

window.Worker = function TimberScannerWorker(url, options) {
  const requested = String(url);
  const isMatcher = requested.includes('orb-worker-v29.js');
  const worker = new NativeWorker(isMatcher ? segmentedWorkerUrl : url, options);

  if (isMatcher) {
    const nativePostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer = []) => {
      if (message?.type === 'match') {
        const background = window.__timberScannerBackground;
        if (background?.data) {
          const copy = new Uint8ClampedArray(background.data);
          message = {
            ...message,
            payload: {
              ...message.payload,
              background: { width: background.width, height: background.height, buffer: copy.buffer },
            },
          };
          nativePostMessage(message, [...transfer, copy.buffer]);
          return;
        }
      }
      nativePostMessage(message, transfer);
    };
  }

  return worker;
};
window.Worker.prototype = NativeWorker.prototype;
Object.setPrototypeOf(window.Worker, NativeWorker);
