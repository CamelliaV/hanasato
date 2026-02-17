// --- START OF FILE preload.js ---

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getFavoritesDir: () => ipcRenderer.invoke('get-favorites-dir'),
  isImageStarred: filePath => ipcRenderer.invoke('is-image-starred', filePath),
  starImage: filePath => ipcRenderer.invoke('star-image', filePath),
  unstarImage: starredPath => ipcRenderer.invoke('unstar-image', starredPath),

  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getImages: dirPath => ipcRenderer.invoke('get-images', dirPath),
  getImageThumbnail: (filePath, maxSide) =>
    ipcRenderer.invoke('get-image-thumbnail', filePath, maxSide),
  getVideoInfo: filePath => ipcRenderer.invoke('get-video-info', filePath),
  getVideoThumbnail: filePath => ipcRenderer.invoke('get-video-thumbnail', filePath),
  deleteImage: filePaths => ipcRenderer.invoke('delete-image', filePaths),
  openFileLocation: filePath =>
    ipcRenderer.invoke('open-file-location', filePath),
  openFile: filePath =>
    ipcRenderer.invoke('open-file', filePath),
  saveEditedImage: (originalPath, dataUrl, suffix) =>
    ipcRenderer.invoke('save-edited-image', { originalPath, dataUrl, suffix }),
  copyImageToClipboard: filePath =>
    ipcRenderer.invoke('copy-image-to-clipboard', filePath),
  renameImage: (oldPath, newName) =>
    ipcRenderer.invoke('rename-image', { oldPath, newName }),

  // i18n
  getSystemLocale: () => ipcRenderer.invoke('get-system-locale'),
  getLocaleData: locale => ipcRenderer.invoke('get-locale-data', locale),
  getAvailableLocales: () => ipcRenderer.invoke('get-available-locales')
})
