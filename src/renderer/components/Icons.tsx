const s = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Icon = {
  pull: () => (
    <svg {...s}><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5M3 14h10" /></svg>
  ),
  push: () => (
    <svg {...s}><path d="M8 11V2M4.5 5.5 8 2l3.5 3.5M3 14h10" /></svg>
  ),
  fetch: () => (
    <svg {...s}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>
  ),
  branch: () => (
    <svg {...s}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></svg>
  ),
  stash: () => (
    <svg {...s}><path d="M2.5 6h11v7.5h-11zM4 3.5h8M5.5 9h5" /></svg>
  ),
  pop: () => (
    <svg {...s}><path d="M2.5 9v4.5h11V9M8 10V2.5M5 5.5 8 2.5l3 3" /></svg>
  ),
  refresh: () => (
    <svg {...s}><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13.5 5.5M13.5 2.5v3h-3M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2.5 10.5M2.5 13.5v-3h3" /></svg>
  ),
  folder: () => (
    <svg {...s}><path d="M2 4.5h4l1.5 1.5H14v7H2z" /></svg>
  ),
  close: () => (
    <svg {...s}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  ),
  chevron: () => (
    <svg {...s} width={12} height={12}><path d="M6 4l4 4-4 4" /></svg>
  ),
  tag: () => (
    <svg {...s} width={12} height={12}><path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5zM5 5.5h.01" /></svg>
  ),
  cloud: () => (
    <svg {...s} width={12} height={12}><path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7 1A2.5 2.5 0 0 1 11.5 12.5z" /></svg>
  ),
  computer: () => (
    <svg {...s} width={12} height={12}><path d="M2 3h12v8H2zM6 14h4M8 11v3" /></svg>
  ),
};

/** Logo d'Arbor : un tronc qui se divise en trois branches. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#1f3b38" />
      <path d="M16 27V15M16 18c0-4-6-4-6-8M16 15c0-3 6-3 6-7" stroke="#3fb6a8" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="10" cy="8.5" r="2.6" fill="#e0a63a" />
      <circle cx="22" cy="6.5" r="2.6" fill="#8f7ff0" />
      <circle cx="16" cy="13" r="2.6" fill="#3fb6a8" />
    </svg>
  );
}
