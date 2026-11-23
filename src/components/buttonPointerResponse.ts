import { createContext, useEffect, useLayoutEffect, useRef } from 'react';

export const HomeButtonResponse = createContext(false);

// Match the radius in buttonPointerResponse.css, measured before workspace zoom.
const LIGHT_RADIUS = 85;
const CARD_MOTION_ATTRIBUTES = ['data-grid-layout-moving', 'data-note-edit-moving'];
const MOTION_EVENTS = ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel'];
const cards = new Set<HTMLElement>();
let changeRegistration: ((element: HTMLElement, registered: boolean) => void) | undefined;

export function watchCardPointerResponse(element: HTMLElement) {
  cards.add(element);
  changeRegistration?.(element, true);
  return () => {
    cards.delete(element);
    changeRegistration?.(element, false);
  };
}

const tones = new Map<string, boolean>();
let colorSample: CanvasRenderingContext2D | null | undefined;

function readTintedCardTone(element: HTMLElement) {
  // Resolve the same mixed tint the backplate uses.
  const base = getComputedStyle(element).getPropertyValue('--card-glass-base').trim();
  if (!base) return;
  let light = tones.get(base);
  if (light === undefined) {
    if (colorSample === undefined) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      colorSample = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!colorSample) return;
    colorSample.fillStyle = '#191929';
    colorSample.fillStyle = base;
    colorSample.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(colorSample.getImageData(0, 0, 1, 1).data, value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    light = .2126 * r + .7152 * g + .0722 * b >= .23;
    if (tones.size >= 128) tones.clear();
    tones.set(base, light);
  }
  return light ? 'light' : 'dark';
}

type ScrollClip = {
  bounds: DOMRect;
  scroller: HTMLElement;
  left: number;
  top: number;
  shiftX: number;
  shiftY: number;
};

type VisibleCard = {
  element: HTMLElement;
  bounds: DOMRect;
  clip?: ScrollClip;
};

export function useCardPointerResponse(uiScale: number) {
  const refreshLayout = useRef<() => void>();
  const scale = useRef(uiScale);
  useLayoutEffect(() => {
    scale.current = uiScale;
    refreshLayout.current?.();
  }, [uiScale]);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const inView = new Set<HTMLElement>();
    const lit = new Map<HTMLElement, { x: string; y: string }>();
    const cardTones = new WeakMap<HTMLElement, { tint: string; theme?: string; tone?: string }>();
    const moving = new Set<Element>();
    let visible: VisibleCard[] = [];
    let clips = new Map<HTMLElement, ScrollClip>();
    let pointer: { x: number; y: number } | undefined;
    let frame: number | undefined;
    let layoutDirty = true;
    let scrollDirty = false;
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(invalidate);
    const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      let changed = false;
      for (const { target, isIntersecting } of entries) {
        const card = target as HTMLElement;
        if (!cards.has(card)) continue;
        if (isIntersecting && !inView.has(card)) {
          inView.add(card);
          changed = true;
        } else if (!isIntersecting && inView.delete(card)) changed = true;
      }
      if (changed) invalidate();
    });

    function schedule() {
      if ((inView.size || lit.size) && pointer && !reducedMotion.matches && frame === undefined) frame = requestAnimationFrame(updateLight);
    }

    function invalidate() {
      layoutDirty = true;
      schedule();
    }

    function measureVisible() {
      visible = [];
      const nextClips = new Map<HTMLElement, ScrollClip>();
      for (const element of inView) {
        if (!element.isConnected || !element.closest('[data-pointer-scope]') || element.closest('[inert]')) continue;
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        const scroller = element.closest<HTMLElement>('[data-glass-scroll-container]');
        let clip = scroller ? nextClips.get(scroller) : undefined;
        if (scroller && !clip) {
          clip = { bounds: scroller.getBoundingClientRect(), scroller,
            left: scroller.scrollLeft, top: scroller.scrollTop, shiftX: 0, shiftY: 0 };
          nextClips.set(scroller, clip);
        }
        visible.push({ element, bounds, clip });
      }
      for (const old of clips.keys()) if (!nextClips.has(old)) resize?.unobserve(old);
      for (const scroller of nextClips.keys()) if (!clips.has(scroller)) resize?.observe(scroller);
      clips = nextClips;
      layoutDirty = false;
      scrollDirty = false;
    }

    function updateLight() {
      frame = undefined;
      if (!pointer) return;
      for (const element of moving) if (!element.isConnected) moving.delete(element);
      if (layoutDirty || moving.size) measureVisible();
      if (scrollDirty) {
        // Scrolling translates every cached card in this viewport by the same amount.
        for (const clip of clips.values()) {
          clip.shiftX = (clip.left - clip.scroller.scrollLeft) * scale.current;
          clip.shiftY = (clip.top - clip.scroller.scrollTop) * scale.current;
        }
        scrollDirty = false;
      }
      const { x, y } = pointer;
      const radius = LIGHT_RADIUS * scale.current;
      const theme = document.documentElement.dataset.theme;
      const next: { element: HTMLElement; x: string; y: string; tone?: string }[] = [];
      const { innerWidth, innerHeight } = window;
      for (const { element, bounds, clip } of visible) {
        const cardLeft = bounds.left + (clip?.shiftX ?? 0);
        const cardTop = bounds.top + (clip?.shiftY ?? 0);
        const left = Math.max(cardLeft, clip?.bounds.left ?? 0, 0);
        const right = Math.min(cardLeft + bounds.width, clip?.bounds.right ?? innerWidth, innerWidth);
        const top = Math.max(cardTop, clip?.bounds.top ?? 0, 0);
        const bottom = Math.min(cardTop + bounds.height, clip?.bounds.bottom ?? innerHeight, innerHeight);
        if (right <= left || bottom <= top) continue;
        const dx = Math.max(0, left - x, x - right);
        const dy = Math.max(0, top - y, y - bottom);
        if (dx * dx + dy * dy >= radius * radius) continue;
        // A center outside the card keeps its actual distance to the rim.
        const lightX = `${((x - cardLeft) / bounds.width * 100).toFixed(2)}%`;
        const lightY = `${((y - cardTop) / bounds.height * 100).toFixed(2)}%`;
        const tint = element.dataset.pointerTint;
        let appearance = cardTones.get(element);
        if (tint && (appearance?.tint !== tint || appearance.theme !== theme)) {
          appearance = { tint, theme, tone: readTintedCardTone(element) };
          cardTones.set(element, appearance);
        }
        next.push({ element, x: lightX, y: lightY, tone: appearance?.tone });
      }

      const previous = new Set(lit.keys());
      for (const { element, x: lightX, y: lightY, tone } of next) {
        const last = lit.get(element);
        if (tone && element.dataset.pointerSurface !== tone) element.dataset.pointerSurface = tone;
        if (last?.x !== lightX) element.style.setProperty('--pointer-light-x', lightX);
        if (last?.y !== lightY) element.style.setProperty('--pointer-light-y', lightY);
        if (!last) element.setAttribute('data-pointer-glow', '');
        if (!last || last.x !== lightX || last.y !== lightY) lit.set(element, { x: lightX, y: lightY });
        previous.delete(element);
      }
      for (const element of previous) fade(element);
      if (moving.size) schedule();
    }

    function fade(element: HTMLElement) {
      // Preserve the last center while the CSS color transition fades out.
      element.removeAttribute('data-pointer-glow');
      lit.delete(element);
    }

    function register(element: HTMLElement, registered: boolean) {
      if (registered) {
        inView.add(element);
        intersection?.observe(element);
        resize?.observe(element);
      } else {
        inView.delete(element);
        intersection?.unobserve(element);
        resize?.unobserve(element);
        if (lit.has(element)) fade(element);
        if (!inView.size) {
          visible = [];
          for (const scroller of clips.keys()) resize?.unobserve(scroller);
          clips.clear();
        }
      }
      invalidate();
    }

    function move(event: PointerEvent) {
      if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    }

    function clear() {
      pointer = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const element of lit.keys()) fade(element);
    }

    function leave(event: PointerEvent) {
      if (event.pointerType === 'mouse' && (event.type === 'pointercancel' || !event.relatedTarget)) clear();
    }

    function scroll(event: Event) {
      if (event.target === document) invalidate();
      else if (event.target instanceof HTMLElement && clips.has(event.target)) {
        scrollDirty = true;
        schedule();
      }
    }

    function motion(event: AnimationEvent | TransitionEvent) {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      const relevant = 'animationName' in event ? event.animationName === 'glass-grid-enter'
        : (event.propertyName === 'width' && target.matches('.workspace-sidebar-track'))
          || (event.propertyName === 'grid-template-rows' && target.matches('.workspace-compact-nav'));
      if (!relevant) return;
      if (event.type === 'animationstart' || event.type === 'transitionrun') moving.add(target);
      else moving.delete(target);
      invalidate();
    }

    const layout = new MutationObserver(records => {
      let changedBounds = false;
      for (const { target, attributeName } of records) {
        if (!(target instanceof Element) || !attributeName || attributeName === 'data-pointer-tint' || attributeName === 'data-theme') continue;
        changedBounds = true;
        if (!CARD_MOTION_ATTRIBUTES.includes(attributeName)) continue;
        if (CARD_MOTION_ATTRIBUTES.some(attribute => target.hasAttribute(attribute))) moving.add(target);
        else moving.delete(target);
      }
      if (changedBounds) invalidate();
      else schedule();
    });
    layout.observe(document.documentElement, { subtree: true, attributes: true,
      attributeFilter: [...CARD_MOTION_ATTRIBUTES, 'inert', 'data-pointer-scope', 'data-pointer-tint', 'data-theme'] });
    resize?.observe(document.documentElement);
    for (const card of cards) register(card, true);
    changeRegistration = register;
    refreshLayout.current = invalidate;
    document.addEventListener('pointerover', move, { capture: true, passive: true });
    document.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('pointerout', leave, true);
    document.addEventListener('pointercancel', leave, true);
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    for (const event of MOTION_EVENTS) document.addEventListener(event, motion as EventListener, true);
    window.addEventListener('resize', invalidate);
    window.addEventListener('blur', clear);
    reducedMotion.addEventListener('change', clear);
    return () => {
      clear();
      changeRegistration = undefined;
      refreshLayout.current = undefined;
      layout.disconnect();
      resize?.disconnect();
      intersection?.disconnect();
      document.removeEventListener('pointerover', move, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerout', leave, true);
      document.removeEventListener('pointercancel', leave, true);
      document.removeEventListener('scroll', scroll, true);
      for (const event of MOTION_EVENTS) document.removeEventListener(event, motion as EventListener, true);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('blur', clear);
      reducedMotion.removeEventListener('change', clear);
    };
  }, []);
}
