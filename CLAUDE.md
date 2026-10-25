# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lyra is a focused writing application built with Tauri v2, React 18, TypeScript, and Tailwind CSS. It's a distraction-free text editor that stores files locally in the user's Documents folder (`Documents/lyra/`). The app works offline and supports bilingual content (Spanish/English).

## Build & Development Commands

**Development:**
```bash
cd lyra && pnpm run dev
```
Starts both the Vite dev server (port 1420) and Tauri dev mode.

**Type checking:**
```bash
cd lyra && pnpm run build
```
IMPORTANT: This is the ONLY way to type-check TypeScript in this environment. Do NOT use `tsc` or `npx tsc` directly.

**Production build:**
```bash
cd lyra && pnpm run tauri build
```
Creates installers/bundles for the target platform.

**Automated Release & Auto-Update:**
```bash
pnpm newversion         # Bumps patch (2.0.1 -> 2.0.2), builds, signs, tags, and creates GitHub Release
pnpm newversion minor   # Bumps minor (2.0.1 -> 2.1.0)
pnpm newversion major   # Bumps major (2.0.1 -> 3.0.0)
pnpm newversion 2.0.5   # Specific version
```

## Architecture

### Frontend Structure

**State Management (Zustand):**
- `configStore.ts`: UI configuration (paper menu, spellcheck, header visibility, theme ticks)
- `fileStore.ts`: File management (file list, selected file, edit state)
- `searchStore.ts`: Search, sort and filter functionality
- `toastStore.ts`: In-app notification toast alerts

**Core Hooks:**
- `useFile.ts`: File operations via Tauri APIs (CRUD operations on `.txt` and `.md` files)
- `useStorage.ts`: LocalStorage wrapper for user preferences and reactivity
- `usePreferences.ts`: Manages theme, font, alignment, and display settings

**Pages:**
- `List.tsx`: File list view with search, sort, and modal actions
- `FileContent.tsx`: Plain text editor view with auto-save, FIFO write queue, and draft recovery
- `Preferences.tsx`: Settings (theme, font, alignment, paragraph focus, open documents folder)

**Key Components:**
- `TinyEditor.tsx`: Controlled textarea editor component with Zen-mode auto-hide, search/replace, and caret scrolling
- `EditorDebugHUD.tsx`: Floating on-screen diagnostic HUD for inspecting events, selection, and paragraph focus transitions (commented out by default in `TinyEditor.tsx`)
- `SearchReplaceModal.tsx`: In-editor search and replace modal with case-sensitivity matching
- `ModalInfo.tsx`: Document statistics modal (word count, reading time, characters, dates)
- `ModalSort.tsx`: File sorting options modal

**Key Utilities:**
- `updater.ts`: Handles automatic background and manual update checks via `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`.
- `editorDebug.ts`: High-resolution telemetry logger (`editorDebug`), attaches to `window.__lyraDebug` and exports logs to `~/Documents/lyra/editor_debug.log`
- `helpers.ts`: File validation, reserved names protection, theme management, main folder initialization
- `consts.ts`: Application constants (pages, themes, text sizes, base directory)
- `dictionary.ts`: Bilingual translations (ES/EN)

### Backend (Tauri)

**Rust Configuration:**
- Minimal Tauri setup with scoped filesystem access
- Enabled features: window management, file operations (read/write/rename/delete), shell open
- File scope: `$DOCUMENT/**/**` (access only to Documents folder)
- No custom Rust commands; uses built-in Tauri APIs only

**File Storage:**
- Base directory: User's Documents folder
- Main folder: `Documents/lyra/`
- File format: Plain text `.txt` files
- Auto-creates welcome file on first run (language-dependent)

### Routing

Uses React Router v6 with View Transitions API for smooth page transitions. All navigation goes through `helpers.navigation()` function which wraps `startViewTransition`.

### Styling

- Tailwind CSS with custom configuration
- Theme system: "sunny-day" (light), "clear-nigth", "dark-nigth" (dark variants)
- Font options: IA Writer Duo, Sarabun
- Responsive design with mobile support

### Text Editor

- **Native `<textarea>`**: Plain text editor
- **Features**: Auto-save, word count, theme-aware
- **Customization**: Respects user preferences (font size, alignment, opacity, letter spacing)

## Important Technical Details

**TypeScript Configuration:**
- Strict mode enabled
- No unused locals/parameters allowed
- Target: ES2020
- Module resolution: bundler

**Component Export Pattern:**
All React components use default inline function exports:
```typescript
export default function ComponentName(): Component {
  // component logic
}
```

**File Operations:**
All file operations use `BASE_DIRECTORY.Document` and work with relative paths inside `MAIN_FOLDER` constant. Files are automatically suffixed with `.txt`.

**Keyboard Shortcuts:**
Implemented with native window keyboard event listeners. Commands include fullscreen toggle, text size adjustment, undo/redo, and search.

**Error Handling:**
The `verifyMainFolder()` function in `helpers.ts` initializes the main folder and creates a welcome file on first run. Errors must be typed as `unknown` and checked with `instanceof Error`.

## Common Patterns

**Zustand Store Usage:**
```typescript
const { stateVar, setStateVar } = storeInstance();
```

**File Path Construction:**
Always use Tauri's `join()` function from `@tauri-apps/api/path` to construct paths:
```typescript
const pathFile: string = await join(MAIN_FOLDER, `${fileName}.txt`);
```

**Navigation:**
```typescript
const { goTo } = navigation();
goTo(PAGES.list); // with view transition
```

**Notifications:**
```typescript
notification("success", "Message"); // or "error"
```

## Build Configuration

**Vite:**
- Dev server on port 1420 (strict)
- React plugin with automatic JSX transform

**Tauri Bundle:**
- Target: MSI installer (Windows)
- Spanish language for installer
- Custom dialog/banner images in `src-tauri/assets/`
- Includes silent webview installation

## Auto-Updates (Tauri Updater)

Lyra uses the official Tauri v2 Updater (`tauri-plugin-updater` and `@tauri-apps/plugin-updater`):
- **Endpoint**: `https://github.com/gixi404/lyra/releases/latest/download/latest.json`
- **Signing Key**: Public key configured in `src-tauri/tauri.conf.json`. Private key generated at `~/.tauri/lyra.key`.
- **Workflow**:
  - Silent automatic check 3s after startup in `src/main.tsx`.
  - Manual button in `src/pages/Preferences.tsx`.
  - Updates download in the background and notify the user before restarting with `@tauri-apps/plugin-process`.
- **Building signed releases**:
  ```bash
  export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/lyra.key)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  pnpm run tauri build
  ```

## Editor Diagnostics & Debugging

The repository includes a telemetry and live HUD system for diagnosing cursor, caret, and paragraph focus behaviors:
- **Module**: `src/utils/editorDebug.ts` records `[EVENT]`, `[STATE]`, `[RENDER]`, and `[TRANSITION]` with millisecond timestamps.
- **HUD Component**: `src/components/EditorDebugHUD.tsx` renders an on-screen collapsible HUD with live metrics and file export.
- **Enabling HUD**: In `src/components/TinyEditor.tsx`, uncomment the import `// import EditorDebugHUD from "./EditorDebugHUD";` and the JSX `<EditorDebugHUD ... />`.
- **Exporting Logs**: Click "Guardar Log" in the HUD, or execute `window.__lyraDebug.saveToFile()` in the browser devtools. The log file is written directly to `~/Documents/lyra/editor_debug.log`.

**Rust Release Profile:**
Optimized for size: LTO enabled, panic=abort, opt-level="z", symbols stripped.
