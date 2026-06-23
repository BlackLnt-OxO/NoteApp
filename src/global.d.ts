export {};

declare global {
  interface Window {
    electronAPI?: {
      minimize: () => Promise<void>;
      maximize: () => Promise<boolean>;
      close: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      createFloatingNote: (noteData: any) => Promise<string>;
      closeFloatingNote: (noteId: string) => Promise<boolean>;
      updateFloatingNote: (noteId: string, noteData: any) => Promise<boolean>;
      closeAllFloating: () => Promise<boolean>;
      updateAllFloatingFontSize: (fontSize: number) => Promise<boolean>;
      loadFloatState: (noteId: string) => Promise<any>;
      saveFloatState: (noteId: string, state: any) => Promise<boolean>;
      updateFloatContent: (noteId: string, content: string) => Promise<boolean>;
      setFloatIgnoreMouse: (noteId: string, ignore: boolean) => Promise<boolean>;
      onFloatContentUpdated: (callback: (data: any) => void) => void;
      onFloatingClosed: (callback: (noteId: string) => void) => void;
      onAllFloatingClosed: (callback: () => void) => void;
      getCursorScreenPoint: () => Promise<{x:number,y:number}>;
      startScreenshot: () => Promise<boolean>;
      startEyedropper: () => Promise<string | null>;
      startLongScreenshot: () => Promise<boolean>;
      cancelScreenshot: () => Promise<boolean>;
      showToast: (msg: string) => Promise<boolean>;
      onScreenshotCompleted: (callback: (result: any) => void) => void;
      pickImage: () => Promise<{ dataUrl: string; filePath: string } | null>;
      pickBackground: () => Promise<{ dataUrl: string; filePath: string } | null>;
      saveImage: (dataUrl: string, fileName: string) => Promise<string>;
      getPath: (name: string) => Promise<string>;
      getDefaultBackground: () => Promise<string | null>;
      saveStore: (data: any) => Promise<boolean>;
      loadStore: () => Promise<any>;
      loadStoreSync: () => any;
    };
  }
}
