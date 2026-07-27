export async function onRequest({ request }) {
  return Response.json({
    status: 'ok',
    service: 'timber-sync',
    method: request.method,
    timestamp: new Date().toISOString(),
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}
