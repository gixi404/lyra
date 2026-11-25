# Estado de fases 15–17 (preparadas para validación manual)

## Estado
- **Fase 15 (colores de carpetas):** implementada.
- **Fase 16 (iconos de carpetas):** implementada.
- **Fase 17 (nombres visibles vs físicos):** implementada.
- **Fases 10–14 (drag-and-drop interno):** retomadas con `@dnd-kit/react` y habilitadas mediante `EXPLORER_DND_ENABLED`; la validación final en las aplicaciones instaladas de Fedora y Windows 11 sigue pendiente. Google Drive sigue fuera del alcance.

## Validaciones automáticas previas (última ejecución antes de esta pausa)
- `pnpm check` ✅
- `pnpm test` ✅ (416/416)
- `pnpm run build` ✅

## Cobertura funcional implementada
- Color e icono por carpeta/subcarpeta, independientes (sin herencia), con paleta/iconos predefinidos, combinables, persistentes y aplicados de inmediato; remapeo en movimientos/renombrados.
- Nombres visibles separados del nombre físico cuando es necesario: conservación exacta del visible, alineación física cuando es compatible entre Linux/Windows/macOS, generación de físico alternativo legible/único sin sobrescritura cuando no, preservación de extensión/formato, ocultación de `.txt/.md` y visibilidad de extensiones técnicas.
- Uso coherente de nombres visibles en explorador, búsqueda, menús, diálogos, información, archivados y selectores; operaciones internas por ruta física/identidad existente.
- Metadatos locales (`folderColors`, `folderIcons`, `noteVisibleNames`, `folderVisibleNames`) con remapeo/limpieza y fallback a nombre físico/apariencia por defecto ante ausencia, corrupción o asociación no verificable.

## Limitación pendiente de mejora (no bloqueante)
- La detección de carpetas que reaparecen no garantiza identificar una **sustitución externa de una carpeta en la misma ruta ocurrida íntegramente entre dos lecturas consecutivas** del explorador (sin desaparición observada y sin verificación inequívoca de identidad de carpeta en frontend). En esos casos ambiguos puede conservarse temporalmente la personalización hasta una señal/lectura que permita invalidarla; cuando no pueda establecerse continuidad, debe priorizarse la apariencia/nombre por defecto. Mejora pendiente sin bloquear el avance.

## Lista para validación manual breve
- Personalización y persistencia de colores e iconos.
- Creación y renombrado con caracteres especiales.
- Conservación de nombres visibles y apariencia al mover, archivar y recuperar elementos.
- Persistencia después de reiniciar Lyra.
- Visualización correcta de extensiones.

Si la validación es satisfactoria, se cierran las fases 15–17 y se avanza con las fases 18–19 (importación de archivos externos, formatos adicionales y apertura desde el sistema operativo). Drag-and-drop interno deshabilitado y Google Drive fuera del alcance.
