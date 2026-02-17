# Repository Guidelines

## Project Structure & Module Organization
This is a compact Electron desktop app with a single renderer entry.
- `main.js`: Electron main process, window lifecycle, IPC handlers, file protocol, and OS integrations.
- `preload.js`: secure bridge (`contextBridge`) exposing approved renderer APIs.
- `renderer/index.html`: React 18 + Tailwind UI (Babel in-browser, single-file renderer).
- `locales/`: translation files (`en.json`, `zh-CN.json`, `ja.json`).
- `assets/`: icons and desktop entry metadata.
- `forge.config.js`: Electron Forge packaging config.
- `PKGBUILD`: Arch Linux package recipe.
- `out/`, `pkg/`: generated build artifacts.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm start`: run via Electron Forge.
- `npm run dev`: run `electron . --dev` (opens dev mode tooling).
- `npm run package`: create unpacked distributable output.
- `npm run make`: build platform installers/packages.
- `npm run make:linux | make:deb | make:rpm | make:zip`: Linux-focused packaging targets.
- `makepkg -si`: build/install from `PKGBUILD` on Arch.

## Coding Style & Naming Conventions
- Use JavaScript with CommonJS in main/preload; React functional components in renderer.
- Follow existing formatting: 2-space indentation, semicolon-light style.
- Use `camelCase` for functions/variables and `UPPER_SNAKE_CASE` for constants (for example `BATCH_SIZE`).
- Keep IPC channel names descriptive and kebab-case (for example `get-video-info`).
- When adding UI text, update all locale files in `locales/` in the same change.

## Testing Guidelines
No automated test suite is currently configured. Validate changes manually before opening a PR:
- Launch app, open a folder, verify scroll/loading/search/sort flows.
- Verify viewer actions (zoom, slideshow, rename/crop/resize, delete-to-trash).
- Validate i18n switching and mosaic mode behavior.
- Run packaging command(s) when touching build/release config.
If tests are introduced, prefer `*.test.js` naming near the related module or in a `tests/` directory.

## Commit & Pull Request Guidelines
Recent history mostly follows Conventional Commit style (`feat:`, `bugfix:`, `docs:`). Prefer:
- Commit format: `<type>: <imperative summary>`.
- Small, focused commits (separate refactors from feature changes).
- PRs should include: purpose, linked issue (if any), OS tested, manual test checklist, and screenshots/GIFs for UI updates.

## Security & Configuration Tips
- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Add new privileged functionality through `preload.js` APIs, not direct renderer Node access.
- Treat filesystem and protocol/IPC inputs as untrusted; validate paths and arguments.
