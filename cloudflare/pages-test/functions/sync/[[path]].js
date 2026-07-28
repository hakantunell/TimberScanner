const WORKER_ORIGIN = 'https://timber-scanner-api.hakan-tunell.workers.dev';

function translatePublicPath(suffix) {
  if (suffix === 'start' || suffix === 'open') return '/sessions';
  if (suffix === 'health') return '/health';

  const parts = suffix.split('/').filter(Boolean);
  if (parts[0] !== 'link' || !parts[1]) return `/${suffix}`;

  const sessionId = encodeURIComponent(parts[1]);
  if (parts.length === 2) return `/sessions/${sessionId}`;
  if (parts[2] === 'ready' && parts.length === 3) return `/sessions/${sessionId}/connected`;
  if (parts[2] === 'frames' && parts.length === 3) return `/sessions/${sessionId}/images`;
  if (parts[2] === 'frames' && parts[3]) {
    return `/sessions/${sessionId}/images/${encodeURIComponent(parts[3])}`;
  }

  return `/${suffix}`;
}

export async function onRequest(context) {
  const incomingUrl = new URL(context.request.url);
  const path = context.params.path;
  const suffix = Array.isArray(path) ? path.join('/') : (path ?? '');
  const targetUrl = new URL(translatePublicPath(suffix), WORKER_ORIGIN);

  const createViaGet = suffix === 'open' && context.request.method === 'GET';
  if (!createViaGet) targetUrl.search = incomingUrl.search;

  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.delete('origin');
  if (createViaGet) headers.set('content-type', 'application/json');

  const upstreamMethod = createViaGet ? 'POST' : context.request.method;
  const upstreamRequest = new Request(targetUrl, {
    method: upstreamMethod,
    headers,
    body: createViaGet ? '{}' : (['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body),
    redirect: 'manual',
  });

  try {
    const upstream = await fetch(upstreamRequest);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.delete('access-control-allow-origin');
    responseHeaders.delete('access-control-allow-credentials');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json({
      error: 'Cloudflare Pages kunde inte nå TimberScanner-API:t.',
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }
}