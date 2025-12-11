# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lyra is a focused writing application built with Tauri v1, React 18, TypeScript, and Tailwind CSS. It's a distraction-free text editor that stores files locally in the user's Documents folder (`Documents/lyra/`). The app works offline and supports bilingual content (Spanish/English).

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
Creates MSI installer for Windows with Spanish language support.

## Architecture

### Frontend Structure

**State Management (Zustand):**
- `configStore.ts`: UI configuration (paper menu, spellcheck, header visibility)
- `fileStore.ts`: File management (file list, selected file, edit state)
- `searchStore.ts`: Search/filter functionality

**Core Hooks:**
- `useFile.ts`: File operations via Tauri APIs (CRUD operations on `.txt` files)
- `useStorage.ts`: LocalStorage wrapper for user preferences
- `usePreferences.ts`: Manages theme, language, font, and alignment settings
- `useLoading.ts`: Loading state management

**Pages:**
- `Presentation.tsx`: Landing page, initializes main folder
- `List.tsx`: File list view with search/filter
- `FileContent.tsx`: Rich text editor using TinyMCE with auto-save
- `Preferences.tsx`: Settings (theme, language, font, alignment)
- `Support.tsx`: Help and support information
- `MyFiles.tsx`: Opens system folder containing user files

**Key Components:**
- `TinyEditor.tsx`: Rich text editor component using TinyMCE (local installation in `/public/tinymce/`)

**Key Utilities:**
- `commands.ts`: Keyboard shortcuts and UI commands
- `helpers.ts`: File validation, theme management, system language detection, main folder initialization
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

- **TinyMCE 6**: Rich text editor with local installation
- **Location**: `/public/tinymce/` (self-hosted, no CDN)
- **Package**: `@tinymce/tinymce-react` for React integration
- **Features**: Minimal UI for distraction-free writing, auto-save, word count, theme-aware
- **Configuration**: Simple setup with no toolbar/menubar, focuses on pure writing experience
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
Implemented with Mousetrap library, bound globally. Commands include fullscreen toggle, text size adjustment, and spellcheck toggle.

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
- Optimizes react-select dependency

**Tauri Bundle:**
- Target: MSI installer (Windows)
- Spanish language for installer
- Custom dialog/banner images in `src-tauri/assets/`
- Includes silent webview installation

**Rust Release Profile:**
Optimized for size: LTO enabled, panic=abort, opt-level="z", symbols stripped.
