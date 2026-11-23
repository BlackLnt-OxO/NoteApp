import { createGlassFilter, createGlassMap, glassSvg, updateGlassBlur, type GlassFilter, type GlassShape } from './liquidGlassFilters';
import { finishNoteMeasure, startNoteMeasure } from './noteMotionMetrics';

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
  note: boolean;
  useFallback?: boolean;
  width: number;
  height: number;
  resizeTimer?: number;
  filters?: FilterPair;
  displayed?: FilterPair;
  resizeFilter?: GlassFilter;
}

interface FilterPair {
  key: string;
  rgb: string;
  mono: string;
  scope: GlassScope;
  shape: GlassShape;
  mapUrl: string;
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
  const deferredNotes = new Set<Card>();
  let workScheduled = false;

  function noteIsMoving(card: Card) {
    const grid = card.element.closest('[data-note-grid]');
    return !!grid && (grid.hasAttribute('data-grid-settling') || grid.getAnimations().some(a => a.playState === 'running')
      || !!grid.closest('[data-ink-workspace]')?.querySelector('.workspace-sidebar-track')?.getAnimations().length
      || card.element.parentElement?.hasAttribute('data-note-edit-moving'));
  }

  function deferNote(card: Card) {
    deferredNotes.add(card);
    if (workScheduled) return;
    workScheduled = true;
    const run = () => {
      workScheduled = false;
      const ready = Array.from(deferredNotes).find(candidate => !noteIsMoving(candidate));
      if (ready) {
        deferredNotes.delete(ready);
        if (ready.filters && !ready.filters.loading) activate(ready, ready.filters);
        else refresh(ready, true);
      }
      const next = deferredNotes.values().next().value;
      if (next) deferNote(next);
    };
    // Begin after the current paint. Allow only one new map in each idle slot.
    window.setTimeout(() => {
      if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 90 });
      else run();
    }, 32);
  }

  function activate(card: Card, pair: FilterPair) {
    if (card.filters !== pair) return;
    if (card.note && card.displayed && card.displayed !== pair && noteIsMoving(card)) {
      deferNote(card);
      return;
    }
    if (card.displayed !== pair) unlink(card, card.displayed);
    card.displayed = pair;
    card.element.style.setProperty('--glass-rgb-filter', `url("#${pair.rgb}")`);
    card.element.style.setProperty('--glass-mono-filter', `url("#${pair.mono}")`);
    card.element.dataset.glassOptics = 'true';
    removeResizeFilter(card);
  }

  function removeResizeFilter(card: Card) {
    card.resizeFilter?.element.remove();
    card.resizeFilter = undefined;
  }

  function stretchDisplayedFilter(card: Card) {
    if (!card.displayed || !definitions) return;
    if (!card.resizeFilter) {
      // Keep the decoded map on a private filter so the shared cached filter stays immutable.
      const id = `noteapp-glass-resize-${++nextId}-rgb`;
      card.resizeFilter = createGlassFilter(id, card, card.displayed.mapUrl, true, blurByScope[card.scope]);
      definitions.append(card.resizeFilter.element);
      card.element.style.setProperty('--glass-rgb-filter', `url("#${id}")`);
    } else {
      card.resizeFilter.map.setAttribute('width', String(card.width));
      card.resizeFilter.map.setAttribute('height', String(card.height));
    }
  }

  function discard(pair: FilterPair) {
    filters.delete(pair.key);
    for (const node of pair.nodes) node.element.remove();
  }

  function unlink(card: Card, pair?: FilterPair) {
    if (!pair) return;
    pair.cards.delete(card);

    if (!pair.cards.size) {
      // Keep recent sizes warm when scrolling, changing workspaces or resizing.
      filters.delete(pair.key);
      filters.set(pair.key, pair);
      const unused = Array.from(filters.values()).filter(candidate => !candidate.cards.size);
      for (const expired of unused.slice(0, Math.max(0, unused.length - UNUSED_FILTER_LIMIT))) discard(expired);
    }
  }

  function release(card: Card, keepDisplayed = false) {
    deferredNotes.delete(card);
    if (card.filters !== card.displayed) unlink(card, card.filters);
    card.filters = undefined;
    if (keepDisplayed || !card.displayed) return;

    unlink(card, card.displayed);
    card.displayed = undefined;
    delete card.element.dataset.glassOptics;
    card.element.style.removeProperty('--glass-rgb-filter');
    card.element.style.removeProperty('--glass-mono-filter');
    removeResizeFilter(card);
  }

  function makeFilters(key: string, shape: GlassShape, scope: GlassScope, note = false): FilterPair | undefined {
    const measure = note ? startNoteMeasure() : undefined;
    let mapUrl: string | undefined;
    try { mapUrl = createGlassMap(shape); } catch { return; }
    finally { finishNoteMeasure('note-filter-map', measure); }
    if (!mapUrl || mapUrl === 'data:,') return;

    const id = `noteapp-glass-${++nextId}`;
    const pair: FilterPair = { key, rgb: id + '-rgb', mono: id + '-mono', scope, shape, mapUrl, nodes: [], cards: new Set() };
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
    const decodeMeasure = note ? startNoteMeasure() : undefined;
    pair.loading = map.decode().then(() => {
      finishNoteMeasure('note-filter-decode', decodeMeasure);
      if (filters.get(key) !== pair) return;
      pair.loading = undefined;
      for (const card of pair.cards) activate(card, pair);
    }).catch(() => {
      if (filters.get(key) !== pair) return;
      for (const card of pair.cards) {
        if (card.filters === pair) card.filters = undefined;
        if (card.displayed === pair) release(card);
      }
      pair.cards.clear();
      discard(pair);
    });

    return pair;
  }

  function displayCachedMap(card: Card) {
    if (card.displayed) return;
    let closest: FilterPair | undefined;
    let distance = .28;
    for (const pair of filters.values()) {
      if (pair.scope !== card.scope || pair.shape.radius !== card.radius || pair.loading) continue;
      const gap = Math.abs(Math.log(pair.shape.width / card.width)) + Math.abs(Math.log(pair.shape.height / card.height));
      if (gap < distance) { closest = pair; distance = gap; }
    }
    const seedKey = `${card.scope}:note-seed:${card.radius}`;
    const starter = closest ?? filters.get(seedKey)
      ?? makeFilters(seedKey, { width: 160, height: 120, radius: card.radius }, card.scope, true);
    if (!starter) return;
    card.displayed = starter;
    starter.cards.add(card);
    card.element.style.setProperty('--glass-mono-filter', `url("#${starter.mono}")`);
    card.element.dataset.glassOptics = 'true';
    stretchDisplayedFilter(card);
  }

  function refresh(card: Card, allowNoteMap = false) {
    if (!card.visible || card.useFallback || card.resizeTimer !== undefined || !card.width || !card.height || card.filters) return;
    const { width, height, radius, scope } = card;
    const key = `${scope}:${width}:${height}:${radius}`;
    const cached = filters.get(key);
    if (card.note && !cached && !allowNoteMap) {
      displayCachedMap(card);
      deferNote(card);
      return;
    }
    const pair = cached ?? makeFilters(key, { width, height, radius }, scope, card.note);
    if (!pair) return;

    pair.cards.add(card);
    card.filters = pair;
    if (!pair.loading) activate(card, pair);
    else if (card.note) displayCachedMap(card);
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
      const resized = card.width !== width || card.height !== height;
      card.width = width;
      card.height = height;
      if (resized) {
        release(card, true);
        stretchDisplayedFilter(card);
      }
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
      // Keep the current map sampling the live backdrop until the new one decodes.
      release(card, true);
      stretchDisplayedFilter(card);
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
    if (document.documentElement.dataset.glassScrolling !== 'true') document.documentElement.dataset.glassScrolling = 'true';
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
      for (const card of cards.values()) {
        if (card.scope === scope && card.resizeFilter) updateGlassBlur(card.resizeFilter, radius);
      }
    },
    watch(element: HTMLElement, radius: number, scope: GlassScope, immediate: boolean) {
      const card: Card = { element, radius, scope, width: 0, height: 0, visible: false,
        note: !immediate && !!element.closest('[data-note-grid]') };
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
