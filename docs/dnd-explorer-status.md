# Explorador: Drag-and-drop (fases 10–14) — pospuesto

Estado: **implementado parcialmente y pospuesto** (deshabilitado temporalmente). No bloquea el avance de las fases 15–17 ni la futura importación externa por arrastre (fases 18–19), que es independiente del arrastre interno del explorador.

## Qué está implementado (conservado, inactivo)

- Motor propio basado en Pointer Events + Motion en `src/dnd-explorer/` (`types.ts`, `geometry.ts`, `useExplorerDnd.ts`, `DragOverlay.tsx`, `config.ts`).
- Integración en `src/components/FolderExplorer.tsx` (reordenación/inserción de archivos, movimiento a carpeta, reordenación/movimiento jerárquico de carpetas, auto-expansión con retardo, autoscroll, clon, resolución de drop/cancelación, persistencia de expansión en éxito) reutilizando `moveLocalPath`, proyección optimista y persistencia de orden existentes.
- Utilidades de expansión y pruebas relacionadas: `src/utils/dndExpansion.ts`, `tests/dndExpansionPaths.test.ts` (y ajustes estructurales en pruebas de persistencia cuando aplicó).
- Prototipo aislado: `src/pages/DndPrototype.tsx` (ruta `/__dnd-prototype`, registrada solo en entorno de desarrollo).
- `@hello-pangea/dnd` sigue instalado pero sin uso en el explorador.

## Problemas pendientes (razón del aplazamiento)

Validación real en **Tauri/WebKitGTK (Fedora)** mostró inestabilidad y el esfuerzo de estabilización desvió el avance del resto de mejoras:

- Oscilación/inestabilidad del índice de inserción y retroalimentación geometría↔hueco en contenedores dinámicos durante el arrastre (parcialmente mitigada en código, sin validación final satisfactoria).
- Sensibilidad del ciclo de vida de puntero/captura y diferencias de comportamiento frente a Chromium (WebKitGTK no es representativo por pruebas en Chromium).
- Geometría dinámica en expandir/colapsar/desplazar/redimensionar durante el arrastre, animaciones/fluidity y ausencia de saltos/solapes/teleports/duplicados aún por confirmar en runtime real.
- Casos por cerrar: auto-expansión sucesiva fiable, inserción en notas recién reveladas, reordenación jerárquica de carpetas con desplazamiento compatible, autoscroll, persistencia de expansión/scroll en todos los casos, soporte táctil fino y ausencia de clic accidental, todo en WebKitGTK/Fedora.

Evidencia diagnóstica previa (instrumentación temporal, ya desactivada): `~/Documentos/lyra/dnd-debug.log` (trazas de sesiones de arrastre en WebKitGTK).

## Cómo reactivar

1. En `src/dnd-explorer/config.ts` cambiar `EXPLORER_DND_ENABLED` a `true` (`DND_PROTOTYPE_ROUTE_ENABLED` ya se limita a desarrollo).
2. El hook `useExplorerDnd` y la integración de `FolderExplorer` vuelven a activarse con el flag; la ruta `/__dnd-prototype` queda disponible en `pnpm tauri dev`/dev.
3. Para diagnóstico en runtime real, puede reactivarse un logger de archivo temporal dentro de `$DOCUMENT/**` (p. ej. reutilizando `src/utils/dndDebug.ts`, que se conserva) e inicializarlo en `src/main.tsx`; evitar ampliar permisos de Tauri.
4. Validar en Tauri/WebKitGTK (Fedora) antes de dar por cerradas las fases 10–14: arrastre básico estable, reorden/inserción intra/inter-contenedor y multinivel, auto-expansión 550 ms, movimiento jerárquico de carpetas sin ciclos, scroll/autoscroll, persistencia de expansión en éxito y restauración en cancelación/error, sin saltos/flicker/teleports/solapes/duplicados.

## Al retomar

- Priorizar estabilidad en WebKitGTK sobre paridad con Chromium.
- No modificar Google Drive, backend de movimientos físicos/journals ni notas personales.
- Conservar y reutilizar `moveLocalPath`, proyección optimista y persistencia de orden/migraciones existentes.
- Si el motor no se estabiliza, conservar estos archivos para investigación y recuperar el último sistema funcional sin perder funcionalidades ya implementadas.
