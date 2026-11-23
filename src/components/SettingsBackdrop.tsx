import { useLayoutEffect, useRef } from 'react';

const FROST_RADIUS = 16;
const CACHE_SCALE = .5;

export default function SettingsBackdrop({ wallpaper }: { wallpaper: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const source = document.querySelector<HTMLImageElement>('img[data-workspace-background]');
    if (!wallpaper || !source) {
      canvas.hidden = true;
      return;
    }

    let frame: number | undefined;
    const draw = () => {
      frame = undefined;
      const target = canvas.getBoundingClientRect();
      const sourceRect = source.getBoundingClientRect();
      const { width, height } = target;
      const { width: viewWidth, height: viewHeight } = sourceRect;
      if (!width || !height || !viewWidth || !viewHeight || !source.complete || !source.naturalWidth) return;

      const cover = Math.max(viewWidth / source.naturalWidth, viewHeight / source.naturalHeight);
      const x = (target.left - sourceRect.left - (viewWidth - source.naturalWidth * cover) / 2) / cover;
      const y = (target.top - sourceRect.top - (viewHeight - source.naturalHeight * cover) / 2) / cover;
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
    const shell = canvas.parentElement;
    shell?.addEventListener('animationend', schedule);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      source.removeEventListener('load', schedule);
      shell?.removeEventListener('animationend', schedule);
      window.removeEventListener('resize', schedule);
      delete canvas.dataset.ready;
    };
  }, [wallpaper]);

  return <canvas ref={ref} className="settings-frost-cache" aria-hidden="true" />;
}
