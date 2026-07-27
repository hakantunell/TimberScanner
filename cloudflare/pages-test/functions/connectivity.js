export async function onRequestGet() {
  return Response.json({
    status: 'ok',
    service: 'timber-scanner-pages-function',
    timestamp: new Date().toISOString(),
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}
