import { analyseCanvasQuality, describeSharpness } from '../vision/image-quality.js?v=20260727-5';

const SAMPLE_INTERVAL_MS = 650;
const MIN_CAPTURE_INTERVAL_MS = 1400;
const MIN_SHARPNESS_SCORE = 80;

const video = document.querySelector('#camera');
const manualCaptureButton = document.querySelector('#capture');
const startCameraButton = document.querySelector('#start-camera');
const startScanButton = document.querySelector('#start-auto-scan');
const pauseScanButton = document.querySelector('#pause-auto-scan');
const scanStatus = document.querySelector('#auto-scan-status');
const sharpnessStatus = document.querySelector('#live-sharpness');

let running = false;
let loopTimer = null;
let lastCaptureAt = 0;
let captureInProgress = false;

function setStatus(message) {
  if (scanStatus) scanStatus.textContent = message;
}

function stopLoop(message = 'Pausad') {
  running = false;
  if (loopTimer) window.clearTimeout(loopTimer);
  loopTimer = null;
  if (startScanButton) startScanButton.disabled = false;
  if (pauseScanButton) pauseScanButton.disabled = true;
  setStatus(message);
}

async function ensureCameraStarted() {
  if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;
  if (!startCameraButton?.disabled) startCameraButton.click();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  }
  throw new Error('Kameran blev inte klar i tid');
}

function analyseCurrentFrame() {
  const longestSide = Math.max(video.videoWidth, video.videoHeight);
  const scale = Math.min(1, 320 / longestSide);
  const width = Math.max(3, Math.round(video.videoWidth * scale));
  const height = Math.max(3, Math.round(video.videoHeight * scale));
  const sample = document.createElement('canvas');
  sample.width = width;
  sample.height = height;
  sample.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, width, height);
  return analyseCanvasQuality(sample, { sampleSize: 320 });
}

async function waitForCaptureCompletion(previousCount) {
  const imageCount = document.querySelector('#image-count');
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const currentCount = Number(imageCount?.textContent ?? 0);
    if (currentCount > previousCount) return;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
}

async function tick() {
  if (!running) return;

  try {
    if (document.hidden) {
      setStatus('Pausad medan appen är i bakgrunden');
      return;
    }
    if (!video.videoWidth || manualCaptureButton.disabled || captureInProgress) return;

    const quality = analyseCurrentFrame();
    if (sharpnessStatus) sharpnessStatus.textContent = describeSharpness(quality);

    const elapsed = Date.now() - lastCaptureAt;
    if (quality.sharpnessScore < MIN_SHARPNESS_SCORE) {
      setStatus('Flytta långsammare – väntar på skarp bild');
      return;
    }
    if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
      setStatus('Skannar – väntar på nästa bildläge');
      return;
    }

    captureInProgress = true;
    const previousCount = Number(document.querySelector('#image-count')?.textContent ?? 0);
    setStatus('Sparar bildruta…');
    manualCaptureButton.click();
    lastCaptureAt = Date.now();
    await waitForCaptureCompletion(previousCount);
    setStatus('Skannar – flytta långsamt längs stocken');
  } catch (error) {
    console.error('Automatisk skanning misslyckades', error);
    stopLoop(`Skanningen stoppades: ${error.message}`);
  } finally {
    captureInProgress = false;
    if (running) loopTimer = window.setTimeout(tick, SAMPLE_INTERVAL_MS);
  }
}

async function startLoop() {
  if (running) return;
  try {
    setStatus('Startar kamera…');
    await ensureCameraStarted();
    running = true;
    lastCaptureAt = 0;
    startScanButton.disabled = true;
    pauseScanButton.disabled = false;
    setStatus('Skannar – flytta långsamt längs stocken');
    tick();
  } catch (error) {
    stopLoop(`Kunde inte starta: ${error.message}`);
  }
}

startScanButton?.addEventListener('click', () => startLoop());
pauseScanButton?.addEventListener('click', () => stopLoop());
document.querySelector('#new-pass')?.addEventListener('click', () => {
  lastCaptureAt = 0;
  if (running) setStatus('Ny rotation – börja vid stockänden igen');
});
document.querySelector('#reset')?.addEventListener('click', () => stopLoop('Skanningen är stoppad'));
window.addEventListener('pagehide', () => stopLoop('Stoppad'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && running) {
    setStatus('Skannar – flytta långsamt längs stocken');
    if (!loopTimer) tick();
  }
});
