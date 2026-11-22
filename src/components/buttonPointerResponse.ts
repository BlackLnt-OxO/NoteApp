import { createContext, useEffect } from 'react';

export const HomeButtonResponse = createContext(false);

const TARGETS = 'button, [role="button"], [data-pointer-button], .color-swatch, .color-dot, .liquid-glass-card';

function responseTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const element = node.closest<HTMLElement>(TARGETS);
  if (!element?.closest('[data-pointer-scope]') ||
    element.matches(':disabled, [aria-disabled="true"], [data-pointer-skip]') ||
    element.closest('[inert]')) return null;
  return element;
}

export function useButtonPointerResponse() {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let target: HTMLElement | null = null;
    let lit: HTMLElement | null = null;
    let frame: number | undefined;
    let x = 0;
    let y = 0;

    const updateLight = () => {
      frame = undefined;
      if (!target?.isConnected || responseTarget(target) !== target) {
        track(null);
        return;
      }
      const box = target.getBoundingClientRect();
      if (!box.width || !box.height) return;

      const localX = Math.max(0, Math.min(1, (x - box.left) / box.width));
      const localY = Math.max(0, Math.min(1, (y - box.top) / box.height));
      const radius = target.classList.contains('liquid-glass-card')
        ? 85
        : Math.max(24, Math.min(85, Math.max(target.offsetWidth, target.offsetHeight) * .55));
      target.style.setProperty('--pointer-light-x', `${localX * 100}%`);
      target.style.setProperty('--pointer-light-y', `${localY * 100}%`);
      target.style.setProperty('--pointer-light-radius', `${radius}px`);
      target.setAttribute('data-pointer-glow', '');
      lit = target;
    };

    function track(next: HTMLElement | null, event?: PointerEvent) {
      if (lit && lit !== next) {
        // Leave the last position in place while its light fades out.
        lit.removeAttribute('data-pointer-glow');
        lit = null;
      }
      if (next && !target) document.addEventListener('pointermove', move, true);
      if (!next && target) document.removeEventListener('pointermove', move, true);
      target = next;
      if (!target || !event) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        return;
      }
      x = event.clientX;
      y = event.clientY;
      if (frame === undefined) frame = requestAnimationFrame(updateLight);
    }

    function move(event: PointerEvent) {
      if (event.pointerType === 'mouse' && !reducedMotion.matches) track(responseTarget(event.target), event);
    }
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && !reducedMotion.matches) track(responseTarget(event.relatedTarget), event);
    };
    const clear = () => track(null);
    document.addEventListener('pointerover', move, true);
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('pointercancel', clear, true);
    document.addEventListener('scroll', clear, { capture: true, passive: true });
    window.addEventListener('blur', clear);
    reducedMotion.addEventListener('change', clear);
    return () => {
      clear();
      document.removeEventListener('pointerover', move, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('pointercancel', clear, true);
      document.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
      reducedMotion.removeEventListener('change', clear);
    };
  }, []);
}
