# Hanasato

[简体中文](./README.zh-CN.md)

Hanasato is a local-first desktop image viewer built with Electron.

This started as a vibe coding project and has been iterated into a practical, high-speed image workflow tool for daily use.

## Screenshots

### Waterfall browsing

![Waterfall view](./imgs/屏幕截图_20260213_165555.png)
![Waterfall and controls](./imgs/屏幕截图_20260213_165512.png)

### Multi-tab and folder history

![Tabs and history panel](./imgs/屏幕截图_20260213_180133.png)
![Recent folders](./imgs/屏幕截图_20260213_180203.png)

### Full-screen viewer and gallery tools

![Viewer and gallery](./imgs/屏幕截图_20260213_165722.png)
![Image operations](./imgs/屏幕截图_20260213_165715.png)

## Feature Overview

### Library browsing
- Recursive folder scan with `fast-glob`
- Waterfall grid with adjustable columns (2-8)
- Infinite scroll loading for large libraries
- Search by filename/path/folder
- Sorting by name/date/size (ascending/descending)

### Navigation and organization
- Multi-tab browsing with per-tab state
- Back/forward folder history
- Persistent recent folders
- Drag-and-drop folder loading
- Favorites system (`Starred Images` under your Pictures directory)
- Batch selection and recycle-bin deletion

### Quick actions and menu controls
- Command palette (`Ctrl/Cmd + K`) with localized labels and hints
- Toggleable app menu (`U` by default), persisted across sessions
- Draggable floating action orb when menu is hidden
- Orb radial actions reuse the same commands as the command palette

### Viewer and editing
- Full-screen modal viewer
- Zoom (0.5x-5x), pan/drag mode, slideshow
- Copy image to clipboard
- Open file location from viewer
- Crop and resize tools (saved as new files)
- Rename via copy-with-new-name behavior

### Mosaic mode
- Dedicated mosaic/wall mode for rapid visual review
- Adjustable images-per-wall or tile-size controls
- Multiple animation modes and loop navigation

### Customization and i18n
- Multiple built-in themes
- Custom keybindings
- Behavior toggles (confirm prompts, click-outside-to-close, action feedback)
- Localized UI: `en`, `zh-CN`, `ja`

## Installation

### Windows (from source)

Prerequisites:
- Node.js 16+
- npm

Steps:

```bash
git clone https://github.com/CamelliaV/local-image-viewer.git
cd local-image-viewer
npm install
npm start
```

Build distributables:

```bash
npm run package
npm run make
```

### Linux (from source)

Prerequisites:
- Node.js 16+
- npm

Steps:

```bash
git clone https://github.com/CamelliaV/local-image-viewer.git
cd local-image-viewer
npm install
npm start
```

Build distributables:

```bash
npm run make:linux
npm run make:deb
npm run make:rpm
npm run make:zip
```

### Arch Linux

A `PKGBUILD` is included in the repository:

```bash
makepkg -si
```

## Default Shortcuts

All shortcuts are user-configurable in Settings.

### Main window

| Key | Action |
| --- | --- |
| `Ctrl/Cmd + O` | Open directory |
| `Ctrl/Cmd + K` | Open command palette |
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close tab |
| `U` | Toggle app menu |
| `F` | View favorites |
| `Backspace` | Toggle delete mode |
| `H` | Toggle history panel |
| `G` | Toggle mosaic mode |
| `,` | Open settings |
| `?` | Open help |

### Image viewer

| Key | Action |
| --- | --- |
| `ArrowLeft` / `ArrowRight` | Previous / next image |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom |
| `D` | Toggle drag mode |
| `Space` | Toggle slideshow |
| `Delete` | Delete image |
| `S` | Star / unstar image |
| `Y` | Copy to clipboard |
| `L` | Open file location |
| `X` | Toggle crop mode |
| `R` | Toggle resize mode |
| `C` | Toggle metadata drawer |
| `Escape` | Close viewer |

## Tech Stack

- Electron 40
- React 18 (CDN runtime in renderer)
- Tailwind CSS (CDN)
- fast-glob
- Electron Forge

## Project Structure

```text
.
├── main.js              # Electron main process (window, IPC, protocol)
├── preload.js           # Secure renderer API via contextBridge
├── renderer/index.html  # React UI (single-file renderer)
├── locales/             # i18n resources (en, zh-CN, ja)
├── assets/              # Icons and desktop entry
├── forge.config.js      # Packaging and fuses config
├── imgs/                # README screenshots
├── README.md            # English README
└── README.zh-CN.md      # Chinese README
```

## Security Notes

- `nodeIntegration` is disabled in the renderer
- `contextIsolation` is enabled with a narrow preload API
- Local files are served via a custom `local-image://` protocol
- Electron fuses are configured for stricter production behavior

## Supported Image Formats

`jpg`, `jpeg`, `png`, `gif`, `bmp`, `webp`, `svg`, `tiff`, `tif`, `avif`, `heic`, `heif`, `ico`

## License

MIT
