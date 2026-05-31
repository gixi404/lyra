# AGENTS.md

## What matters here

- This is a Tauri v1 + React 18 + TypeScript + Tailwind app. The UI boots from `src/main.tsx`; routes live in `src/pages/*`.
- Persistent app files live in `~/Documents/lyra/`. `verifyMainFolder()` creates the folder and a welcome file on first run.
- `pnpm run build` is the repo’s verification gate; it is the only TypeScript type-check path defined here. There is no separate test script.
- `pnpm run dev` starts Vite on port `1420`; Tauri expects that port.
- `pnpm run tauri build` is the packaged Windows MSI build.

## Repo-specific gotchas

- `src-tauri/tauri.conf.json` still uses `npm run dev` / `npm run build` in its Tauri pre-commands. Don’t “fix” that casually without checking the wrapper behavior.
- TypeScript is strict (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`), so avoid dead bindings and loose refactors.
- Tauri filesystem access is scoped to `$DOCUMENT/**/**`; keep file-path work inside the Documents folder and use `@tauri-apps/api/path` `join()` instead of string concatenation.
- TinyMCE is self-hosted from `public/tinymce/`; keep it local.

## Code shape to expect

- React components in this repo commonly use default inline function exports.
- Shared UI/app logic is split across `src/components/`, `src/hooks/`, `src/store/`, and `src/utils/`.
- Existing repo guidance also lives in `CLAUDE.md`; trust package/config files over prose when they disagree.
