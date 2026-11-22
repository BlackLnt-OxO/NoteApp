const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_MAP_SIDE = 384;
const EDGE_WIDTH = 18;
const REFRACTION = 28;
const DISPERSION = 2.3;

export interface GlassShape {
  width: number;
  height: number;
  radius: number;
}

export interface GlassFilter {
  element: SVGFilterElement;
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
  const bevel = Math.min(EDGE_WIDTH, halfWidth, halfHeight);
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
      if (depth < 0 || depth >= bevel) continue;

      const normalX = diagonal > 0 ? outsideX / diagonal : Number(curvedX > curvedY);
      const normalY = diagonal > 0 ? outsideY / diagonal : Number(curvedY >= curvedX);
      const distanceToCenter = 1 - depth / bevel;
      // Both the bend and its slope reach zero at the inner end of the bevel.
      const bend = 116 * smoothstep(distanceToCenter);
      const blend = smoothstep(Math.min(1, distanceToCenter * 3));
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
  filter.append(glassSvg('feImage', {
    href: mapUrl, x: 0, y: 0, width: shape.width, height: shape.height,
    preserveAspectRatio: 'none', result: 'map',
  }));
  const frost = glassSvg('feGaussianBlur', { in: 'SourceGraphic', edgeMode: 'duplicate', result: 'frostedBackdrop' });
  filter.append(frost);
  const glassFilter = { element: filter, blur: frost };
  updateGlassBlur(glassFilter, blur);

  function displace(scale: number, result: string) {
    return glassSvg('feDisplacementMap', {
      in: 'frostedBackdrop', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', result,
    });
  }

  if (!rgb) {
    filter.append(displace(REFRACTION, 'rim'));
    return glassFilter;
  }

  const channels = ['red', 'green', 'blue'];
  channels.forEach((channel, i) => {
    const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    matrix[i * 6] = 1;
    filter.append(
      displace(REFRACTION + (i - 1) * DISPERSION, channel + 'Shift'),
      glassSvg('feColorMatrix', { in: channel + 'Shift', type: 'matrix', values: matrix.join(' '), result: channel }),
    );
  });
  filter.append(
    glassSvg('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'redGreen' }),
    glassSvg('feBlend', { in: 'redGreen', in2: 'blue', mode: 'screen', result: 'rim' }),
    glassSvg('feColorMatrix', {
      in: 'map', type: 'matrix', values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0', result: 'rimMask',
    }),
    glassSvg('feComposite', { in: 'rim', in2: 'rimMask', operator: 'in', result: 'maskedRim' }),
    glassSvg('feComposite', { in: 'maskedRim', in2: 'frostedBackdrop', operator: 'over' }),
  );
  return glassFilter;
}
