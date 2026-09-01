/**
 * PdfPicker — shared PDF file picking. Uses the Electron native dialog via IPC
 * (returns the absolute path), with an <input type="file"> fallback.
 */

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export async function pickPdfFile(): Promise<{ buffer: ArrayBuffer; path: string; name: string } | null> {
  const api = window.electronAPI;
  if (api?.pickPdfFile) {
    const res = await api.pickPdfFile();
    if (!res?.data) return null;
    return { buffer: res.data, path: res.filePath, name: basename(res.filePath) };
  }
  // Browser fallback
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ buffer: await f.arrayBuffer(), path: (f as any).path ?? f.name, name: f.name });
    };
    input.click();
  });
}
