# AGENTS.md

## What matters here

- This is a Tauri v1 + React 18 + TypeScript + Tailwind app. The UI boots from `src/main.tsx`; routes live in `src/pages/*`.
- Persistent app files live in `~/Documents/lyra/`. `verifyMainFolder()` creates the folder and a welcome file on first run.
- `pnpm run build` is the repo’s verification gate; it is the only TypeScript type-check path defined here. There is no separate test script.
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

---

## Post-Task: Auto-Doc Sync

After completing any task with significant changes (architecture, conventions, commands, dependencies, API, schema, auth, env vars), load the `docs-autosync` skill and follow its instructions to sync project documentation.
