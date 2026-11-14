/**
 * Centralized feature flag for explorer drag-and-drop.
 * Set EXPLORER_DND_ENABLED to true to re-enable (phases 10-14, postponed).
 * See docs/dnd-explorer-status.md for reactivation steps and pending issues.
 */
export const EXPLORER_DND_ENABLED = false;

/** Prototype route `/__dnd-prototype` available only in development. */
export const DND_PROTOTYPE_ROUTE_ENABLED = import.meta.env.DEV;
