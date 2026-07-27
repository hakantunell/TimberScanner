let loadingPromise = null;

function loadOpenCv() {
  if (window.cv) return Promise.resolve(window.cv);
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    script.dataset.timberscannerOpenCv = 'true';

    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error('OpenCV.js tog längre än 30 sekunder att ladda'));
    }, 30000);

    script.addEventListener('load', () => {
      window.clearTimeout(timeout);
      resolve(window.cv);
    }, { once: true });

    script.addEventListener('error', () => {
      window.clearTimeout(timeout);
      reject(new Error('OpenCV.js kunde inte hämtas från docs.opencv.org'));
    }, { once: true });

    document.head.append(script);
  });

  loadingPromise.catch((error) => {
    console.error('OpenCV lazy loading misslyckades', error);
    loadingPromise = null;
  });

  return loadingPromise;
}

window.timberscannerLoadOpenCv = loadOpenCv;
window.addEventListener('timberscanner:feature-matches', () => {
  loadOpenCv().catch(() => {});
});
