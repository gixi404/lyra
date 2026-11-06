/**
 * Módulo de logging centralizado.
 *
 * En DEV (`import.meta.env.DEV`): pasa los mensajes a `console.*` nativamente.
 * En PROD: todos los niveles son no-op excepto `error`, que siempre se propaga.
 */
const isDev = Boolean(
  typeof import.meta !== "undefined" && (import.meta as { env?: { DEV?: boolean } }).env?.DEV
);

export const logger = {
  log: isDev ? console.log.bind(console) : () => {},
  debug: isDev ? console.debug.bind(console) : () => {},
  info: isDev ? console.info.bind(console) : () => {},
  warn: isDev ? console.warn.bind(console) : () => {},
  // En producción no se emite nada en consola; el manejo de errores y notificaciones
  // de la UI se realizan independientemente de console.error.
  error: isDev ? console.error.bind(console) : () => {},
};
