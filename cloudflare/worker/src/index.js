const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const SESSION_PREFIX = 'sessions/';
const SESSION_FILE = 'session.json';
const DEFAULT_RETENTION_HOURS = 24;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function corsHeaders(origin, allowedOrigin) {
  const allowed = !allowedOrigin || origin === allowedOrigin || origin?.startsWith(`${allowedOrigin}/`);
  return {
    'access-control-allow-origin': allowed ? origin ?? allowedOrigin ?? '*' : allowedOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-upload-token,x-view-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function randomToken(bytes = 18) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return btoa(String.fromCharCode(...values)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function retentionHours(env) {
  const configured = Number(env.RETENTION_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_HOURS;
}

const sessionKey = (sessionId) => `${SESSION_PREFIX}${sessionId}/${SESSION_FILE}`;
const imagePrefix = (sessionId) => `${SESSION_PREFIX}${sessionId}/images/`;

function sessionStub(env, sessionId) {
  return env.SCAN_SESSIONS.get(env.SCAN_SESSIONS.idFromName(sessionId));
}

async function readSession(env, sessionId) {
  const object = await env.SCANS.get(sessionKey(sessionId));
  return object ? object.json() : null;
}

async function callLive(env, sessionId, path, init) {
  return sessionStub(env, sessionId).fetch(`https://session.internal${path}`, init);
}

async function createSession(env) {
  const sessionId = randomToken(8);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + retentionHours(env) * 3600000);
  const session = {
    sessionId,
    uploadToken: randomToken(),
    viewToken: randomToken(),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await env.SCANS.put(sessionKey(sessionId), JSON.stringify(session), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { kind: 'session', expiresAt: session.expiresAt },
  });
  const response = await callLive(env, sessionId, '/init', {
    method: 'POST',
    body: JSON.stringify({ sessionId, createdAt: session.createdAt, expiresAt: session.expiresAt }),
  });
  if (!response.ok) throw new Error(`Could not initialise live session: ${response.status}`);
  return session;
}

function authorized(request, session, tokenType) {
  const upload = tokenType === 'upload';
  return request.headers.get(upload ? 'x-upload-token' : 'x-view-token') === (upload ? session.uploadToken : session.viewToken);
}

async function listImages(env, sessionId) {
  const listed = await env.SCANS.list({ prefix: imagePrefix(sessionId) });
  return listed.objects.map((object) => ({
    id: object.key.slice(imagePrefix(sessionId).length),
    key: object.key,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
    metadata: object.customMetadata ?? {},
  }));
}

async function deleteImages(env, sessionId) {
  let cursor;
  let deleted = 0;
  do {
    const page = await env.SCANS.list({ prefix: imagePrefix(sessionId), cursor });
    if (page.objects.length) {
      await env.SCANS.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await callLive(env, sessionId, '/images', { method: 'DELETE' });
  return deleted;
}

async function deleteSession(env, sessionId) {
  let cursor;
  let deleted = 0;
  do {
    const page = await env.SCANS.list({ prefix: `${SESSION_PREFIX}${sessionId}/`, cursor });
    if (page.objects.length) {
      await env.SCANS.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await callLive(env, sessionId, '/delete', { method: 'DELETE' });
  return deleted;
}

async function cleanupExpiredSessions(env) {
  let cursor;
  const result = { scannedSessions: 0, deletedSessions: 0, deletedObjects: 0 };
  do {
    const page = await env.SCANS.list({ prefix: SESSION_PREFIX, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      if (!object.key.endsWith(`/${SESSION_FILE}`)) continue;
      result.scannedSessions += 1;
      const sessionId = object.key.slice(SESSION_PREFIX.length, -(`/${SESSION_FILE}`.length));
      const expiresAt = object.customMetadata?.expiresAt ?? (await readSession(env, sessionId))?.expiresAt;
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
        result.deletedObjects += await deleteSession(env, sessionId);
        result.deletedSessions += 1;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return result;
}

function validateConfiguration(env) {
  const missing = [];
  if (!env.SCANS) missing.push('R2 binding SCANS');
  if (!env.SCAN_SESSIONS) missing.push('Durable Object binding SCAN_SESSIONS');
  return {
    ok: missing.length === 0,
    missing,
    retentionHours: retentionHours(env),
    maxImageBytes: MAX_IMAGE_BYTES,
    sessionBackend: 'durable-object-sqlite',
    imageBackend: 'r2',
  };
}

export class ScanSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') {
      if (!(await this.state.storage.get('session'))) {
        await this.state.storage.put('session', await request.json());
        await this.state.storage.put('images', []);
        await this.state.storage.put('connected', false);
        await this.state.storage.put('revision', 0);
      }
      return json({ status: 'ready' });
    }
    if (request.method === 'POST' && url.pathname === '/connected') {
      await this.state.storage.put('connected', true);
      await this.state.storage.put('connectedAt', new Date().toISOString());
      return json({ status: 'connected' });
    }
    if (request.method === 'POST' && url.pathname === '/images') {
      const image = await request.json();
      const images = (await this.state.storage.get('images')) ?? [];
      const updated = images.filter((item) => item.id !== image.id);
      updated.push(image);
      await this.state.storage.put('images', updated);
      return json({ status: 'recorded', imageCount: updated.length }, 201);
    }
    if (request.method === 'DELETE' && url.pathname === '/images') {
      await this.state.storage.put('images', []);
      const revision = ((await this.state.storage.get('revision')) ?? 0) + 1;
      await this.state.storage.put('revision', revision);
      return json({ status: 'cleared', revision });
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const session = await this.state.storage.get('session');
      if (!session) return json({ error: 'Session not initialised' }, 404);
      const images = (await this.state.storage.get('images')) ?? [];
      return json({
        ...session,
        images,
        imageCount: images.length,
        connected: (await this.state.storage.get('connected')) ?? false,
        connectedAt: (await this.state.storage.get('connectedAt')) ?? null,
        revision: (await this.state.storage.get('revision')) ?? 0,
      });
    }
    if (request.method === 'DELETE' && url.pathname === '/delete') {
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    return json({ error: 'Not found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGIN);
    const configuration = validateConfiguration(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ status: configuration.ok ? 'ok' : 'configuration_error', ...configuration }, configuration.ok ? 200 : 503, cors);
    if (!configuration.ok) return json({ error: 'Worker configuration is incomplete', ...configuration }, 503, cors);
    if (request.method === 'POST' && url.pathname === '/sessions') return json(await createSession(env), 201, cors);

    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!match) return json({ error: 'Not found' }, 404, cors);
    const [, sessionId, tail = ''] = match;
    const session = await readSession(env, sessionId);
    if (!session) return json({ error: 'Session not found' }, 404, cors);
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await deleteSession(env, sessionId);
      return json({ error: 'Session expired' }, 410, cors);
    }

    if (request.method === 'POST' && tail === 'connected') {
      if (!authorized(request, session, 'upload')) return json({ error: 'Unauthorized' }, 401, cors);
      const response = await callLive(env, sessionId, '/connected', { method: 'POST' });
      return new Response(response.body, { status: response.status, headers: { ...cors, ...JSON_HEADERS } });
    }
    if (request.method === 'GET' && tail === '') {
      if (!authorized(request, session, 'view')) return json({ error: 'Unauthorized' }, 401, cors);
      const liveResponse = await callLive(env, sessionId, '/state');
      return json({ sessionId, expiresAt: session.expiresAt, live: liveResponse.ok ? await liveResponse.json() : null }, 200, cors);
    }
    if (request.method === 'GET' && tail === 'images') {
      if (!authorized(request, session, 'view')) return json({ error: 'Unauthorized' }, 401, cors);
      const liveResponse = await callLive(env, sessionId, '/state');
      return json({ sessionId, expiresAt: session.expiresAt, images: await listImages(env, sessionId), live: liveResponse.ok ? await liveResponse.json() : null }, 200, cors);
    }
    if (request.method === 'DELETE' && tail === 'images') {
      const allowed = authorized(request, session, 'upload') || authorized(request, session, 'view');
      if (!allowed) return json({ error: 'Unauthorized' }, 401, cors);
      return json({ status: 'cleared', deletedImages: await deleteImages(env, sessionId) }, 200, cors);
    }

    const imageMatch = tail.match(/^images\/([^/]+)$/);
    if (imageMatch && request.method === 'PUT') {
      if (!authorized(request, session, 'upload')) return json({ error: 'Unauthorized' }, 401, cors);
      const contentLength = Number(request.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) return json({ error: 'Image too large', maxBytes: MAX_IMAGE_BYTES }, 413, cors);
      const imageId = imageMatch[1];
      const key = `${imagePrefix(sessionId)}${imageId}`;
      const pass = url.searchParams.get('pass') ?? '1';
      const capturedAt = url.searchParams.get('capturedAt') ?? new Date().toISOString();
      const width = url.searchParams.get('width') ?? '';
      const height = url.searchParams.get('height') ?? '';
      await env.SCANS.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'image/jpeg' },
        customMetadata: { pass, capturedAt, width, height },
      });
      const stored = await env.SCANS.head(key);
      const image = { id: imageId, size: stored?.size ?? contentLength ?? null, pass, capturedAt, uploadedAt: new Date().toISOString() };
      const liveResponse = await callLive(env, sessionId, '/images', { method: 'POST', body: JSON.stringify(image) });
      if (!liveResponse.ok) throw new Error(`Could not update live session: ${liveResponse.status}`);
      return json({ imageId, live: image }, 201, cors);
    }
    if (imageMatch && request.method === 'GET') {
      if (!authorized(request, session, 'view')) return json({ error: 'Unauthorized' }, 401, cors);
      const object = await env.SCANS.get(`${imagePrefix(sessionId)}${imageMatch[1]}`);
      if (!object) return json({ error: 'Image not found' }, 404, cors);
      const headers = new Headers(cors);
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', 'no-store');
      return new Response(object.body, { headers });
    }
    if (request.method === 'DELETE' && tail === '') {
      if (!authorized(request, session, 'view')) return json({ error: 'Unauthorized' }, 401, cors);
      await deleteSession(env, sessionId);
      return new Response(null, { status: 204, headers: cors });
    }
    return json({ error: 'Not found' }, 404, cors);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupExpiredSessions(env));
  },
};