import type { Light, Review } from './api';

/** The three lights, with the words the pull request uses for them. */
export const LIGHTS: Record<Light, { label: string; dot: string; text: string; soft: string }> = {
  green: { label: 'Safe to merge', dot: 'bg-safe', text: 'text-safe', soft: 'bg-safe/10' },
  yellow: { label: 'Needs a human', dot: 'bg-human', text: 'text-human', soft: 'bg-human/10' },
  red: { label: 'Blocked', dot: 'bg-blocked', text: 'text-blocked', soft: 'bg-blocked/10' },
};

/** "3 minutes ago", from the reader's own clock. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const steps: [number, string][] = [[60, 'minute'], [60, 'hour'], [24, 'day'], [30, 'month'], [12, 'year']];
  let value = seconds;
  let unit = 'second';
  for (const [size, name] of steps) {
    if (value < size) break;
    value = Math.floor(value / size);
    unit = name;
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

export function took(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** "2 bugs, 1 risk", or what it means when there are none. */
export function findings(r: Review): string {
  const parts = [
    r.bugs && `${r.bugs} bug${r.bugs === 1 ? '' : 's'}`,
    r.risks && `${r.risks} risk${r.risks === 1 ? '' : 's'}`,
    r.hardening && `${r.hardening} hardening`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing worth fixing';
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
