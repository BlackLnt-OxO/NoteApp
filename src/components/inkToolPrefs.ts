/**
 * Toolbar preferences that outlive the app.
 *
 * The three quick-size swatches are set by long-pressing them, and they are a
 * TOOL preference — not part of any document. They live in the brush store
 * beside the rest of the toolbar state, which is in-memory only, so without
 * this the user's sizes silently reverted to the defaults on every launch.
 *
 * Each surface passes its own key: the canvas and the PDF toolbar keep their
 * memory separate (see useToolbarStore), and so should these.
 */

/** Matches the swatches' slider range. */
const MIN_SIZE = 1;
const MAX_SIZE = 100;

export interface QuickSizePresets {
  quickSizes: number[];
  eraserQuickSizes: number[];
}

/** A stored list is used only if it is exactly as long as the fallback and
 *  every entry is a real number in range — a corrupt record falls back rather
 *  than rendering a NaN-width swatch. */
function sanitize(value: unknown, fallback: number[]): number[] | null {
  if (!Array.isArray(value) || value.length !== fallback.length) return null;
  const out: number[] = [];
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out.push(Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(v))));
  }
  return out;
}

export function loadQuickSizes(storageKey: string, fallback: QuickSizePresets): QuickSizePresets {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    return {
      quickSizes: sanitize(data?.quickSizes, fallback.quickSizes) ?? fallback.quickSizes,
      eraserQuickSizes: sanitize(data?.eraserQuickSizes, fallback.eraserQuickSizes) ?? fallback.eraserQuickSizes,
    };
  } catch {
    return fallback; // unreadable / corrupt — defaults are always safe
  }
}

export function saveQuickSizes(storageKey: string, sizes: QuickSizePresets): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sizes));
  } catch {
    /* quota / private mode — the sizes just won't survive this session */
  }
}
