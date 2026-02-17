// --- START OF FILE main.js ---

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  clipboard,
  nativeImage
} = require('electron')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const fs = require('fs').promises
const fsSync = require('fs')
const { execFile } = require('child_process')
const fastGlob = require('fast-glob')
const { pathToFileURL, fileURLToPath } = require('url')

// Keep dev and packaged builds on the same persistent profile path.
const PERSISTENT_PROFILE_DIR = 'Hanasato'
const LEGACY_PROFILE_DIRS = ['hanasato', 'local-image-viewer']
const LEGACY_DATA_HOME_DIRS = ['Hanasato', 'hanasato', 'local-image-viewer']
const FORCED_USER_DATA_PATH = process.env.HANASATO_USER_DATA_DIR

function hasPersistentState(dirPath) {
  try {
    const localStorageDir = path.join(dirPath, 'Local Storage', 'leveldb')
    if (fsSync.existsSync(localStorageDir)) {
      const entries = fsSync.readdirSync(localStorageDir)
      if (entries.length > 0) return true
    }
    return fsSync.existsSync(path.join(dirPath, 'Preferences'))
  } catch (error) {
    return false
  }
}

function migrateLegacyProfileIfNeeded(preferredPath) {
  if (fsSync.existsSync(preferredPath)) return

  const appDataRoot = app.getPath('appData')
  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const candidates = [
    ...LEGACY_PROFILE_DIRS.map(dirName => path.join(appDataRoot, dirName)),
    ...LEGACY_DATA_HOME_DIRS.map(dirName => path.join(dataHome, dirName))
  ]
  const source = candidates.find(hasPersistentState)
  if (!source) return

  try {
    fsSync.cpSync(source, preferredPath, {
      recursive: true,
      errorOnExist: false,
      force: false
    })
  } catch (error) {
    console.warn('Legacy profile migration failed:', error.message)
  }
}

const preferredUserDataPath = path.join(app.getPath('appData'), PERSISTENT_PROFILE_DIR)
if (FORCED_USER_DATA_PATH) {
  const resolvedUserDataPath = path.resolve(FORCED_USER_DATA_PATH)
  fsSync.mkdirSync(resolvedUserDataPath, { recursive: true })
  app.setPath('userData', resolvedUserDataPath)
} else {
  migrateLegacyProfileIfNeeded(preferredUserDataPath)
  app.setPath('userData', preferredUserDataPath)
}

console.log(
  '[startup] name=%s packaged=%s userData=%s',
  app.getName(),
  app.isPackaged ? 'yes' : 'no',
  app.getPath('userData')
)
console.log('[thumb-cache] dir=%s', path.join(app.getPath('userData'), 'thumb-cache'))

let mainWindow

// --- PERFORMANCE OPTIMIZATIONS for Zen4 + NVIDIA Blackwell ---
// GPU acceleration - safe defaults that work with NVIDIA
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-accelerated-2d-canvas')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode')

// Enable safe performance features
app.commandLine.appendSwitch('enable-features', [
  'CanvasOopRasterization',      // Out-of-process canvas rasterization
  'ParallelDownloading',         // Parallel resource loading
  'BackForwardCache'             // Cache navigation history
].join(','))

// Disable features that hurt performance on Linux
app.commandLine.appendSwitch('disable-features', [
  'UseChromeOSDirectVideoDecoder', // Not needed on Linux
  'CalculateNativeWinOcclusion',   // Windows-only
  'MediaFoundationVideoCapture',   // Windows-only
  'Vulkan'                         // Wayland + Vulkan is noisy/unstable in Electron
].join(','))

// Memory optimizations for large galleries
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')
app.commandLine.appendSwitch('disk-cache-size', '536870912')  // 512MB disk cache

// GPU rasterization tuning
app.commandLine.appendSwitch('num-raster-threads', '4')  // Match Zen4 CCX topology

// Wayland/KDE optimizations (Arch Linux + KDE Plasma)
if (process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

// Cache for starred status checks
const starredCache = new Map()
let starredCacheDir = null
const videoThumbnailCache = new Map()
const videoInfoCache = new Map()
const VIDEO_CACHE_VERSION = 'v2'
const IMAGE_THUMBNAIL_CACHE_VERSION = 'v1'
const DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE = 384
const LEGACY_IMAGE_THUMBNAIL_MAX_SIDE = 640
const IMAGE_THUMBNAIL_MAX_CONCURRENCY = 1
const imageThumbnailUrlCache = new Map()
const imageThumbnailInFlight = new Map()
const imageThumbnailCacheDir = path.join(app.getPath('userData'), 'thumb-cache')
const imageThumbnailQueue = []
let imageThumbnailActive = 0
const imageThumbnailStats = {
  requests: 0,
  memoryHits: 0,
  diskHits: 0,
  generated: 0,
  ffmpegGenerated: 0,
  fallbackGenerated: 0,
  failed: 0
}

function logImageThumbnailStats(reason = '') {
  const suffix = reason ? ` reason=${reason}` : ''
  console.log(
    '[thumb-stats]%s req=%d mem=%d disk=%d gen=%d ffmpeg=%d fallback=%d fail=%d',
    suffix,
    imageThumbnailStats.requests,
    imageThumbnailStats.memoryHits,
    imageThumbnailStats.diskHits,
    imageThumbnailStats.generated,
    imageThumbnailStats.ffmpegGenerated,
    imageThumbnailStats.fallbackGenerated,
    imageThumbnailStats.failed
  )
}

function getVideoCacheKey(filePath) {
  const normalizedPath = path.normalize(filePath)
  try {
    const stats = fsSync.statSync(normalizedPath)
    return `${VIDEO_CACHE_VERSION}::${normalizedPath}::${stats.size}::${Math.floor(stats.mtimeMs)}`
  } catch (error) {
    return `${VIDEO_CACHE_VERSION}::${normalizedPath}::missing`
  }
}

function getImageThumbnailCacheKey(filePath, maxSide = DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE) {
  const normalizedPath = path.normalize(filePath)
  try {
    const stats = fsSync.statSync(normalizedPath)
    return `${IMAGE_THUMBNAIL_CACHE_VERSION}::${normalizedPath}::${stats.size}::${Math.floor(stats.mtimeMs)}::${maxSide}`
  } catch (error) {
    return `${IMAGE_THUMBNAIL_CACHE_VERSION}::${normalizedPath}::missing::${maxSide}`
  }
}

function toLocalImageUrl(filePath) {
  return pathToFileURL(filePath).href.replace('file://', 'local-image://')
}

function getImageThumbnailCacheFilePath(filePath, maxSide = DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE) {
  const cacheKey = getImageThumbnailCacheKey(filePath, maxSide)
  const fileHash = crypto
    .createHash('sha1')
    .update(cacheKey)
    .digest('hex')
  return path.join(imageThumbnailCacheDir, `${fileHash}.jpg`)
}

function getCachedImageThumbnailUrl(filePath, maxSide = DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE) {
  try {
    const thumbnailPath = getImageThumbnailCacheFilePath(filePath, maxSide)
    if (fsSync.existsSync(thumbnailPath)) {
      return toLocalImageUrl(thumbnailPath)
    }
    if (maxSide !== LEGACY_IMAGE_THUMBNAIL_MAX_SIDE) {
      const legacyPath = getImageThumbnailCacheFilePath(filePath, LEGACY_IMAGE_THUMBNAIL_MAX_SIDE)
      if (fsSync.existsSync(legacyPath)) {
        return toLocalImageUrl(legacyPath)
      }
    }
    return null
  } catch (error) {
    return null
  }
}

function processImageThumbnailQueue() {
  while (imageThumbnailActive < IMAGE_THUMBNAIL_MAX_CONCURRENCY && imageThumbnailQueue.length > 0) {
    const next = imageThumbnailQueue.shift()
    if (!next) break
    imageThumbnailActive += 1
    ;(async () => {
      let result = null
      try {
        result = await next.task()
      } catch (error) {
        result = null
      } finally {
        next.resolve(result)
        imageThumbnailActive = Math.max(0, imageThumbnailActive - 1)
        processImageThumbnailQueue()
      }
    })()
  }
}

function enqueueImageThumbnailTask(task) {
  return new Promise(resolve => {
    imageThumbnailQueue.push({ task, resolve })
    processImageThumbnailQueue()
  })
}

async function generateImageThumbnailWithFfmpeg(inputPath, outputPath, maxSide) {
  try {
    await execFileBuffer(
      'ffmpeg',
      [
        '-v', 'error',
        '-y',
        '-i', inputPath,
        '-vf', `scale=${maxSide}:${maxSide}:force_original_aspect_ratio=decrease`,
        '-frames:v', '1',
        '-q:v', '5',
        outputPath
      ],
      { timeout: 12000 }
    )
    const stat = fsSync.statSync(outputPath)
    return stat.size > 0
  } catch (error) {
    return false
  }
}

async function getImageThumbnail(filePath, maxSide = DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE) {
  const normalizedPath = path.normalize(filePath)
  imageThumbnailStats.requests += 1
  const safeMaxSide = Number.isFinite(maxSide)
    ? Math.max(128, Math.min(1024, Math.floor(maxSide)))
    : DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE
  const cacheKey = getImageThumbnailCacheKey(normalizedPath, safeMaxSide)
  if (imageThumbnailUrlCache.has(cacheKey)) {
    imageThumbnailStats.memoryHits += 1
    return imageThumbnailUrlCache.get(cacheKey)
  }
  const cachedUrl = getCachedImageThumbnailUrl(normalizedPath, safeMaxSide)
  if (cachedUrl) {
    imageThumbnailStats.diskHits += 1
    imageThumbnailUrlCache.set(cacheKey, cachedUrl)
    return cachedUrl
  }

  if (imageThumbnailInFlight.has(cacheKey)) {
    return imageThumbnailInFlight.get(cacheKey)
  }

  const task = (async () => {
    try {
      await fs.mkdir(imageThumbnailCacheDir, { recursive: true })
      const thumbnailPath = getImageThumbnailCacheFilePath(normalizedPath, safeMaxSide)

      if (!fsSync.existsSync(thumbnailPath)) {
        const generated = await enqueueImageThumbnailTask(async () => {
          let mode = ''
          let jpgBuffer = null

          const ffmpegOk = await generateImageThumbnailWithFfmpeg(
            normalizedPath,
            thumbnailPath,
            safeMaxSide
          )
          if (ffmpegOk) {
            return { ok: true, mode: 'ffmpeg' }
          }

          try {
            const thumb = await nativeImage.createThumbnailFromPath(normalizedPath, {
              width: safeMaxSide,
              height: safeMaxSide
            })
            if (thumb && !thumb.isEmpty()) {
              const encoded = thumb.toJPEG(78)
              if (encoded && encoded.length > 0) {
                jpgBuffer = encoded
                mode = 'thumb-api'
              }
            }
          } catch (error) {}

          if (!jpgBuffer) {
            try {
              const sourceImage = nativeImage.createFromPath(normalizedPath)
              if (sourceImage && !sourceImage.isEmpty()) {
                const sourceSize = sourceImage.getSize()
                const srcW = Math.max(1, Number(sourceSize.width) || 1)
                const srcH = Math.max(1, Number(sourceSize.height) || 1)
                const scale = Math.min(1, safeMaxSide / Math.max(srcW, srcH))
                const targetW = Math.max(1, Math.round(srcW * scale))
                const targetH = Math.max(1, Math.round(srcH * scale))
                const resized = sourceImage.resize({
                  width: targetW,
                  height: targetH,
                  quality: 'good'
                })
                if (resized && !resized.isEmpty()) {
                  const encoded = resized.toJPEG(76)
                  if (encoded && encoded.length > 0) {
                    jpgBuffer = encoded
                    mode = 'resize-fallback'
                  }
                }
              }
            } catch (error) {}
          }

          if (!jpgBuffer) {
            return { ok: false, mode: '' }
          }
          await fs.writeFile(thumbnailPath, jpgBuffer)
          return { ok: true, mode }
        })
        if (!generated?.ok) {
          imageThumbnailStats.failed += 1
          if (imageThumbnailStats.failed % 10 === 0) {
            logImageThumbnailStats('generation-failed')
          }
          return null
        }
        if (generated.mode === 'resize-fallback') {
          imageThumbnailStats.fallbackGenerated += 1
        } else if (generated.mode === 'ffmpeg') {
          imageThumbnailStats.ffmpegGenerated += 1
        } else {
          imageThumbnailStats.generated += 1
        }
        if (
          (
            imageThumbnailStats.generated +
            imageThumbnailStats.ffmpegGenerated +
            imageThumbnailStats.fallbackGenerated
          ) % 20 === 0
        ) {
          logImageThumbnailStats('generated')
        }
      }

      const thumbUrl = toLocalImageUrl(thumbnailPath)
      imageThumbnailUrlCache.set(cacheKey, thumbUrl)
      return thumbUrl
    } catch (error) {
      return null
    } finally {
      imageThumbnailInFlight.delete(cacheKey)
    }
  })()

  imageThumbnailInFlight.set(cacheKey, task)
  return task
}

function execFileBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...options,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr ? stderr.toString() : ''
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

async function readVideoInfo(filePath) {
  const normalizedPath = path.normalize(filePath)
  const cacheKey = getVideoCacheKey(normalizedPath)
  if (videoInfoCache.has(cacheKey)) {
    return videoInfoCache.get(cacheKey)
  }

  try {
    const { stdout } = await execFileBuffer('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height',
      '-show_entries', 'format=duration',
      '-of', 'json',
      normalizedPath
    ])
    const parsed = JSON.parse(stdout.toString('utf8'))
    const stream = parsed?.streams?.[0] || {}
    const format = parsed?.format || {}
    const info = {
      codecName: stream.codec_name || '',
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: Number(format.duration) || 0
    }
    videoInfoCache.set(cacheKey, info)
    return info
  } catch (error) {
    return null
  }
}

async function extractVideoThumbnail(filePath) {
  const normalizedPath = path.normalize(filePath)
  const cacheKey = getVideoCacheKey(normalizedPath)
  if (videoThumbnailCache.has(cacheKey)) {
    return videoThumbnailCache.get(cacheKey)
  }

  const run = async args => {
    const { stdout } = await execFileBuffer('ffmpeg', args)
    if (!stdout || stdout.length === 0) {
      throw new Error('No thumbnail data produced')
    }
    return `data:image/jpeg;base64,${stdout.toString('base64')}`
  }

  try {
    const thumb = await run([
      '-hide_banner',
      '-loglevel', 'error',
      '-i', normalizedPath,
      '-map', '0:v:0',
      '-an',
      '-sn',
      '-frames:v', '1',
      '-vf', 'thumbnail=120,scale=480:-1:force_original_aspect_ratio=decrease',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ])
    videoThumbnailCache.set(cacheKey, thumb)
    return thumb
  } catch (error) {
    try {
      const thumb = await run([
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', '00:00:01',
        '-i', normalizedPath,
        '-map', '0:v:0',
        '-an',
        '-sn',
        '-frames:v', '1',
        '-vf', 'scale=480:-1:force_original_aspect_ratio=decrease',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1'
      ])
      videoThumbnailCache.set(cacheKey, thumb)
      return thumb
    } catch (fallbackError) {
      return null
    }
  }
}

async function movePathsToTrash(paths) {
  const targets = Array.isArray(paths) ? paths : [paths]
  await Promise.all(
    targets.map(async target => {
      await shell.trashItem(path.normalize(target))
    })
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })

  mainWindow.loadFile('renderer/index.html')
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools()
  }
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('local-image', (request, callback) => {
    try {
      const fileUrl = request.url.replace('local-image://', 'file://')
      const filePath = fileURLToPath(fileUrl)
      if (fsSync.existsSync(filePath)) {
        callback({ path: filePath })
      } else {
        console.error('File not found for protocol request:', filePath)
        callback({ error: -6 })
      }
    } catch (error) {
      console.error('Protocol handler error:', error, 'for URL:', request.url)
      callback({ error: -2 })
    }
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// --- IPC HANDLERS ---

// Get path to favorites and create it if needed
ipcMain.handle('get-favorites-dir', () => {
  const picturesPath = app.getPath('pictures')
  const favoritesPath = path.join(picturesPath, 'Starred Images')

  // Create the directory on first run if it doesn't exist
  if (!fsSync.existsSync(favoritesPath)) {
    fsSync.mkdirSync(favoritesPath, { recursive: true })
  }

  // Initialize starred cache
  if (starredCacheDir !== favoritesPath) {
    starredCacheDir = favoritesPath
    starredCache.clear()
    try {
      const files = fsSync.readdirSync(favoritesPath)
      files.forEach(f => starredCache.set(f, true))
    } catch (e) {}
  }

  return favoritesPath
})

// Check if an image is starred (with caching)
ipcMain.handle('is-image-starred', async (event, sourcePath) => {
  const basename = path.basename(sourcePath)
  if (starredCache.has(basename)) {
    return starredCache.get(basename)
  }
  const picturesPath = app.getPath('pictures')
  const favoritesPath = path.join(picturesPath, 'Starred Images')
  const destinationPath = path.join(favoritesPath, basename)
  const exists = fsSync.existsSync(destinationPath)
  starredCache.set(basename, exists)
  return exists
})

// Copy an image to the favorites directory or remove if already there
ipcMain.handle('star-image', async (event, sourcePath) => {
  try {
    const picturesPath = app.getPath('pictures')
    const favoritesPath = path.join(picturesPath, 'Starred Images')
    const basename = path.basename(sourcePath)
    const destinationPath = path.join(favoritesPath, basename)

    // Check if file already exists - if so, return info for toggle
    if (fsSync.existsSync(destinationPath)) {
      return { success: true, exists: true, starredPath: destinationPath }
    }

    // Perform the copy
    await fs.copyFile(sourcePath, destinationPath)
    starredCache.set(basename, true)
    return { success: true, exists: false, message: 'Image copied to Starred folder.' }
  } catch (error) {
    console.error('Failed to star image:', error)
    throw new Error(`Could not copy file: ${error.message}`)
  }
})

ipcMain.handle('unstar-image', async (event, starredPath) => {
  try {
    if (!fsSync.existsSync(starredPath)) {
      throw new Error('File not found in starred folder')
    }
    await movePathsToTrash([starredPath])
    starredCache.set(path.basename(starredPath), false)
    return { success: true }
  } catch (error) {
    console.error('Failed to unstar image:', error)
    throw new Error(`Could not remove from starred: ${error.message}`)
  }
})

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Image Directory'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0]
  }
  return null
})

ipcMain.handle('get-images', async (event, dirPath) => {
  try {
    const normalizedDirPath = path.normalize(dirPath)
    if (!fsSync.existsSync(normalizedDirPath)) {
      throw new Error('Directory does not exist')
    }
    const mediaExtensions = ['**/*.{jpg,jpeg,png,gif,bmp,webp,svg,tiff,tif,avif,heic,heif,ico,mp4,m4v,mov,webm,mkv,avi,wmv,flv,mpeg,mpg}']
    const videoExtSet = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg'])
    const files = await fastGlob(mediaExtensions, {
      cwd: normalizedDirPath,
      absolute: true,
      caseSensitiveMatch: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      stats: true // Get stats in one pass
    })

    // Process files in batches for better performance
    const BATCH_SIZE = 100
    const images = []
    let cachedThumbCount = 0

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async entry => {
          try {
            const filePath = entry.path
            const stats = entry.stats
            const relativePath = path.relative(normalizedDirPath, filePath)
            const fileUrl = pathToFileURL(filePath).href
            const customUrl = fileUrl.replace('file://', 'local-image://')
            const extension = path.extname(filePath).toLowerCase()
            const mediaType = videoExtSet.has(extension) ? 'video' : 'image'
            const thumbnailUrl =
              mediaType === 'image'
                ? getCachedImageThumbnailUrl(filePath, DEFAULT_IMAGE_THUMBNAIL_MAX_SIDE)
                : null
            if (thumbnailUrl) cachedThumbCount += 1

            return {
              name: path.basename(filePath),
              path: relativePath,
              fullPath: filePath,
              size: stats.size,
              lastModified: stats.mtime.getTime(),
              directory: path.dirname(relativePath) === '.' ? 'Root' : path.dirname(relativePath),
              url: customUrl,
              thumbnailUrl,
              mediaType
            }
          } catch (error) {
            return null
          }
        })
      )
      images.push(...batchResults.filter(img => img !== null))
    }
    console.log(
      '[get-images] dir=%s total=%d cachedThumbs=%d',
      normalizedDirPath,
      images.length,
      cachedThumbCount
    )

    return images.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    console.error('Get images error:', error)
    throw new Error(`Failed to scan directory: ${error.message}`)
  }
})

ipcMain.handle('get-video-info', async (event, filePath) => {
  try {
    return await readVideoInfo(filePath)
  } catch (error) {
    return null
  }
})

ipcMain.handle('get-video-thumbnail', async (event, filePath) => {
  try {
    return await extractVideoThumbnail(filePath)
  } catch (error) {
    return null
  }
})

ipcMain.handle('get-image-thumbnail', async (event, filePath, maxSide) => {
  try {
    return await getImageThumbnail(filePath, maxSide)
  } catch (error) {
    return null
  }
})

ipcMain.handle('delete-image', async (event, filePaths) => {
  try {
    const pathsToDelete = Array.isArray(filePaths) ? filePaths : [filePaths]
    if (pathsToDelete.length === 0) return true

    const normalizedPaths = pathsToDelete.map(p => path.normalize(p))
    await movePathsToTrash(normalizedPaths)
    return true
  } catch (error) {
    console.error('Delete error:', error)
    throw new Error(`Failed to delete files: ${error.message}`)
  }
})

ipcMain.handle('open-file-location', async (event, filePath) => {
  try {
    const normalizedPath = path.normalize(filePath)
    if (!fsSync.existsSync(normalizedPath)) {
      throw new Error('File does not exist')
    }
    shell.showItemInFolder(normalizedPath)
    return true
  } catch (error) {
    console.error('Open file location error:', error)
    const parentDir = path.dirname(filePath)
    if (fsSync.existsSync(parentDir)) {
      await shell.openPath(parentDir)
      return true
    }
    throw new Error(`Failed to open file location: ${error.message}`)
  }
})

ipcMain.handle('open-file', async (event, filePath) => {
  try {
    const normalizedPath = path.normalize(filePath)
    if (!fsSync.existsSync(normalizedPath)) {
      throw new Error('File does not exist')
    }
    await shell.openPath(normalizedPath)
    return true
  } catch (error) {
    console.error('Open file error:', error)
    throw new Error(`Failed to open file: ${error.message}`)
  }
})

ipcMain.handle('save-edited-image', async (event, { originalPath, dataUrl, suffix }) => {
  try {
    const dir = path.dirname(originalPath)
    const ext = path.extname(originalPath)
    const base = path.basename(originalPath, ext)
    const newPath = path.join(dir, `${base}_${suffix}${ext}`)

    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await fs.writeFile(newPath, Buffer.from(base64Data, 'base64'))
    return { success: true, path: newPath }
  } catch (error) {
    console.error('Save edited image error:', error)
    throw new Error(`Failed to save image: ${error.message}`)
  }
})

ipcMain.handle('copy-image-to-clipboard', async (event, filePath) => {
  try {
    const image = nativeImage.createFromPath(filePath)
    clipboard.writeImage(image)
    return { success: true }
  } catch (error) {
    console.error('Copy to clipboard error:', error)
    throw new Error(`Failed to copy: ${error.message}`)
  }
})

ipcMain.handle('rename-image', async (event, { oldPath, newName }) => {
  try {
    const dir = path.dirname(oldPath)
    const newPath = path.join(dir, newName)
    if (fsSync.existsSync(newPath)) {
      throw new Error('A file with that name already exists')
    }
    // Copy instead of rename to preserve original
    await fs.copyFile(oldPath, newPath)
    return { success: true, newPath }
  } catch (error) {
    console.error('Rename (copy) error:', error)
    throw new Error(`Failed to copy with new name: ${error.message}`)
  }
})

// --- i18n HANDLERS ---

ipcMain.handle('get-system-locale', () => {
  return app.getLocale()
})

ipcMain.handle('get-locale-data', async (event, locale) => {
  // Handle both development and production paths
  let localesPath = path.join(__dirname, 'locales')
  console.log('Looking for locales in:', localesPath)

  if (!fsSync.existsSync(localesPath)) {
    // In production, locales are in resources folder
    localesPath = path.join(process.resourcesPath, 'locales')
    console.log('Dev path not found, trying production path:', localesPath)
  }

  // Mapping for locale variants
  const localeMapping = {
    'zh': 'zh-CN',
    'zh-Hans': 'zh-CN',
    'zh-Hant': 'zh-CN',
    'zh-TW': 'zh-CN',
    'zh-HK': 'zh-CN',
    'ja-JP': 'ja'
  }

  // Normalize locale
  let normalizedLocale = localeMapping[locale] || locale
  console.log('Requested locale:', locale, '-> Normalized:', normalizedLocale)

  // Try exact match first
  let localePath = path.join(localesPath, `${normalizedLocale}.json`)
  if (!fsSync.existsSync(localePath)) {
    // Try language code only (e.g., 'en-US' -> 'en')
    const langCode = normalizedLocale.split('-')[0]
    localePath = path.join(localesPath, `${langCode}.json`)
    console.log('Exact match not found, trying language code:', langCode)
  }

  // Fallback to English
  if (!fsSync.existsSync(localePath)) {
    localePath = path.join(localesPath, 'en.json')
    console.log('Falling back to English')
  }

  console.log('Final locale path:', localePath)

  try {
    const data = await fs.readFile(localePath, 'utf-8')
    const parsed = JSON.parse(data)
    console.log('Loaded locale:', path.basename(localePath, '.json'), 'with', Object.keys(parsed).length, 'top-level keys')
    return { locale: path.basename(localePath, '.json'), data: parsed }
  } catch (error) {
    console.error('Failed to load locale:', error)
    // Return empty object as fallback
    return { locale: 'en', data: {} }
  }
})

ipcMain.handle('get-available-locales', async () => {
  // Handle both development and production paths
  let localesPath = path.join(__dirname, 'locales')
  if (!fsSync.existsSync(localesPath)) {
    localesPath = path.join(process.resourcesPath, 'locales')
  }

  try {
    const files = await fs.readdir(localesPath)
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
  } catch (error) {
    console.error('Failed to list locales:', error)
    return ['en']
  }
})
