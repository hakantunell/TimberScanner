const WORKER_ORIGIN = 'https://timber-scanner-api.hakan-tunell.workers.dev';

export async function onRequest(context) {
  const incomingUrl = new URL(context.request.url);
  const path = context.params.path;
  const suffix = Array.isArray(path) ? path.join('/') : (path ?? '');
  const targetUrl = new URL(`/${suffix}`, WORKER_ORIGIN);
  targetUrl.search = incomingUrl.search;

  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.delete('origin');

  const upstreamRequest = new Request(targetUrl, {
    method: context.request.method,
    headers,
    body: ['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body,
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
