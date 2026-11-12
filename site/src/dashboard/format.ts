import type { Light, Review } from './api';

/**
 * The three lights, with the words the pull request uses for them. dot: a plain dot. text: the
 * light's own text colour. pill: a tinted pill with a hairline edge, as the reference's "Production".
 * bar: a bar in a history strip.
 */
export const LIGHTS: Record<Light, { label: string; short: string; dot: string; text: string; pill: string; bar: string }> = {
  green: { label: 'Safe to merge', short: 'Safe', dot: 'bg-safe', text: 'text-safe-ink', pill: 'bg-safe/[0.12] text-safe-ink shadow-[inset_0_0_0_1px_rgb(112_160_124/0.32)]', bar: 'bg-safe' },
  yellow: { label: 'Needs a human', short: 'Needs a human', dot: 'bg-human', text: 'text-human-ink', pill: 'bg-human/[0.12] text-human-ink shadow-[inset_0_0_0_1px_rgb(212_162_83/0.32)]', bar: 'bg-human' },
  red: { label: 'Blocked', short: 'Blocked', dot: 'bg-blocked', text: 'text-blocked-ink', pill: 'bg-blocked/[0.12] text-blocked-ink shadow-[inset_0_0_0_1px_rgb(211_134_125/0.32)]', bar: 'bg-blocked' },
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

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
