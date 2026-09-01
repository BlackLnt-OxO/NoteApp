const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  onFullScreenChanged: (callback) => {
    ipcRenderer.on('fullscreen-changed', (event, fullscreen) => callback(fullscreen));
  },

  // Float note state
  loadFloatState: (noteId) => ipcRenderer.invoke('float:loadState', noteId),
  saveFloatState: (noteId, state) => ipcRenderer.invoke('float:saveState', noteId, state),
  resetFloatState: (noteId) => ipcRenderer.invoke('float:resetState', noteId),
  updateFloatContent: (noteId, content) => ipcRenderer.invoke('float:updateContent', noteId, content),
  setFloatIgnoreMouse: (noteId, ignore) => ipcRenderer.invoke('float:setIgnoreMouse', noteId, ignore),
  onFloatPenetrateChanged: (callback) => {
    ipcRenderer.on('float:penetrateChanged', (event, enabled) => callback(enabled));
  },
  onFloatTransparentChanged: (callback) => {
    ipcRenderer.on('float:transparentChanged', (event, enabled) => callback(enabled));
  },
  onFloatContentUpdated: (callback) => {
    ipcRenderer.on('float:contentUpdated', (event, data) => callback(data));
  },

  // Floating notes
  createFloatingNote: (noteData) => ipcRenderer.invoke('floating:create', noteData),
  closeFloatingNote: (noteId) => ipcRenderer.invoke('floating:close', noteId),
  updateFloatingNote: (noteId, noteData) => ipcRenderer.invoke('floating:update', noteId, noteData),
  closeAllFloating: () => ipcRenderer.invoke('floating:closeAll'),
  updateAllFloatingFontSize: (fontSize) => ipcRenderer.invoke('floating:updateAllFontSize', fontSize),
  onFloatingClosed: (callback) => {
    ipcRenderer.on('floating:closed', (event, noteId) => callback(noteId));
  },
  onAllFloatingClosed: (callback) => {
    ipcRenderer.on('floating:allClosed', () => callback());
  },

  // Cursor
  getCursorScreenPoint: () => ipcRenderer.invoke('app:getCursorScreenPoint'),

  // Screenshot
  startScreenshot: () => ipcRenderer.invoke('screenshot:start'),
  startEyedropper: () => ipcRenderer.invoke('eyedropper:start'),
  startLongScreenshot: () => ipcRenderer.invoke('screenshot:startLongScreenshot'),
  showToast: (msg) => ipcRenderer.invoke('show-toast', msg),
  cancelScreenshot: () => ipcRenderer.invoke('screenshot:cancel'),
  onScreenshotCompleted: (callback) => {
    ipcRenderer.on('screenshot:completed', (event, result) => callback(result));
  },

  // Diagnostic
  diagSetConfig: (config) => ipcRenderer.invoke('screenshot:diag-set-config', config),
  diagGetConfig: () => ipcRenderer.invoke('screenshot:diag-get-config'),
  diagGetStats: () => ipcRenderer.invoke('screenshot:diag-get-stats'),
  diagGetLogPath: () => ipcRenderer.invoke('screenshot:diag-get-log-path'),
  diagGetModes: () => ipcRenderer.invoke('screenshot:diag-get-modes'),
  onDiagStatus: (callback) => {
    ipcRenderer.on('screenshot:diag-status', (event, data) => callback(data));
  },
  onDiagStats: (callback) => {
    ipcRenderer.on('screenshot:diag-stats', (event, data) => callback(data));
  },
  onCaptureProgress: (callback) => {
    ipcRenderer.on('screenshot:capture-progress', (event, data) => callback(data));
  },
  onPreviewUpdate: (callback) => {
    ipcRenderer.on('screenshot:preview-update', (event, data) => callback(data));
  },

  // File operations
  pickImage: () => ipcRenderer.invoke('file:pickImage'),
  pickBackground: () => ipcRenderer.invoke('file:pickBackground'),
  saveImage: (dataUrl, fileName) => ipcRenderer.invoke('file:saveImage', { dataUrl, fileName }),

  // PDF file access (annotation library)
  pickPdfFile: () => ipcRenderer.invoke('pdf:pickFile'),
  readPdfFile: (filePath) => ipcRenderer.invoke('pdf:readFile', filePath),
  pdfFileExists: (filePath) => ipcRenderer.invoke('pdf:fileExists', filePath),

  // PDF annotation persistence
  savePdfAnnotation: (itemId, data) => ipcRenderer.invoke('pdf-annotation:save', itemId, data),
  loadPdfAnnotation: (itemId) => ipcRenderer.invoke('pdf-annotation:load', itemId),
  deletePdfAnnotation: (itemId) => ipcRenderer.invoke('pdf-annotation:delete', itemId),

  // App
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),
  getDefaultBackground: () => ipcRenderer.invoke('app:getDefaultBackground'),

  // Store
  saveStore: (data) => ipcRenderer.invoke('store:save', data),
  loadStore: () => ipcRenderer.invoke('store:load'),
  loadStoreSync: () => ipcRenderer.sendSync('store:loadSync'),

  // Settings sync
  broadcastSettings: (settings) => ipcRenderer.invoke('settings:broadcast', settings),
  onSettingsUpdated: (callback) => {
    ipcRenderer.on('settings:updated', (event, settings) => callback(settings));
  },

  // Shortcuts
  updateShortcuts: (settings) => ipcRenderer.invoke('shortcuts:update', settings),
});
