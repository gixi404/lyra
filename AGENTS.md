# AGENTS.md

## What matters here

- This is a Tauri v2 + React 18 + TypeScript + Tailwind app. The UI boots from `src/main.tsx`; routes live in `src/pages/*`.
- Persistent app files live in `~/Documents/lyra/`. Las notas viven en `~/Documents/lyra/workspaces/<id>/`; la raíz `lyra/` conserva preferencias, `rescatados/` y el log de depuración.
- `pnpm run build` is the repo’s verification gate for the app. Backend: `cd src-tauri && cargo test`. Frontend tests: `pnpm test` (Node `node:test`, archivos `tests/*.test.ts`); el type-check de tests es `pnpm run typecheck:test` (`tsconfig.test.json`).
- `pnpm run dev` starts Vite on port `1420`; Tauri expects that port.
- `pnpm run tauri build` is the full Rust build producing DEB, RPM, AppImage (Linux) and MSI (Windows).

## Repo-specific gotchas

- TypeScript is strict (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`), so avoid dead bindings and loose refactors.
- Tauri filesystem access is scoped to `$DOCUMENT/**/**`; keep file-path work inside the Documents folder and use `@tauri-apps/api/path` `join()` instead of string concatenation.

## Fedora / Linux build setup

Tauri v2 tiene soporte nativo para WebKitGTK 4.1. No necesita shims ni workarounds.

### Dependencias del sistema (Fedora)

```bash
sudo dnf install \
  webkit2gtk4.1-devel \
  gtk3-devel \
  glib2-devel \
  cairo-devel \
  gdk-pixbuf2-devel \
  atk-devel \
  pango-devel \
  openssl-devel \
  dbus-devel \
  pkg-config \
  gcc
```

### Build

```bash
pnpm run tauri build    # build completo (Rust + bundle)
pnpm run tauri dev      # desarrollo con hot-reload
```

## Code shape to expect

- React components in this repo commonly use default inline function exports.
- Shared UI/app logic is split across `src/components/`, `src/hooks/`, `src/store/`, and `src/utils/`.
- Existing repo guidance also lives in `CLAUDE.md`; trust package/config files over prose when they disagree.

## Editor Debugging & Diagnostics System

- **Módulo logger**: `src/utils/editorDebug.ts` implementa `editorDebug`, un logger de alta resolución (`performance.now()`) para eventos (`EVENT`), cambios de selección (`STATE`), renders (`RENDER`) y transiciones (`TRANSITION`).
- **HUD visual**: `src/components/EditorDebugHUD.tsx` es un panel flotante que permite inspeccionar la selección y estado en vivo, además de guardar logs a disco con un clic.
- **Cómo activarlo**: En `src/components/TinyEditor.tsx`, descomentar las dos líneas señaladas:
  1. `// import EditorDebugHUD from "./EditorDebugHUD";`
  2. `{/* <EditorDebugHUD ... /> */}`
- **Exportación de logs**: Al presionar "Guardar Log" (o invocar `window.__lyraDebug.saveToFile()`), se genera el archivo `~/Documents/lyra/editor_debug.log`.

## Auto-Updates (Tauri Updater)

- **Plugins**: `tauri-plugin-updater` y `tauri-plugin-process` en Cargo y NPM.
- **Clave pública**: Registrada en `src-tauri/tauri.conf.json`.
- **Clave privada**: `~/.tauri/lyra.key`.
- **Script todo-en-uno de release**:
  ```bash
  pnpm newversion              # Incrementa patch (2.0.1 -> 2.0.2), compila, firma, taggea y publica en GitHub
  pnpm newversion minor        # Incrementa minor (2.0.1 -> 2.1.0)
  pnpm newversion major        # Incrementa major (2.0.1 -> 3.0.0)
  pnpm newversion 2.0.5        # Versión explícita
  pnpm newversion --no-build   # Bump y tag rápido delegando la compilación a GitHub Actions
  ```
- **Compilar release manual con firma**:
  ```bash
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/lyra.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  pnpm run tauri build
  ```
- **Publicación**: Subir el archivo `latest.json` generado en `src-tauri/target/release/bundle/` junto con los artefactos a GitHub Releases (`https://github.com/gixi404/lyra/releases/latest/download/latest.json`).

## Sección de Novedades (Changelog)

- **Sin formato Markdown**: Al agregar o redactar funcionalidades en la sección de novedades (`defaultChangelog` en `src/pages/Preferences.tsx` o notas de actualización de versiones para `lyra_release_notes`), **NO usar formato markdown** (evitar negritas `**texto**`, cursivas `*texto*`, enlaces `[texto](url)`, viñetas manuales, etc.).
- Las novedades se renderizan como texto plano directo en elementos `<li>{item}</li>` dentro de la interfaz; redactar siempre texto plano, simple y directo.

## Espacios de Trabajo y Migración (Fase F1)

- **Layout uniforme**: las notas de la cuenta activa viven en `~/Documents/lyra/workspaces/<id>/` (`ws_001`, `ws_002`, …). Los ids son monotónicos y nunca se reutilizan.
- **Puerta de arranque**: `WorkspaceGate` (`src/components/WorkspaceGate.tsx`) solo renderiza la app cuando `workspace_get_state` responde `required: false`; mientras tanto se muestra `MigrationScreen`. La decisión es siempre del backend (`Snapshot.required`), nunca de estado local. Sin puente Tauri (navegador/Node) la puerta se omite.
- **Migración recuperable** (`src-tauri/src/workspaces/migration.rs`): diario `.lyra_migration.json` (`schema_version: 2`) con fases `preparing → copied → prepared → activated → retired`. El estado de cada nota se deriva del disco; solo se persisten las decisiones del usuario. Nunca se sobrescribe una nota: si el destino ya existe con otro contenido se conservan ambas (`KeepBoth`) o se adopta la del espacio (`AdoptDestination`), y la original va a `rescatados/`.
- **Originales**: se mueven a `lyra/rescatados/migracion-<ts>/` con `.lyra_retired.json`. Un conflicto al retirar no borra nada: la nota queda pendiente en la raíz y se resuelve de forma no destructiva (`keep_as_pending` | `move_to_rescatados`), sin bloquear el arranque indefinidamente.
- **Notas aplazadas**: siguen intactas en la raíz y se reportan como pendientes; nunca cuentan como migradas y el aviso persiste hasta resolverlas.
- **Enlaces simbólicos**: nunca se siguen ni se importan; se informan como pendientes no importables.
- **Registro**: `workspaces.json` en `app_config_dir()` (con `.bak`), reconstruible desde los marcadores `.lyra_workspace.json` de cada espacio. El marcador solo se escribe al activar (`activate`), nunca al materializar la carpeta.
- **Google Drive en F1**: la sincronización permanece bloqueada desde Rust durante toda F1, incluso si falta el diario. La sincronización y las eliminaciones remotas requieren una implementación posterior vinculada a un espacio de trabajo.
- **Rutas en el frontend**: todo acceso a notas pasa por `src/utils/workspacePaths.ts` (`getNotesDir`, `notesPath`). Antes de una instantánea válida del backend no hay directorio de notas; solo se acepta `lyra/workspaces/ws_\d{3,}`.
- **Concurrencia de migración**: el plugin de instancia única va primero; un bloqueo de archivo en `app_config_dir()` se mantiene durante la vida del proceso para cubrir sesiones Linux sin D-Bus compartido. Un error al resolver Documentos o configuración deja visible la puerta de migración y admite reintento.

## Gestión de espacios (Fase F2)

- `src-tauri/src/workspaces/management.rs` implementa creación, renombrado, selección y eliminación. Rust limita a cinco espacios y mantiene IDs monotónicos.
- El cambio de espacio espera guardados efectivos del editor. Los comandos que mutan notas reciben `expectedWorkspaceId` y Rust lo verifica bajo `MANIFEST_LOCK` antes de resolver rutas.
- Los borradores, el scroll y el estado de bienvenida se separan por ID de espacio; el espacio migrado en F1 conserva acceso a sus claves anteriores.
- Eliminar un espacio inactivo mueve su directorio completo a `rescatados/` con un diario recuperable; no borra notas. Drive permanece pausado hasta F4.

## Aislamiento de sincronización (Fase F3)

- Cada solicitud de sincronización usa `SyncRequest { workspace_id, epoch }`, validado por Rust contra el registro activo. La ruta se deriva del ID validado. Los espacios locales responden `SyncDisabled`; Google Drive sigue en pausa hasta F4.
- `src-tauri/src/workspaces/sync_context.rs` coordina propietario, solicitud rezagada, cancelación y secciones críticas. El cambio de espacio cancela la solicitud anterior y espera los efectos críticos antes de cambiar el registro.
- El frontend descarta eventos y respuestas con identidad o epoch anterior. El motor Drive heredado permanece inaccesible en producción; véase `docs/F3-sync-isolation.md` antes de conectarlo en F4.

## Motor de Sincronización Google Drive y Protección Antiperdida

- **Arquitectura Backend**: Ubicado en `src-tauri/src/gdrive/` (`auth.rs`, `client.rs`, `sync.rs`, `types.rs`, `mod.rs`).
- **Comandos Tauri**:
  - `gdrive_sync_now`: valida `SyncRequest`; responde `SyncDisabled` para espacios locales y `SyncPaused` para Drive durante F3. El motor bidireccional se conectará en F4.
  - `gdrive_delete_file`: Registra un tombstone persistente en `manifest.pending_deletions` antes de eliminar el archivo local, propagándolo inmediatamente a la papelera de Drive si hay conexión.
  - `gdrive_get_status`, `gdrive_start_auth`, `gdrive_logout`: Gestión de autenticación OAuth 2.0 PKCE.
- **Regla Fundamental Antiperdida**: La eliminación de notas o de la carpeta `lyra` directamente en Google Drive NUNCA borra archivos locales. El motor des-papela (`untrash_file`) o regenera la copia remota.
- **Restauración y Reconciliación de Notas Des-papeladas en Drive**: Si el usuario des-papela en la web de Drive una nota previamente eliminada, el motor la sincroniza y descarga a local. Si ya existe una nota local recreada con el mismo nombre, la copia remota se descarga como archivo de conflicto único y se renombra en Drive para preservar ambas notas sin pérdida de información ni sobreescrituras.
- **Aislamiento Multi-Cuenta Google Drive**:
  - Manifiestos independientes por cuenta Google utilizando el identificador estable `sub` de Google UserInfo (con fallback a email sanitizado): `.gdrive_manifest_{account_key}.json`.
  - Aislamiento completo de tombstones (`pending_deletions`), mapeo de archivos y `drive_folder_id` entre cuentas.
  - Al cerrar sesión (`gdrive_logout`), las credenciales se eliminan pero los manifiestos y respaldos se conservan para permitir alternar cuentas sin re-descargas ni pérdida de estado.
  - Validación activa de `drive_folder_id`: se valida la carpeta antes de listar mediante `check_file_status`. Errores 404 o 403 provocan el descarte del ID obsoleto y la resolución/búsqueda de la carpeta de la cuenta activa sin perder notas ni abortar.
- **Estrategia 4 Híbrida de Bajo Consumo**:
  - Escaneo local optimizado con verificación rápida de `mtime` y `size` (evita computar MD5 o leer bytes innecesariamente).
  - Validación y reutilización de `drive_folder_id` con verificación de pertenencia a la cuenta activa.
  - Sincronización rezagada (*trailing sync*) para no descartar eventos concurrentes de guardado.
  - Reintentos con retroceso exponencial, jitter y soporte de cabecera `Retry-After` para errores 429 y 5xx.
  - Sincronización por foco de ventana con acelerador/throttle de 3 minutos.

---

## Post-Task: Auto-Doc Sync

After completing any task with significant changes (architecture, conventions, commands, dependencies, API, schema, auth, env vars), load the `docs-autosync` skill and follow its instructions to sync project documentation.
