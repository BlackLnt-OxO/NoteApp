import { createGlassFilter, createGlassMap, glassSvg, updateGlassBlur, type GlassFilter, type GlassShape } from './liquidGlassFilters';

const RESIZE_SETTLE_MS = 80;
const SCROLL_SETTLE_MS = 150;
const UNUSED_FILTER_LIMIT = 8;
const ENTRANCE_TIMEOUT_MS = 120;
type GlassScope = 'workspace' | 'preview';

interface Card {
  element: HTMLElement;
  radius: number;
  visible: boolean;
  scope: GlassScope;
  useFallback?: boolean;
  width: number;
  height: number;
  resizeTimer?: number;
  filters?: FilterPair;
}

interface FilterPair {
  key: string;
  rgb: string;
  mono: string;
  scope: GlassScope;
  nodes: GlassFilter[];
  cards: Set<Card>;
  loading?: Promise<void>;
}

let controller: ReturnType<typeof createController> | undefined;
const blurByScope: Record<GlassScope, number> = { workspace: 0, preview: 0 };

export function setGlassBlur(radius: number, scope: GlassScope = 'workspace') {
  if (blurByScope[scope] === radius) return;
  blurByScope[scope] = radius;
  controller?.updateBlur(scope, radius);
}

export function prepareGlassEntrance(grid: HTMLElement, reveal: () => void) {
  if (controller) return controller.prepareEntrance(grid, reveal);
  reveal();
}

export function prepareGlassCards(elements: Element[], reveal: () => void) {
  if (controller) return controller.prepareCards(elements, reveal);
  reveal();
}

export function watchGlassCard(element: HTMLElement, radius: number, scope: GlassScope = 'workspace', immediate = false) {
  if (!window.ResizeObserver || !window.IntersectionObserver
    || !window.CSS?.supports('backdrop-filter', 'url("#noteapp-glass")')
    || !/\bChrom(?:e|ium)\//.test(navigator.userAgent)) return;

  controller ??= createController();
  return controller.watch(element, radius, scope, immediate);
}

function createController() {
  const cards = new Map<Element, Card>();
  const filters = new Map<string, FilterPair>();
  let definitions: SVGDefsElement | undefined;
  let nextId = 0;
  let scrollTimer: number | undefined;

  function activate(card: Card, pair: FilterPair) {
    card.element.style.setProperty('--glass-rgb-filter', `url("#${pair.rgb}")`);
    card.element.style.setProperty('--glass-mono-filter', `url("#${pair.mono}")`);
    card.element.dataset.glassOptics = 'true';
  }

  function discard(pair: FilterPair) {
    filters.delete(pair.key);
    for (const node of pair.nodes) node.element.remove();
  }

  function release(card: Card) {
    const pair = card.filters;
    if (!pair) return;

    card.filters = undefined;
    delete card.element.dataset.glassOptics;
    card.element.style.removeProperty('--glass-rgb-filter');
    card.element.style.removeProperty('--glass-mono-filter');
    pair.cards.delete(card);

    if (!pair.cards.size) {
      // Keep recent sizes warm when scrolling, changing workspaces or resizing.
      filters.delete(pair.key);
      filters.set(pair.key, pair);
      const unused = Array.from(filters.values()).filter(candidate => !candidate.cards.size);
      for (const expired of unused.slice(0, Math.max(0, unused.length - UNUSED_FILTER_LIMIT))) discard(expired);
    }
  }

  function makeFilters(key: string, shape: GlassShape, scope: GlassScope): FilterPair | undefined {
    let mapUrl: string | undefined;
    try { mapUrl = createGlassMap(shape); } catch { return; }
    if (!mapUrl || mapUrl === 'data:,') return;

    const id = `noteapp-glass-${++nextId}`;
    const pair: FilterPair = { key, rgb: id + '-rgb', mono: id + '-mono', scope, nodes: [], cards: new Set() };
    filters.set(key, pair);

    const map = new Image();
    map.src = mapUrl;
    if (!definitions?.isConnected) {
      const svg = glassSvg('svg', { 'aria-hidden': 'true', width: 0, height: 0 });
      svg.style.position = 'absolute';
      svg.style.pointerEvents = 'none';
      definitions = glassSvg('defs');
      svg.append(definitions);
      document.body.append(svg);
    }
    const blur = blurByScope[scope];
    pair.nodes = [createGlassFilter(pair.rgb, shape, mapUrl, true, blur), createGlassFilter(pair.mono, shape, mapUrl, false, blur)];
    // Start loading the SVG's image while the shared PNG is decoding.
    definitions.append(...pair.nodes.map(node => node.element));
    pair.loading = map.decode().then(() => {
      if (filters.get(key) !== pair) return;
      pair.loading = undefined;
      for (const card of pair.cards) activate(card, pair);
    }).catch(() => {
      if (filters.get(key) !== pair) return;
      for (const card of pair.cards) card.filters = undefined;
      pair.cards.clear();
      discard(pair);
    });

    return pair;
  }

  function refresh(card: Card) {
    if (!card.visible || card.useFallback || card.resizeTimer !== undefined || !card.width || !card.height || card.filters) return;
    const { width, height, radius, scope } = card;
    const key = `${scope}:${width}:${height}:${radius}`;
    const pair = filters.get(key) ?? makeFilters(key, { width, height, radius }, scope);
    if (!pair) return;

    pair.cards.add(card);
    card.filters = pair;
    if (!pair.loading) activate(card, pair);
  }

  function prepareEntrance(grid: HTMLElement, reveal: () => void) {
    const clip = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    for (let parent = grid.parentElement; parent; parent = parent.parentElement) {
      if (!parent.hasAttribute('data-glass-scroll-container')) continue;
      const bounds = parent.getBoundingClientRect();
      clip.left = Math.max(clip.left, bounds.left);
      clip.top = Math.max(clip.top, bounds.top);
      clip.right = Math.min(clip.right, bounds.right);
      clip.bottom = Math.min(clip.bottom, bounds.bottom);
    }

    const elements = Array.from(grid.querySelectorAll('.liquid-glass-card')).filter(element => {
      if (!cards.has(element)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.right > clip.left && bounds.left < clip.right && bounds.bottom > clip.top && bounds.top < clip.bottom;
    });
    return prepareCards(elements, reveal);
  }

  function prepareCards(elements: Element[], reveal: () => void) {
    const deadline = performance.now() + ENTRANCE_TIMEOUT_MS;
    const visible: { card: Card; width: number; height: number }[] = [];
    for (const element of elements) {
      const card = cards.get(element);
      if (card) visible.push({ card, width: card.element.offsetWidth, height: card.element.offsetHeight });
    }

    const loading = new Set<Promise<void>>();
    for (const { card, width, height } of visible) {
      if (performance.now() >= deadline) break;
      if (card.width !== width || card.height !== height) release(card);
      card.width = width;
      card.height = height;
      card.visible = true;
      clearTimeout(card.resizeTimer);
      card.resizeTimer = undefined;
      refresh(card);
      if (card.filters?.loading) loading.add(card.filters.loading);
    }

    let finished = false;
    let timer: number | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const { card } of visible) {
        if (cards.get(card.element) !== card || card.element.dataset.glassOptics === 'true') continue;
        // A card revealed with fallback keeps that material for this mount.
        card.useFallback = true;
        release(card);
      }
      reveal();
    };

    if (loading.size) {
      timer = window.setTimeout(finish, Math.max(0, deadline - performance.now()));
      void Promise.all(loading).then(finish);
    } else finish();

    return () => {
      finished = true;
      clearTimeout(timer);
    };
  }

  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const card = cards.get(entry.target);
      if (!card) continue;
      const size = entry.borderBoxSize?.[0];
      // Layout pixels keep the SVG aligned when the workspace or hover CSS scales the card.
      const width = Math.round(size?.inlineSize ?? card.element.offsetWidth);
      const height = Math.round(size?.blockSize ?? card.element.offsetHeight);
      if (width === card.width && height === card.height) continue;
      const needsSettle = card.width > 0 && card.height > 0;
      card.width = width;
      card.height = height;
      release(card);
      clearTimeout(card.resizeTimer);
      card.resizeTimer = undefined;
      if (!card.visible) continue;
      if (needsSettle) {
        card.resizeTimer = window.setTimeout(() => {
          card.resizeTimer = undefined;
          refresh(card);
        }, RESIZE_SETTLE_MS);
      } else refresh(card);
    }
  });

  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const card = cards.get(entry.target);
      if (!card) continue;
      card.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      if (card.visible) {
        refresh(card);
      } else {
        clearTimeout(card.resizeTimer);
        card.resizeTimer = undefined;
        release(card);
      }
    }
  });

  const onScroll = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.hasAttribute('data-glass-scroll-container')) return;
    document.documentElement.dataset.glassScrolling = 'true';
    clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      delete document.documentElement.dataset.glassScrolling;
    }, SCROLL_SETTLE_MS);
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return {
    prepareEntrance,
    prepareCards,
    updateBlur(scope: GlassScope, radius: number) {
      for (const pair of filters.values()) {
        if (pair.scope !== scope) continue;
        for (const node of pair.nodes) updateGlassBlur(node, radius);
      }
    },
    watch(element: HTMLElement, radius: number, scope: GlassScope, immediate: boolean) {
      const card: Card = { element, radius, scope, width: 0, height: 0, visible: false };
      cards.set(element, card);
      if (immediate) {
        card.width = element.offsetWidth;
        card.height = element.offsetHeight;
        card.visible = true;
        refresh(card);
      }
      resize.observe(element, { box: 'border-box' });
      intersection.observe(element);

      return () => {
        resize.unobserve(element);
        intersection.unobserve(element);
        clearTimeout(card.resizeTimer);
        release(card);
        cards.delete(element);
        if (!cards.size) {
          clearTimeout(scrollTimer);
          delete document.documentElement.dataset.glassScrolling;
        }
      };
    },
  };
}
