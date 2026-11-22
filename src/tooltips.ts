const TARGET = '[data-tooltip], button[aria-label], [role="button"][aria-label]';
const DELAY = 400;
const GAP = 8;

function tooltipTarget(value: EventTarget | null): Element | null {
  const target = value instanceof Element ? value.closest(TARGET) : null;
  return target && !target.closest('[inert], [aria-hidden="true"]') ? target : null;
}

/** One floating layer for the renderer, including controls inside clipped editors. */
export function installTooltips() {
  const tooltip = document.createElement('div');
  tooltip.id = 'noteapp-tooltip';
  tooltip.className = 'app-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  let anchor: Element | null = null;
  let described: Element | null = null;
  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    if (!anchor?.isConnected || tooltipTarget(anchor) !== anchor) hide();
    else if (!tooltip.hidden) show();
  });

  function hide() {
    window.clearTimeout(timer);
    observer.disconnect();
    if (described) {
      const remaining = described.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== tooltip.id).join(' ');
      if (remaining) described.setAttribute('aria-describedby', remaining);
      else described.removeAttribute('aria-describedby');
      described = null;
    }
    tooltip.hidden = true;
    anchor = null;
  }

  function show() {
    const text = (anchor?.getAttribute('data-tooltip') ?? anchor?.getAttribute('aria-label'))?.trim();
    const rect = anchor?.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    if (!anchor?.isConnected || !text || !rect?.width || !rect.height || rect.bottom <= 0 || rect.top >= height
      || rect.right <= 0 || rect.left >= width) {
      hide();
      return;
    }
    if (tooltip.textContent !== text) tooltip.textContent = text;
    tooltip.hidden = false;
    const size = tooltip.getBoundingClientRect();
    const left = Math.max(GAP, Math.min((rect.left + rect.right - size.width) / 2, width - size.width - GAP));
    const y = rect.top >= size.height + GAP * 2 ? rect.top - size.height - GAP : rect.bottom + GAP;
    const top = Math.max(GAP, Math.min(y, height - size.height - GAP));
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    if (described !== anchor) {
      const existing = anchor.getAttribute('aria-describedby');
      anchor.setAttribute('aria-describedby', existing ? existing + ' ' + tooltip.id : tooltip.id);
      described = anchor;
    }
  }

  function schedule(target: Element | null) {
    if (target === anchor) return;
    hide();
    if (!target) return;
    anchor = target;
    timer = window.setTimeout(show, DELAY);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-tooltip', 'aria-label', 'aria-hidden', 'inert'],
    });
  }

  const pointerOver = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.buttons === 0) schedule(tooltipTarget(event.target));
  };
  const pointerOut = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && anchor && tooltipTarget(event.relatedTarget) !== anchor) hide();
  };
  const focusIn = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches(':focus-visible')) schedule(tooltipTarget(event.target));
  };
  const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };

  document.addEventListener('pointerover', pointerOver, true);
  document.addEventListener('pointerout', pointerOut, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('focusin', focusIn, true);
  document.addEventListener('focusout', hide, true);
  document.addEventListener('keydown', keyDown, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);

  return () => {
    hide();
    tooltip.remove();
    document.removeEventListener('pointerover', pointerOver, true);
    document.removeEventListener('pointerout', pointerOut, true);
    document.removeEventListener('pointerdown', hide, true);
    document.removeEventListener('focusin', focusIn, true);
    document.removeEventListener('focusout', hide, true);
    document.removeEventListener('keydown', keyDown, true);
    document.removeEventListener('scroll', hide, true);
    window.removeEventListener('blur', hide);
    window.removeEventListener('resize', hide);
  };
}
