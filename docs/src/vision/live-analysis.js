import { analyseCanvasQuality, describeSharpness } from './image-quality.js';

const analysedImages = new WeakSet();

function setAnalysisCaption(image, quality) {
  const figure = image.closest('figure');
  const caption = figure?.querySelector('figcaption');
  if (!caption) return;

  const baseCaption = caption.dataset.baseCaption ?? caption.textContent;
  caption.dataset.baseCaption = baseCaption;
  caption.textContent = `${baseCaption} · ${describeSharpness(quality)}`;
}

function analyseImageElement(image) {
  if (analysedImages.has(image) || !image.complete || !image.naturalWidth) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);

    const quality = analyseCanvasQuality(canvas);
    analysedImages.add(image);
    setAnalysisCaption(image, quality);

    image.dataset.sharpness = quality.sharpness;
    image.dataset.sharpnessScore = String(quality.sharpnessScore);
    image.dispatchEvent(new CustomEvent('timberscanner:analysed', {
      bubbles: true,
      detail: { quality },
    }));
  } catch (error) {
    console.error('Bildanalysen misslyckades', error);
    const figure = image.closest('figure');
    const caption = figure?.querySelector('figcaption');
    if (caption && !caption.textContent.includes('Analys misslyckades')) {
      caption.textContent += ' · Analys misslyckades';
    }
  }
}

function inspect(root = document) {
  const images = [];

  if (root instanceof HTMLImageElement && root.matches('#captures img')) {
    images.push(root);
  }

  for (const image of root.querySelectorAll?.('#captures img, img') ?? []) {
    if (image.closest('#captures')) images.push(image);
  }

  for (const image of new Set(images)) {
    if (image.complete && image.naturalWidth) {
      analyseImageElement(image);
    } else {
      image.addEventListener('load', () => analyseImageElement(image), { once: true });
    }
  }
}

const captures = document.querySelector('#captures');
if (captures) {
  new MutationObserver(() => inspect(captures))
    .observe(captures, { childList: true, subtree: true });
}

inspect(document);
