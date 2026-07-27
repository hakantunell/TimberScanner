import { analyseCanvasQuality, describeSharpness } from './image-quality.js';

const analysedImages = new WeakSet();

function analyseImageElement(image) {
  if (analysedImages.has(image) || !image.complete || !image.naturalWidth) return;
  analysedImages.add(image);

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);

  const quality = analyseCanvasQuality(canvas);
  const figure = image.closest('figure');
  const caption = figure?.querySelector('figcaption');
  if (caption) caption.textContent += ` · ${describeSharpness(quality)}`;

  image.dataset.sharpness = quality.sharpness;
  image.dataset.sharpnessScore = String(quality.sharpnessScore);
  image.dispatchEvent(new CustomEvent('timberscanner:analysed', {
    bubbles: true,
    detail: { quality },
  }));
}

function inspect(root = document) {
  for (const image of root.querySelectorAll?.('#captures img') ?? []) {
    if (image.complete) analyseImageElement(image);
    else image.addEventListener('load', () => analyseImageElement(image), { once: true });
  }
}

const captures = document.querySelector('#captures');
if (captures) {
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) inspect(node);
      }
    }
  }).observe(captures, { childList: true, subtree: true });
}

inspect();
