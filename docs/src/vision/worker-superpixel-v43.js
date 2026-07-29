const NativeWorker=window.Worker;
const detectorUrl=new URL('./orb-worker-v43.js?v=20260729-43',import.meta.url);
window.Worker=function TimberScannerWorker(url,options){const requested=String(url);return new NativeWorker(requested.includes('orb-worker-v29.js')?detectorUrl:url,options)};
window.Worker.prototype=NativeWorker.prototype;
Object.setPrototypeOf(window.Worker,NativeWorker);
window.__timberScannerMatcherMode='superpixel-region-growing-v43';