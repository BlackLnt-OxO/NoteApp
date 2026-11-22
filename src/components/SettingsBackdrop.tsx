import { useLayoutEffect, useRef } from 'react';

const FROST_RADIUS = 16;
const CACHE_SCALE = .5;

export default function SettingsBackdrop({ wallpaper }: { wallpaper: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const source = canvas.closest('.settings-overlay')?.parentElement
      ?.querySelector<HTMLImageElement>('img[data-workspace-background]');
    if (!wallpaper || !source) {
      canvas.hidden = true;
      return;
    }

    let frame: number | undefined;
    const draw = () => {
      frame = undefined;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const viewWidth = source.offsetWidth;
      const viewHeight = source.offsetHeight;
      if (!width || !height || !viewWidth || !viewHeight || !source.complete || !source.naturalWidth) return;

      const cover = Math.max(viewWidth / source.naturalWidth, viewHeight / source.naturalHeight);
      // The settings shell is centered over the same object-fit: cover image.
      const x = (source.naturalWidth - width / cover) / 2;
      const y = (source.naturalHeight - height / cover) / 2;
      const padding = FROST_RADIUS * 3;
      const left = Math.max(0, x - padding / cover);
      const top = Math.max(0, y - padding / cover);
      const right = Math.min(source.naturalWidth, x + (width + padding) / cover);
      const bottom = Math.min(source.naturalHeight, y + (height + padding) / cover);
      canvas.width = Math.max(1, Math.round(width * CACHE_SCALE));
      canvas.height = Math.max(1, Math.round(height * CACHE_SCALE));
      const ctx = canvas.getContext('2d');
      if (!ctx) { canvas.hidden = true; return; }
      ctx.filter = `blur(${FROST_RADIUS * CACHE_SCALE}px) saturate(1.12)`;
      ctx.drawImage(source, left, top, right - left, bottom - top,
        (left - x) * cover * CACHE_SCALE, (top - y) * cover * CACHE_SCALE,
        (right - left) * cover * CACHE_SCALE, (bottom - top) * cover * CACHE_SCALE);
      canvas.dataset.ready = '';
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(draw);
    };

    canvas.hidden = false;
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);
    resize.observe(source);
    source.addEventListener('load', schedule);
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      source.removeEventListener('load', schedule);
      delete canvas.dataset.ready;
    };
  }, [wallpaper]);

  return <canvas ref={ref} className="settings-frost-cache" aria-hidden="true" />;
}
