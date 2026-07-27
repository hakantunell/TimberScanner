const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

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

function json(data, status, cors) {
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

function sessionKey(sessionId) {
  return `sessions/${sessionId}/session.json`;
}

function imagePrefix(sessionId) {
  return `sessions/${sessionId}/images/`;
}

async function readSession(env, sessionId) {
  const object = await env.SCANS.get(sessionKey(sessionId));
  if (!object) return null;
  return object.json();
}

async function createSession(env) {
  const sessionId = randomToken(8);
  const session = {
    sessionId,
    uploadToken: randomToken(),
    viewToken: randomToken(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  await env.SCANS.put(sessionKey(sessionId), JSON.stringify(session), {
    httpMetadata: { contentType: 'application/json' },
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
  do {
    const page = await env.SCANS.list({ prefix: `sessions/${sessionId}/`, cursor });
    if (page.objects.length) await env.SCANS.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGIN);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ status: 'ok' }, 200, cors);

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
      return json({ sessionId, images: await listImages(env, sessionId) }, 200, cors);
    }

    const imageMatch = tail.match(/^images\/([^/]+)$/);
    if (imageMatch && request.method === 'PUT') {
      if (!authorized(request, session, 'upload')) return json({ error: 'Unauthorized' }, 401, cors);
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
};
