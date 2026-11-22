import { DEFAULT_SETTINGS } from './types';

// Settings expresses how much tint covers the picture. Saved data still
// stores the picture's visibility so existing backgrounds look the same.
export function backgroundShade(imageOpacity: number) {
  const opacity = Number.isFinite(imageOpacity) ? imageOpacity : DEFAULT_SETTINGS.backgroundOpacity;
  return Number((1 - Math.min(1, Math.max(0, opacity))).toFixed(2));
}

export function normalizeCardFrost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.cardFrost;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function cardFrostRadius(percent: number): number {
  return normalizeCardFrost(percent) * 16 / 100;
}
