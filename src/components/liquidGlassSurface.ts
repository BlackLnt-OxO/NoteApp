import { createGlassFilter, createGlassMap, glassSvg, type GlassShape } from './liquidGlassFilters';

const RESIZE_SETTLE_MS = 80;
const SCROLL_SETTLE_MS = 150;
const UNUSED_FILTER_LIMIT = 8;

interface Card {
  element: HTMLElement;
  radius: number;
  visible: boolean;
  width: number;
  height: number;
  resizeTimer?: number;
  filters?: FilterPair;
}

interface FilterPair {
  key: string;
  rgb: string;
  mono: string;
  nodes: SVGFilterElement[];
  cards: Set<Card>;
}

let controller: ReturnType<typeof createController> | undefined;

export function watchGlassCard(element: HTMLElement, radius: number) {
  if (!window.ResizeObserver || !window.IntersectionObserver
    || !window.CSS?.supports('backdrop-filter', 'url("#noteapp-glass")')
    || !/\bChrom(?:e|ium)\//.test(navigator.userAgent)) return;

  controller ??= createController();
  return controller.watch(element, radius);
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
    for (const node of pair.nodes) node.remove();
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

  function makeFilters(key: string, shape: GlassShape): FilterPair | undefined {
    let mapUrl: string | undefined;
    try { mapUrl = createGlassMap(shape); } catch { return; }
    if (!mapUrl || mapUrl === 'data:,') return;

    const id = `noteapp-glass-${++nextId}`;
    const pair: FilterPair = { key, rgb: id + '-rgb', mono: id + '-mono', nodes: [], cards: new Set() };
    filters.set(key, pair);

    const map = new Image();
    map.src = mapUrl;
    void map.decode().then(() => {
      if (filters.get(key) !== pair) return;
      if (!definitions?.isConnected) {
        const svg = glassSvg('svg', { 'aria-hidden': 'true', width: 0, height: 0 });
        svg.style.position = 'absolute';
        svg.style.pointerEvents = 'none';
        definitions = glassSvg('defs');
        svg.append(definitions);
        document.body.append(svg);
      }
      pair.nodes = [createGlassFilter(pair.rgb, shape, mapUrl, true), createGlassFilter(pair.mono, shape, mapUrl, false)];
      definitions.append(...pair.nodes);
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
    if (!card.visible || card.resizeTimer !== undefined || !card.width || !card.height || card.filters) return;
    const { width, height, radius } = card;
    const key = `${width}:${height}:${radius}`;
    const pair = filters.get(key) ?? makeFilters(key, { width, height, radius });
    if (!pair) return;

    pair.cards.add(card);
    card.filters = pair;
    if (pair.nodes.length) activate(card, pair);
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
    watch(element: HTMLElement, radius: number) {
      const card: Card = { element, radius, width: 0, height: 0, visible: false };
      cards.set(element, card);
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
