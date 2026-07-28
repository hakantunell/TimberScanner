const LOCAL_API_BASE = 'http://localhost:8787';
const DEFAULT_TIMEOUT_MS = 12000;

function defaultApiBase() {
  const hostname = window.location.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  return isLocal ? LOCAL_API_BASE : '/sync';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Anropet tog längre än ${Math.round(timeoutMs / 1000)} sekunder: ${url}`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const rawBody = await response.text();
  let details = null;
  if (rawBody) {
    try { details = JSON.parse(rawBody); }
    catch { details = { error: rawBody }; }
  }
  if (response.ok) return details;
  throw new Error(details?.error ?? details?.message ?? rawBody ?? `HTTP ${response.status}`);
}

export class CloudRelay {
  constructor({ apiBase = defaultApiBase() } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async health() {
    return parseResponse(await fetchWithTimeout(`${this.apiBase}/health`, { cache: 'no-store' }, 8000));
  }

  async createSession() {
    const nonce = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/open?nonce=${encodeURIComponent(nonce)}`,
      { method: 'GET', cache: 'no-store' },
      12000,
    ));
  }

  async markConnected(remoteSession) {
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/ready`,
      {
        method: 'POST',
        headers: { 'x-upload-token': remoteSession.uploadToken },
      },
    ));
  }

  async clearImages(remoteSession) {
    const headers = {};
    if (remoteSession.viewToken) headers['x-view-token'] = remoteSession.viewToken;
    else headers['x-upload-token'] = remoteSession.uploadToken;
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames`,
      { method: 'DELETE', headers },
    ));
  }

  async uploadCapture(remoteSession, capture) {
    const query = new URLSearchParams({
      pass: String(capture.pass),
      capturedAt: capture.capturedAt,
      width: String(capture.width),
      height: String(capture.height),
    });
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames/${encodeURIComponent(capture.id)}?${query}`,
      {
        method: 'PUT',
        headers: {
          'content-type': capture.blob.type || 'image/jpeg',
          'x-upload-token': remoteSession.uploadToken,
        },
        body: capture.blob,
      },
      30000,
    ));
  }

  async listImages(remoteSession) {
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames`,
      { headers: { 'x-view-token': remoteSession.viewToken }, cache: 'no-store' },
    ));
  }

  async downloadImage(remoteSession, imageId) {
    const response = await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames/${encodeURIComponent(imageId)}`,
      { headers: { 'x-view-token': remoteSession.viewToken }, cache: 'no-store' },
      30000,
    );
    if (!response.ok) throw new Error(`Kunde inte hämta bild: HTTP ${response.status}`);
    return response.blob();
  }

  async deleteSession(remoteSession) {
    return parseResponse(await fetchWithTimeout(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}`,
      { method: 'DELETE', headers: { 'x-view-token': remoteSession.viewToken } },
    ));
  }
}

export { LOCAL_API_BASE, defaultApiBase, fetchWithTimeout };