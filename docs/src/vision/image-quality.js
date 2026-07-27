const DEFAULT_SAMPLE_SIZE = 320;

function classifySharpness(score) {
  if (score >= 180) return 'good';
  if (score >= 80) return 'usable';
  return 'blurry';
}

function calculateLaplacianVariance(imageData) {
  const { data, width, height } = imageData;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  const grayAt = (x, y) => {
    const offset = ((y * width) + x) * 4;
    return (data[offset] * 0.299) + (data[offset + 1] * 0.587) + (data[offset + 2] * 0.114);
  };

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centre = grayAt(x, y);
      const laplacian = grayAt(x - 1, y)
        + grayAt(x + 1, y)
        + grayAt(x, y - 1)
        + grayAt(x, y + 1)
        - (4 * centre);
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }

  if (!count) return 0;
  const mean = sum / count;
  return Math.max(0, (sumSquares / count) - (mean * mean));
}

export function analyseCanvasQuality(sourceCanvas, { sampleSize = DEFAULT_SAMPLE_SIZE } = {}) {
  const scale = Math.min(1, sampleSize / Math.max(sourceCanvas.width, sourceCanvas.height));
  const width = Math.max(3, Math.round(sourceCanvas.width * scale));
  const height = Math.max(3, Math.round(sourceCanvas.height * scale));

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = width;
  sampleCanvas.height = height;
  const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceCanvas, 0, 0, width, height);

  const imageData = context.getImageData(0, 0, width, height);
  const sharpnessScore = calculateLaplacianVariance(imageData);

  return {
    sharpnessScore: Math.round(sharpnessScore),
    sharpness: classifySharpness(sharpnessScore),
    analysedAt: new Date().toISOString(),
    algorithm: 'laplacian-variance-v1',
  };
}

export function describeSharpness(quality) {
  if (!quality) return 'Ej analyserad';
  if (quality.sharpness === 'good') return `Skärpa bra (${quality.sharpnessScore})`;
  if (quality.sharpness === 'usable') return `Skärpa användbar (${quality.sharpnessScore})`;
  return `Risk för oskärpa (${quality.sharpnessScore})`;
}
