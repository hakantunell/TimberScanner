const DEFAULT_API_BASE = 'https://timber-scanner-api.hakan-tunell.workers.dev';

async function parseResponse(response) {
  if (response.ok) {
    if (response.status === 204) return null;
    return response.json();
  }

  let details;
  try {
    details = await response.json();
  } catch {
    details = { error: await response.text() };
  }
  throw new Error(details.error ?? `HTTP ${response.status}`);
}

export class CloudRelay {
  constructor({ apiBase = DEFAULT_API_BASE } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  async health() {
    return parseResponse(await fetch(`${this.apiBase}/health`, { cache: 'no-store' }));
  }

  async createSession() {
    return parseResponse(await fetch(`${this.apiBase}/sessions`, {
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
      `${this.apiBase}/sessions/${encodeURIComponent(remoteSession.sessionId)}/images/${encodeURIComponent(capture.id)}?${query}`,
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
      `${this.apiBase}/sessions/${encodeURIComponent(remoteSession.sessionId)}/images`,
      {
        headers: { 'x-view-token': remoteSession.viewToken },
        cache: 'no-store',
      },
    );
    return parseResponse(response);
  }

  async downloadImage(remoteSession, imageId) {
    const response = await fetch(
      `${this.apiBase}/sessions/${encodeURIComponent(remoteSession.sessionId)}/images/${encodeURIComponent(imageId)}`,
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
      `${this.apiBase}/sessions/${encodeURIComponent(remoteSession.sessionId)}`,
      {
        method: 'DELETE',
        headers: { 'x-view-token': remoteSession.viewToken },
      },
    );
    return parseResponse(response);
  }
}

export { DEFAULT_API_BASE };
