import { create } from 'zustand';
import { fileName, isImageFile, localPathKey } from './fileTypes';

const KEY = 'stickynotes-asset-library';
interface Asset { id: string; path: string }
interface Registry { assets: Asset[]; aliases: Record<string, string> }
interface AssetLibrary extends Registry {
  available: Record<string, boolean>;
  loaded: boolean;
  previewId: string | null;
  requestedPath: string | null;
  load: () => void;
  refresh: () => Promise<void>;
  add: (paths: string[]) => void;
  relink: (id: string) => Promise<void>;
  setAvailable: (id: string, path: string, available: boolean) => void;
}

export function resolveAsset(registry: Registry, id: string): Asset | undefined {
  return registry.assets.find(asset => asset.id === (registry.aliases[id] ?? id));
}

function persist(registry: Registry) {
  localStorage.setItem(KEY, JSON.stringify(registry));
}

export const useAssetLibrary = create<AssetLibrary>((set, get) => ({
  assets: [], aliases: {}, available: {}, loaded: false, previewId: null, requestedPath: null,
  load: () => {
    if (get().loaded) return;
    try {
      const data = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      set({ assets: Array.isArray(data.assets) ? data.assets : [], aliases: data.aliases ?? {}, loaded: true });
    } catch { set({ loaded: true }); }
  },
  refresh: async () => {
    const api = window.electronAPI;
    if (!api?.checkLibraryFiles) return;
    const assets = get().assets;
    const statuses = await api.checkLibraryFiles(assets.map(asset => asset.path));
    set(state => {
      const available = { ...state.available };
      const current = new Map(state.assets.map(asset => [asset.id, asset.path]));
      let changed = false;
      assets.forEach((asset, index) => {
        if (current.get(asset.id) === asset.path && available[asset.id] !== statuses[index]) {
          available[asset.id] = statuses[index];
          changed = true;
        }
      });
      return changed ? { available } : state;
    });
  },
  setAvailable: (id, path, available) => {
    if (resolveAsset(get(), id)?.path !== path || get().available[id] === available) return;
    set(state => ({ available: { ...state.available, [id]: available } }));
  },
  add: paths => {
    const { assets, aliases } = get();
    const next = [...assets];
    const keys = new Set(assets.map(asset => localPathKey(asset.path)));
    for (const path of paths) {
      const key = localPathKey(path);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push({ id: crypto.randomUUID(), path });
    }
    persist({ assets: next, aliases });
    set({ assets: next });
    void get().refresh().catch(() => {});
  },
  relink: async id => {
    const api = window.electronAPI;
    const old = resolveAsset(get(), id);
    if (!old || !api?.pickLibraryFiles) return;
    const [path] = await api.pickLibraryFiles({ single: true, imagesOnly: isImageFile(old.path) });
    if (!path) return;
    if (isImageFile(old.path) !== isImageFile(path)) throw new Error('请为「' + fileName(old.path) + '」选择同类的文件。');
    if (!(await api.checkLibraryFiles([path]))[0]) throw new Error('所选文件无法读取。');
    if (resolveAsset(get(), id) !== old) return;
    const { assets, aliases } = get();
    const duplicate = assets.find(asset => asset.id !== old.id && localPathKey(asset.path) === localPathKey(path));
    const next = duplicate ? assets.filter(asset => asset.id !== old.id)
      : assets.map(asset => asset.id === old.id ? { ...asset, path } : asset);
    const nextAliases = { ...aliases };
    if (duplicate) {
      for (const alias of Object.keys(nextAliases)) {
        if (nextAliases[alias] === old.id) nextAliases[alias] = duplicate.id;
      }
      nextAliases[old.id] = duplicate.id;
    }
    persist({ assets: next, aliases: nextAliases });
    set(state => ({
      assets: next, aliases: nextAliases,
      available: { ...state.available, [duplicate?.id ?? old.id]: true },
    }));
  },
}));

export function showAssetPreview(id: string) {
  const asset = resolveAsset(useAssetLibrary.getState(), id);
  if (asset) useAssetLibrary.setState({ previewId: id });
}

export function rebindAsset(id: string) {
  void useAssetLibrary.getState().relink(id).catch(error => {
    window.dispatchEvent(new CustomEvent('noteapp:asset-error', { detail: String(error.message ?? error) }));
  });
}
