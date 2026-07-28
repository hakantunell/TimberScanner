const output = document.querySelector('#viewer-trace');
const viewerButton = document.querySelector('#viewer-mode');
const connectionStatus = document.querySelector('#connection-status');
const startedAt = performance.now();
const entries = [];

function elapsed() {
  return `${((performance.now() - startedAt) / 1000).toFixed(2)} s`;
}

function trace(message) {
  const line = `${elapsed()}: ${message}`;
  entries.push(line);
  if (entries.length > 12) entries.shift();
  if (output) output.textContent = entries.join(' | ');
  console.log(`[ViewerTrace] ${line}`);
}

window.addEventListener('error', (event) => {
  trace(`JS-fel: ${event.message || 'okänt fel'}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  trace(`Promise-fel: ${reason}`);
});

if (connectionStatus) {
  new MutationObserver(() => trace(`Status → ${connectionStatus.textContent}`))
    .observe(connectionStatus, { childList: true, characterData: true, subtree: true });
}

if (viewerButton) {
  viewerButton.addEventListener('click', () => {
    trace('Klick på Dator/livevy mottaget');
    window.setTimeout(() => {
      const screen = document.querySelector('#connection-screen');
      trace(`Efter klick: anslutningsskärm ${screen?.hidden ? 'dold' : 'visas'}`);
    }, 0);
  }, { capture: true });
}

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init.method || (typeof input !== 'string' && input.method) || 'GET';
  const relevant = url.includes('/sync');
  const requestStarted = performance.now();
  if (relevant) trace(`Fetch start ${method} ${url}`);
  try {
    const response = await originalFetch(input, init);
    if (relevant) {
      const duration = ((performance.now() - requestStarted) / 1000).toFixed(2);
      trace(`Fetch svar ${response.status} efter ${duration} s`);
    }
    return response;
  } catch (error) {
    if (relevant) trace(`Fetch fel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

trace('Felsökningsmodul laddad');
