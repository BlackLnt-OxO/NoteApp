import { fileKind, fileName, isImageFile } from './fileTypes';
import { useEffect, useState, type DragEvent } from 'react';

export type DroppedItem = { path: string; image?: { dataUrl: string; width: number; height: number } };

export function hasExternalFiles(transfer: DataTransfer) {
  return Array.from(transfer.types).includes('Files');
}

export function droppedPaths(transfer: DataTransfer) {
  const getPath = window.electronAPI?.getDroppedFilePath;
  return Array.from(transfer.files, file => {
    try { return getPath?.(file) || ''; }
    catch { return ''; }
  });
}

export async function validateDroppedPaths(paths: string[]) {
  const supported = paths.filter(path => ['pdf', 'doc', 'docx', 'md', 'txt', 'png', 'jpg', 'jpeg', 'webp'].includes(fileKind(path)));
  const available = await window.electronAPI?.checkLibraryFiles(supported) ?? [];
  const accepted = supported.filter((_, index) => available[index]);
  return { accepted, skipped: paths.length - accepted.length };
}

async function readDroppedImage(path: string) {
  const source = await window.electronAPI?.readLibraryImage(path);
  if (!source) throw new Error('无法读取图片。');
  const bitmap = await createImageBitmap(new Blob([source.data], { type: source.mime }));
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    const width = canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法读取图片。');
    context.drawImage(bitmap, 0, 0, width, height);
    return { width, height, dataUrl: canvas.toDataURL('image/png') };
  } finally { bitmap.close(); }
}

export async function loadDroppedItems(paths: string[]): Promise<DroppedItem[]> {
  const { accepted, skipped } = await validateDroppedPaths(paths);
  const items: DroppedItem[] = [];
  let failed = skipped;
  for (const path of accepted) {
    try { items.push({ path, image: isImageFile(path) ? await readDroppedImage(path) : undefined }); }
    catch { failed++; }
  }
  if (failed) void window.electronAPI?.showToast?.(`已跳过 ${failed} 个不支持或无法读取的文件。`);
  return items;
}

export function receiveExternalFiles(transfer: DataTransfer, commit: (items: DroppedItem[]) => void) {
  void loadDroppedItems(droppedPaths(transfer)).then(commit).catch(reportFileError);
}

export function externalFileTarget(onDrop: (event: DragEvent<HTMLElement>) => void) {
  return {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!hasExternalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!hasExternalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      onDrop(event);
    },
  };
}

export function reportFileError(error: unknown) {
  window.dispatchEvent(new CustomEvent('noteapp:asset-error', { detail: error instanceof Error ? error.message : String(error) }));
}

export async function pickReplacementDocument() {
  const [path] = await window.electronAPI?.pickLibraryFiles({ single: true }) ?? [];
  if (!path) return;
  if (isImageFile(path) || !(await validateDroppedPaths([path])).accepted.length) throw new Error('请选择可读取的文档。');
  return path;
}

export function useLocalFileOffline(path?: string) {
  const [status, setStatus] = useState<{ path: string; online: boolean }>();
  useEffect(() => {
    if (!path) return;
    let current = true;
    const check = () => void window.electronAPI?.checkLibraryFiles([path]).then(([online]) => {
      if (current) setStatus({ path, online });
    }).catch(() => {});
    check();
    window.addEventListener('focus', check);
    return () => { current = false; window.removeEventListener('focus', check); };
  }, [path]);
  return status?.path === path && status?.online === false;
}

export const droppedNoteImage = ({ path, image }: DroppedItem) => image && {
  ...image, id: crypto.randomUUID(), fileName: fileName(path),
};

export function placeDroppedItems(items: DroppedItem[], origin: { x: number; y: number }, page?: { width: number; height: number }) {
  const sized = items.map(({ path, image }) => {
    const ratio = image ? Math.min(1, Math.min(320, page ? page.width * .7 : 320) / Math.max(image.width, image.height)) : 1;
    const width = image ? image.width * ratio : Math.min(220, page?.width ?? 220);
    const height = image ? image.height * ratio : 64;
    return { path, image, width, height };
  });
  if (!sized.length) return [];
  const gap = 12;
  const firstY = page ? Math.max(0, Math.min(page.height - sized[0].height, origin.y)) : origin.y;
  const below = page ? page.height - firstY - sized[0].height : Infinity;
  const needed = sized.slice(1).reduce((space, item) => space + item.height + gap, 0);
  const upwards = below < needed && firstY > below;
  let y = upwards ? firstY + sized[0].height : firstY;
  return sized.map(({ path, image, width, height }) => {
    const top = upwards ? y - height : y;
    y += (upwards ? -1 : 1) * (height + gap);
    const box = { id: crypto.randomUUID(), createdAt: Date.now(), width, height,
      x: page ? Math.max(0, Math.min(page.width - width, origin.x)) : origin.x,
      y: page ? Math.max(0, Math.min(page.height - height, top)) : top };
    return image ? { ...box, type: 'image' as const, dataUrl: image.dataUrl }
      : { ...box, type: 'asset' as const, sourcePath: path };
  });
}
