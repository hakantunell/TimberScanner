const SMALL_CLEAN_MIN_MATCHES = 5;
const SMALL_CLEAN_MIN_RATIO = 50;
const SMALL_CLEAN_MAX_ERROR = 2.5;

function baseClassification(result) {
  if (!result || result.error) return 'rejected';
  if (result.matches >= 12 && result.inlierRatio >= 35 && result.meanError <= 5) return 'approved';
  if (result.matches >= 6 && result.inlierRatio >= 20 && result.meanError <= 8) return 'weak';
  if (result.matches >= SMALL_CLEAN_MIN_MATCHES
      && result.inlierRatio >= SMALL_CLEAN_MIN_RATIO
      && result.meanError <= SMALL_CLEAN_MAX_ERROR) return 'weak';
  return 'rejected';
}

function normalizedResult(result) {
  const classification = baseClassification(result);
  if (classification !== 'weak' || result.matches >= 6) return result;
  return {
    ...result,
    actualMatches: result.matches,
    matches: 6,
    classificationOverride: 'weak-small-clean',
  };
}

function repairVisibleSummary(results) {
  const rows = [...document.querySelectorAll('#match-chain-list .match-chain-row')];
  let approved = 0;
  let weak = 0;
  let rejected = 0;

  results.forEach((result, index) => {
    const classification = baseClassification(result);
    if (classification === 'approved') approved += 1;
    else if (classification === 'weak') weak += 1;
    else rejected += 1;

    const row = rows[index];
    if (!row) return;
    row.classList.remove('match-approved', 'match-weak', 'match-rejected');
    row.classList.add(`match-${classification}`);
    const badge = row.querySelector('.match-chain-badge');
    if (badge) badge.textContent = classification === 'approved' ? 'Godkänt' : classification === 'weak' ? 'Svagt' : 'Underkänt';
  });

  const summary = document.querySelector('#match-chain-summary');
  if (summary) summary.textContent = `${approved} godkända · ${weak} svaga · ${rejected} underkända · 0 väntar`;
  const status = document.querySelector('#feature-match-status');
  const detail = document.querySelector('#feature-match-detail');
  if (status) status.textContent = `Bildkedja klar: ${approved}/${results.length} godkända par`;
  if (detail) detail.textContent = `${weak} svaga · ${rejected} underkända · små men geometriskt rena par räknas som svaga`;
}

window.addEventListener('timberscanner:match-chain-ready', (event) => {
  if (event.detail?.classificationNormalized) return;
  const original = event.detail?.results ?? [];
  repairVisibleSummary(original);
  const normalized = original.map(normalizedResult);
  event.stopImmediatePropagation();
  window.dispatchEvent(new CustomEvent('timberscanner:match-chain-ready', {
    detail: {
      ...event.detail,
      results: normalized,
      classificationNormalized: true,
    },
  }));
});
