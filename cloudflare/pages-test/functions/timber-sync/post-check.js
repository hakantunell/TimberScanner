export async function onRequestPost(context) {
  let payload = null;
  try {
    payload = await context.request.json();
  } catch {
    payload = null;
  }

  return Response.json({
    status: 'ok',
    method: context.request.method,
    received: payload,
    timestamp: new Date().toISOString(),
  });
}

export function onRequestGet(context) {
  return Response.json({
    status: 'ready',
    method: context.request.method,
    timestamp: new Date().toISOString(),
  });
}
