type DebugPayload = Record<string, unknown>;

/**
 * Instrumentación temporal de scroll deshabilitada en builds de producción.
 * Se conserva la API como no-op para no alterar el comportamiento funcional.
 */
export function scrollDebug(_event: string, _payload: DebugPayload = {}): void {
  // Intencionalmente vacío: sin IPC, sin archivos temporales y sin listeners.
}

export function snapshotScrollState(_origin: string, _extra: DebugPayload = {}): void {
  // Intencionalmente vacío.
}
