# AGENTS.md

## What matters here

- This is a Tauri v2 + React 18 + TypeScript + Tailwind app. The UI boots from `src/main.tsx`; routes live in `src/pages/*`.
- Persistent app files live in `~/Documents/lyra/`. `verifyMainFolder()` creates the folder and the welcome file (`¡Bienvenid@ a Lyra!.txt`) on first run or when empty.
- `pnpm check` is the repo’s unified code validation gate running ESLint (`pnpm lint`), TypeScript typechecking (`pnpm typecheck`), and Rust Clippy (`pnpm lint:rust`).
- `pnpm test` executes the complete Node.js test suite (`tests/*.test.ts`).
- `pnpm run build` compiles TypeScript and creates the production web bundle.
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
pnpm run tauri build    # build completo (Rust + bundle deb, rpm y appimage)
pnpm run tauri dev      # desarrollo con hot-reload
```

> **Compatibilidad linuxdeploy en Fedora / Linux**: En distribuciones modernas (como Fedora Workstation), las bibliotecas de sistema usan reubicaciones relativas compactadas DT_RELR (`.relr.dyn`, sección ELF `0x13`). El binario `strip` interno de `linuxdeploy` no reconoce este formato y aborta el empaquetado de AppImage. El wrapper del proyecto (`scripts/tauri.js`) define automáticamente `NO_STRIP=true` y `APPIMAGE_EXTRACT_AND_RUN=1` en entornos Linux, además de autodetectar la clave de firma `~/.tauri/lyra.key`, garantizando que `pnpm run tauri build` compile y genere exitosamente todos los bundles sin errores.

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
- **Publicación y Validación Multiplataforma**: La compilación, firma y publicación oficial de instaladores Windows y Linux se delega a GitHub Actions (`.github/workflows/release.yml`). Los runners de la matriz suben binarios y firmas `.sig` individuales con `uploadUpdaterJson: false`, y el job `publish-release` ejecuta `node scripts/validate-release.js` para compilar y validar de forma atómica y centralizada el archivo `latest.json` antes de publicar la release (evitando carreras y sobreescrituras concurrentes).

## Sección de Novedades (Changelog)

- **Sin formato Markdown**: Al agregar o redactar funcionalidades en la sección de novedades (`defaultChangelog` en `src/pages/Preferences.tsx` o notas de actualización de versiones para `lyra_release_notes`), **NO usar formato markdown** (evitar negritas `**texto**`, cursivas `*texto*`, enlaces `[texto](url)`, viñetas manuales, etc.).
- Las novedades se renderizan como texto plano directo en elementos `<li>{item}</li>` dentro de la interfaz; redactar siempre texto plano, simple y directo.

## Motor de Sincronización Google Drive y Protección Antiperdida

- **Arquitectura Backend**: Ubicado en `src-tauri/src/gdrive/` (`auth.rs`, `client.rs`, `sync.rs`, `types.rs`, `mod.rs`).
- **Comandos Tauri**:
  - `gdrive_sync_now`: Orquesta la sincronización bidireccional no bloqueante con trailing sync (`SYNC_QUEUED`).
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
