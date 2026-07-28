const stages = [];
let running = false;
let scheduled = false;
let revision = 0;

export function registerAnalysisStage(stage) {
  if (!stage?.name || typeof stage.run !== 'function') throw new Error('Ogiltigt pipeline-steg');
  stages.push(stage);
}

export function scheduleAnalysisPipeline(reason = 'uppdatering') {
  revision += 1;
  window.timberscannerAnalysisRevision = revision;
  window.timberscannerAnalysisReason = reason;
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(runPipeline, 400);
}

async function runPipeline() {
  scheduled = false;
  if (running) return;
  running = true;
  const runRevision = revision;
  try {
    for (const stage of stages) {
      await stage.run({ revision: runRevision, reason: window.timberscannerAnalysisReason });
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error('Analyspipeline misslyckades', error);
    window.dispatchEvent(new CustomEvent('timberscanner:pipeline-error', { detail: { error, revision: runRevision } }));
  } finally {
    running = false;
    if (revision !== runRevision) scheduleAnalysisPipeline('ny data under körning');
  }
}

window.addEventListener('timberscanner:image-selection', () => scheduleAnalysisPipeline('bildurval uppdaterat'));
window.timberscannerScheduleAnalysis = scheduleAnalysisPipeline;