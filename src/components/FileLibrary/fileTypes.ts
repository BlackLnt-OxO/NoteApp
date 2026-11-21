export type FileKind = 'pdf' | 'doc' | 'docx' | 'md' | 'txt' | 'png' | 'jpg' | 'jpeg' | 'webp' | 'sequence';

export interface PreparedFile {
  paths: string[];
  kind: FileKind;
  name: string;
  sizeBytes: number;
  digest: string;
  data: ArrayBuffer;
}

export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
export const localPathKey = (path: string) => path.replace(/\//g, '\\').toLowerCase();
export const fileKind = (path: string) => fileName(path).split('.').pop()?.toLowerCase() ?? '';
export function isImageFile(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'webp'].includes(fileKind(path));
}
export function fileTypeLabel(kind: string): string {
  return kind === 'sequence' ? '图片序列' : (kind || '文件').toUpperCase();
}

export interface LinkedAssetObject {
  id: string;
  type: 'asset';
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: number;
}

export interface AssetPlacement {
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
