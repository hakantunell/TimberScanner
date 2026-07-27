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

function json(data, status, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors },
  });
}

function randomToken(bytes = 18) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return btoa(String.fromCharCode(...values))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function retentionHours(env) {
  const configured = Number(env.RETENTION_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETENTION_HOURS;
}

function sessionKey(sessionId) {
  return `${SESSION_PREFIX}${sessionId}/${SESSION_FILE}`;
}

function imagePrefix(sessionId) {
  return `${SESSION_PREFIX}${sessionId}/images/`;
}

async function readSession(env, sessionId) {
  const object = await env.SCANS.get(sessionKey(sessionId));
  if (!object) return null;
  return object.json();
}

async function createSession(env) {
  const sessionId = randomToken(8);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + retentionHours(env) * 60 * 60 * 1000);
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
  return session;
}

function authorized(request, session, tokenType) {
  const header = tokenType === 'upload' ? 'x-upload-token' : 'x-view-token';
  const expected = tokenType === 'upload' ? session.uploadToken : session.viewToken;
  return request.headers.get(header) === expected;
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

async function deleteSession(env, sessionId) {
  let cursor;
  let deletedObjects = 0;
  do {
    const page = await env.SCANS.list({ prefix: `${SESSION_PREFIX}${sessionId}/`, cursor });
    if (page.objects.length) {
      await env.SCANS.delete(page.objects.map((object) => object.key));
      deletedObjects += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deletedObjects;
}

async function cleanupExpiredSessions(env) {
  let cursor;
  let scannedSessions = 0;
  let deletedSessions = 0;
  let deletedObjects = 0;
  const now = Date.now();

  do {
    const page = await env.SCANS.list({ prefix: SESSION_PREFIX, cursor, include: ['customMetadata'] });
    for (const object of page.objects) {
      if (!object.key.endsWith(`/${SESSION_FILE}`)) continue;
      scannedSessions += 1;

      let expiresAt = object.customMetadata?.expiresAt;
      let sessionId = object.key.slice(SESSION_PREFIX.length, -(`/${SESSION_FILE}`.length));
      if (!expiresAt) {
        const session = await readSession(env, sessionId);
        expiresAt = session?.expiresAt;
      }

      if (expiresAt && new Date(expiresAt).getTime() <= now) {
        deletedObjects += await deleteSession(env, sessionId);
        deletedSessions += 1;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { scannedSessions, deletedSessions, deletedObjects };
}

function validateConfiguration(env) {
  const missing = [];
  if (!env.SCANS) missing.push('R2 binding SCANS');
  return {
    ok: missing.length === 0,
    missing,
    retentionHours: retentionHours(env),
    maxImageBytes: MAX_IMAGE_BYTES,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGIN);
    const configuration = validateConfiguration(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') {
      return json({ status: configuration.ok ? 'ok' : 'configuration_error', ...configuration }, configuration.ok ? 200 : 503, cors);
    }
    if (!configuration.ok) return json({ error: 'Worker configuration is incomplete', ...configuration }, 503, cors);

    if (request.method === 'POST' && url.pathname === '/sessions') {
      const session = await createSession(env);
      return json(session, 201, cors);
    }

    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!sessionMatch) return json({ error: 'Not found' }, 404, cors);

    const [, sessionId, tail = ''] = sessionMatch;
    const session = await readSession(env, sessionId);
    if (!session) return json({ error: 'Session not found' }, 404, cors);

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await deleteSession(env, sessionId);
      return json({ error: 'Session expired' }, 410, cors);
    }

    if (request.method === 'GET' && tail === 'images') {
      if (!authorized(request, session, 'view')) return json({ error: 'Unauthorized' }, 401, cors);
      return json({ sessionId, expiresAt: session.expiresAt, images: await listImages(env, sessionId) }, 200, cors);
    }

    const imageMatch = tail.match(/^images\/([^/]+)$/);
    if (imageMatch && request.method === 'PUT') {
      if (!authorized(request, session, 'upload')) return json({ error: 'Unauthorized' }, 401, cors);
      const contentLength = Number(request.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        return json({ error: 'Image too large', maxBytes: MAX_IMAGE_BYTES }, 413, cors);
      }

      const imageId = imageMatch[1];
      const contentType = request.headers.get('content-type') ?? 'image/jpeg';
      const pass = url.searchParams.get('pass') ?? '1';
      const capturedAt = url.searchParams.get('capturedAt') ?? new Date().toISOString();
      await env.SCANS.put(`${imagePrefix(sessionId)}${imageId}`, request.body, {
        httpMetadata: { contentType },
        customMetadata: { pass, capturedAt },
      });
      return json({ imageId }, 201, cors);
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
