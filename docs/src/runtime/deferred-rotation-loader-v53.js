const VERSION = '20260729-53';
let loading = false;
let loaded = false;

async function loadRotation() {
  if (loaded || loading) return;
  const video = document.querySelector('#camera');
  if (!video?.videoWidth || !video?.videoHeight || video.readyState < 2) {
    const state = document.querySelector('#auto-profile-state');
    if (state) state.textContent = 'Väntar på att kameran ska starta innan rotationsanalysen laddas';
    return;
  }

  loading = true;
  const state = document.querySelector('#auto-profile-state');
  if (state) state.textContent = 'Laddar rotationsanalys…';

  try {
    // Give the click handler and video renderer one frame before loading analysis code.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    await import(`../vision/strict-t-marker-v51.js?v=${VERSION}`);
    loaded = true;
    window.dispatchEvent(new CustomEvent('timberscanner:rotation-module-loaded'));
    if (state) state.textContent = 'Rotationsanalys laddad · profilinsamlingen kan fortsätta';
  } catch (error) {
    if (state) state.textContent = `Rotationsanalysen kunde inte laddas: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading = false;
  }
}

function attach() {
  const start = document.querySelector('#start-auto-profiles');
  if (!start || start.dataset.rotationLoaderAttached === 'true') return;
  start.dataset.rotationLoaderAttached = 'true';
  start.addEventListener('click', loadRotation, { capture: true });
}

attach();
new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
