const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_MAP_SIDE = 384;
export const GLASS_OPTICS = {
  bevelRatio: .16,
  minBevel: 18,
  maxBevel: 28,
  refraction: 38,
  dispersion: 4.2,
  bend: 96,
} as const;

export interface GlassShape {
  width: number;
  height: number;
  radius: number;
}

export interface GlassFilter {
  element: SVGFilterElement;
  map: SVGFEImageElement;
  blur: SVGFEGaussianBlurElement;
}

export function updateGlassBlur(filter: GlassFilter, radius: number) {
  filter.blur.setAttribute('stdDeviation', String(radius));
}

function smoothstep(value: number) {
  return value * value * (3 - 2 * value);
}

export function glassSvg<K extends keyof SVGElementTagNameMap>(
  tag: K, attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function createGlassMap({ width, height, radius }: GlassShape): string | undefined {
  const scale = Math.min(0.75, MAX_MAP_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  const columns = canvas.width = Math.max(1, Math.round(width * scale));
  const rows = canvas.height = Math.max(1, Math.round(height * scale));
  // The generated map is immediately read back as a PNG.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const pixels = ctx.createImageData(columns, rows);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corner = Math.min(radius, halfWidth, halfHeight);
  const shortSide = Math.min(width, height);
  const bevel = Math.min(shortSide / 2, GLASS_OPTICS.maxBevel, Math.max(GLASS_OPTICS.minBevel, shortSide * GLASS_OPTICS.bevelRatio));
  const innerLimit = Math.min(0, corner - bevel);

  for (let y = 0; y < rows; y++) {
    const offsetY = (y + 0.5) * height / rows - halfHeight;
    const curvedY = Math.abs(offsetY) - (halfHeight - corner);
    for (let x = 0; x < columns; x++) {
      const offsetX = (x + 0.5) * width / columns - halfWidth;
      const curvedX = Math.abs(offsetX) - (halfWidth - corner);
      const index = (y * columns + x) * 4;
      // R/G encode horizontal/vertical movement. B is the rim's blend mask.
      pixels.data[index] = 128;
      pixels.data[index + 1] = 128;
      pixels.data[index + 3] = 255;
      const nearestEdge = Math.max(curvedX, curvedY);
      if (nearestEdge <= innerLimit) continue;

      const outsideX = Math.max(0, curvedX);
      const outsideY = Math.max(0, curvedY);
      const diagonal = Math.hypot(outsideX, outsideY);
      const depth = corner - (diagonal + Math.min(nearestEdge, 0));
      if (depth >= bevel) continue;

      const normalX = diagonal > 0 ? outsideX / diagonal : Number(curvedX > curvedY);
      const normalY = diagonal > 0 ? outsideY / diagonal : Number(curvedY >= curvedX);
      const distanceToCenter = Math.min(1, 1 - depth / bevel);
      // Both the bend and its slope reach zero at the inner end of the bevel.
      const blend = smoothstep(distanceToCenter);
      const bend = GLASS_OPTICS.bend * blend;
      pixels.data[index] = 128 - Math.sign(offsetX) * normalX * bend;
      pixels.data[index + 1] = 128 - Math.sign(offsetY) * normalY * bend;
      pixels.data[index + 2] = 255 * blend;
    }
  }

  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL();
}

export function createGlassFilter(id: string, shape: GlassShape, mapUrl: string, rgb: boolean, blur: number): GlassFilter {
  const filter = glassSvg('filter', {
    id, x: '0%', y: '0%', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB',
  });
  const map = glassSvg('feImage', {
    href: mapUrl, x: 0, y: 0, width: shape.width, height: shape.height,
    preserveAspectRatio: 'none', result: 'map',
  });
  const frost = glassSvg('feGaussianBlur', { in: 'SourceGraphic', edgeMode: 'duplicate', result: 'frostedBackdrop' });
  filter.append(map, frost);
  const glassFilter = { element: filter, map, blur: frost };
  updateGlassBlur(glassFilter, blur);

  function displace(scale: number, result: string) {
    return glassSvg('feDisplacementMap', {
      in: 'frostedBackdrop', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', result,
    });
  }

  if (!rgb) {
    filter.append(displace(GLASS_OPTICS.refraction, 'rim'));
  } else {
    const channels = ['red', 'green', 'blue'];
    channels.forEach((channel, i) => {
      const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
      matrix[i * 6] = 1;
      filter.append(
        displace(GLASS_OPTICS.refraction + (i - 1) * GLASS_OPTICS.dispersion, channel + 'Shift'),
        glassSvg('feColorMatrix', { in: channel + 'Shift', type: 'matrix', values: matrix.join(' '), result: channel }),
      );
    });
    filter.append(
      glassSvg('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'redGreen' }),
      glassSvg('feBlend', { in: 'redGreen', in2: 'blue', mode: 'screen', result: 'rim' }),
    );
  }
  filter.append(
    glassSvg('feColorMatrix', {
      in: 'map', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0', result: 'rimMask',
    }),
    glassSvg('feComposite', { in: 'rim', in2: 'rimMask', operator: 'in', result: 'maskedRim' }),
    glassSvg('feComposite', { in: 'maskedRim', in2: 'frostedBackdrop', operator: 'over' }),
  );
  return glassFilter;
}
