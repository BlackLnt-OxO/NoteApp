import { createContext, useEffect, useLayoutEffect, useRef } from 'react';

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

export function useButtonPointerResponse(uiScale: number) {
  const scale = useRef(uiScale);
  const refreshHit = useRef<() => void>();
  useLayoutEffect(() => {
    scale.current = uiScale;
    refreshHit.current?.();
  }, [uiScale]);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let target: HTMLElement | null = null;
    let lit: HTMLElement | null = null;
    let frame: number | undefined;
    let x = 0;
    let y = 0;
    let box: DOMRect | undefined;
    let needsHit = false;
    let lastX: string | undefined;
    let lastY: string | undefined;
    const movingElements = new WeakSet<Element>();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(invalidate);

    function isMoving(element: HTMLElement) {
      if (element.closest('[data-grid-layout-moving]')) return true;
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (movingElements.has(ancestor)) return true;
      }
      return false;
    }

    const updateLight = () => {
      frame = undefined;
      if (needsHit) {
        needsHit = false;
        track(responseTarget(document.elementFromPoint(x, y)), undefined, false);
      }
      const active = target;
      if (!active?.isConnected || responseTarget(active) !== active) {
        track(null);
        return;
      }
      const moving = isMoving(active);
      if (!box || moving) {
        box = active.getBoundingClientRect();
        const radius = active.classList.contains('liquid-glass-card')
          ? 85
          : Math.max(24, Math.min(85, Math.max(box.width, box.height) / scale.current * .55));
        active.style.setProperty('--pointer-light-radius', `${radius}px`);
      }
      if (!box.width || !box.height) return;

      const localX = Math.max(0, Math.min(1, (x - box.left) / box.width));
      const localY = Math.max(0, Math.min(1, (y - box.top) / box.height));
      const lightX = `${(localX * 100).toFixed(2)}%`;
      const lightY = `${(localY * 100).toFixed(2)}%`;
      if (lightX !== lastX) active.style.setProperty('--pointer-light-x', lightX);
      if (lightY !== lastY) active.style.setProperty('--pointer-light-y', lightY);
      lastX = lightX;
      lastY = lightY;
      if (lit !== active) {
        active.setAttribute('data-pointer-glow', '');
        lit = active;
      }
      if (moving) schedule();
    };

    function schedule() {
      if (target && frame === undefined) frame = requestAnimationFrame(updateLight);
    }

    function invalidate() {
      box = undefined;
      schedule();
    }

    function track(next: HTMLElement | null, event?: PointerEvent, queue = true) {
      if (lit && lit !== next) {
        // Leave the last position in place while its light fades out.
        lit.removeAttribute('data-pointer-glow');
        lit = null;
      }
      if (next && !target) document.addEventListener('pointermove', move, true);
      if (!next && target) document.removeEventListener('pointermove', move, true);
      if (next !== target) {
        observer?.disconnect();
        if (next) {
          observer?.observe(next);
          const viewport = next.closest('[data-glass-scroll-container]');
          if (viewport) observer?.observe(viewport);
        }
        box = undefined;
        lastX = lastY = undefined;
      }
      target = next;
      if (!target) {
        needsHit = false;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        return;
      }
      if (event) {
        x = event.clientX;
        y = event.clientY;
      }
      if (queue) schedule();
    }

    function move(event: PointerEvent) {
      if (event.pointerType === 'mouse' && !reducedMotion.matches) track(responseTarget(event.target), event);
    }
    const leave = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && !reducedMotion.matches) track(responseTarget(event.relatedTarget), event);
    };
    const clear = () => track(null);
    const scroll = () => {
      if (!target) return;
      box = undefined;
      needsHit = true;
      schedule();
    };
    refreshHit.current = scroll;
    const animation = (event: AnimationEvent) => {
      if (!(event.target instanceof Element) ||
        !['settings-enter', 'glass-grid-enter', 'scaleIn', 'slideInLeft'].includes(event.animationName)) return;
      if (event.type === 'animationstart') movingElements.add(event.target);
      else movingElements.delete(event.target);
      if (target && event.target.contains(target)) invalidate();
    };
    document.addEventListener('pointerover', move, true);
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('pointercancel', clear, true);
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    document.addEventListener('animationstart', animation, true);
    document.addEventListener('animationend', animation, true);
    document.addEventListener('animationcancel', animation, true);
    window.addEventListener('resize', invalidate);
    window.addEventListener('blur', clear);
    reducedMotion.addEventListener('change', clear);
    return () => {
      clear();
      refreshHit.current = undefined;
      document.removeEventListener('pointerover', move, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('pointercancel', clear, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('animationstart', animation, true);
      document.removeEventListener('animationend', animation, true);
      document.removeEventListener('animationcancel', animation, true);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('blur', clear);
      reducedMotion.removeEventListener('change', clear);
    };
  }, []);
}
