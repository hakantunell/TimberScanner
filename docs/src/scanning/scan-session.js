export const ACTIVE_SESSION_ID = 'active';

export function createSession() {
  const now = new Date().toISOString();
  return {
    id: ACTIVE_SESSION_ID,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    currentPass: 1,
    scaleReferenceMm: null,
    markerType: 't-marker',
    depthSource: 'rgb-only',
    images: [],
  };
}

export function addCapture(session, capture) {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    images: [...session.images, capture],
  };
}

export function nextPass(session) {
  return {
    ...session,
    currentPass: session.currentPass + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function setScaleReference(session, millimetres) {
  return {
    ...session,
    scaleReferenceMm: Number.isFinite(millimetres) ? millimetres : null,
    updatedAt: new Date().toISOString(),
  };
}

export function createCapture({ blob, width, height, pass }) {
  return {
    id: crypto.randomUUID(),
    pass,
    capturedAt: new Date().toISOString(),
    width,
    height,
    blob,
    markerObservations: [],
    depthFrame: null,
  };
}
