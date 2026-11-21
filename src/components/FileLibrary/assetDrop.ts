import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { resolveAsset, useAssetLibrary } from './assetLibrary';
import { isImageFile, type AssetPlacement } from './fileTypes';

const dropEvent = 'noteapp:asset-drop';
export const assetDropTarget = { 'data-asset-drop-target': '' };

export function dispatchAssetDrop(id: string, x: number, y: number) {
  document.elementFromPoint(x, y)?.closest('[data-asset-drop-target]')
    ?.dispatchEvent(new CustomEvent(dropEvent, { detail: { id, x, y } }));
}

export function useAssetDrop(ref: RefObject<HTMLElement>, place: (id: string, x: number, y: number) => void) {
  const latest = useRef(place);
  useLayoutEffect(() => { latest.current = place; }, [place]);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const drop = (event: Event) => {
      const { id, x, y } = (event as CustomEvent<{ id: string; x: number; y: number }>).detail;
      const rect = target.getBoundingClientRect();
      latest.current(id, x - rect.left, y - rect.top);
    };
    target.addEventListener(dropEvent, drop);
    return () => target.removeEventListener(dropEvent, drop);
  }, [ref]);
}

export async function makeAssetPlacement(assetId: string, x: number, y: number): Promise<AssetPlacement | null> {
  const state = useAssetLibrary.getState();
  const asset = resolveAsset(state, assetId);
  if (!asset || state.available[asset.id] === false) return null;
  let width = 220;
  let height = 64;
  if (isImageFile(asset.path)) {
    try {
      const result = await window.electronAPI?.readLibraryImage?.(asset.path);
      if (result) {
        const image = await createImageBitmap(new Blob([result.data], { type: result.mime }));
        const scale = Math.min(1, 320 / Math.max(image.width, image.height));
        width = Math.max(1, image.width * scale);
        height = Math.max(1, image.height * scale);
        image.close();
      }
    } catch { state.setAvailable(asset.id, asset.path, false); }
  }
  return { assetId, x, y, width, height };
}
