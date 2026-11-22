import { useLayoutEffect, useRef } from 'react';
import { prepareGlassEntrance } from './liquidGlassSurface';

export function useGlassEntrance(hasCards: boolean) {
  const grid = useRef<HTMLDivElement>(null);
  const entered = useRef(false);

  useLayoutEffect(() => {
    const element = grid.current;
    if (!hasCards || !element || entered.current) return;

    element.dataset.glassEntrance = 'pending';
    const cancel = prepareGlassEntrance(element, () => {
      entered.current = true;
      element.dataset.glassEntrance = 'entered';
    });
    return () => {
      cancel?.();
      if (!entered.current) delete element.dataset.glassEntrance;
    };
  }, [hasCards]);

  return grid;
}
