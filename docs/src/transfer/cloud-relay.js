const LOCAL_API_BASE = 'http://localhost:8787';

function defaultApiBase() {
  const hostname = window.location.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  return isLocal ? LOCAL_API_BASE : '/sync';
}

async function parseResponse(response) {
  if (response.status === 204) return null;

  const rawBody = await response.text();
  let details = null;

  if (rawBody) {
    try {
      details = JSON.parse(rawBody);
    } catch {
      details = { error: rawBody };
    }
  }

  if (response.ok) return details;

  const message = details?.error
    ?? details?.message
    ?? rawBody
    ?? `HTTP ${response.status}`;
  throw new Error(message);
}

export class CloudRelay {
  constructor({ apiBase = defaultApiBase() } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async health() {
    return parseResponse(await fetch(`${this.apiBase}/health`, { cache: 'no-store' }));
  }

  async createSession() {
    return parseResponse(await fetch(`${this.apiBase}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }));
  }

  async uploadCapture(remoteSession, capture) {
    const query = new URLSearchParams({
      pass: String(capture.pass),
      capturedAt: capture.capturedAt,
      width: String(capture.width),
      height: String(capture.height),
    });
    const response = await fetch(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames/${encodeURIComponent(capture.id)}?${query}`,
      {
        method: 'PUT',
        headers: {
          'content-type': capture.blob.type || 'image/jpeg',
          'x-upload-token': remoteSession.uploadToken,
        },
        body: capture.blob,
      },
    );
    return parseResponse(response);
  }

  async listImages(remoteSession) {
    const response = await fetch(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames`,
      {
        headers: { 'x-view-token': remoteSession.viewToken },
        cache: 'no-store',
      },
    );
    return parseResponse(response);
  }

  async downloadImage(remoteSession, imageId) {
    const response = await fetch(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}/frames/${encodeURIComponent(imageId)}`,
      {
        headers: { 'x-view-token': remoteSession.viewToken },
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Kunde inte hämta bild: HTTP ${response.status}`);
    return response.blob();
  }

  async deleteSession(remoteSession) {
    const response = await fetch(
      `${this.apiBase}/link/${encodeURIComponent(remoteSession.sessionId)}`,
      {
        method: 'DELETE',
        headers: { 'x-view-token': remoteSession.viewToken },
      },
    );
    return parseResponse(response);
  }
}

export { LOCAL_API_BASE, defaultApiBase };
