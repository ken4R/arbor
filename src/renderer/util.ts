export function relativeDate(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds;
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let value = -diff;
  for (const [size, unit] of units) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return '';
}

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

export function fullDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export const LANE_COLORS = ['#3fb6a8', '#e0a63a', '#8f7ff0', '#e0607e', '#5aa6e8', '#9bc25b', '#d9793f', '#c46fd0'];
export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function hashColor(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 45% 42%)`;
}

export function splitPath(path: string): { dir: string; file: string } {
  const i = path.lastIndexOf('/');
  return i === -1 ? { dir: '', file: path } : { dir: path.slice(0, i + 1), file: path.slice(i + 1) };
}
