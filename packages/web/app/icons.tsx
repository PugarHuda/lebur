// SVG icons, because emoji are not icons: they render differently on every
// platform, ignore `currentColor`, and are announced by screen readers as their
// unicode name. These are Lucide paths, inlined — a whole icon dependency for
// five glyphs is not worth the bytes.
type P = { size?: number };
const base = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, 'aria-hidden': true,
});

export const Lock = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const Alert = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

export const Check = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M20 6 9 17l-5-5" /></svg>
);

export const Ext = ({ size = 13 }: P) => (
  <svg {...base(size)}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

/// A spinner has to keep moving to mean "still working", so it is the one thing
/// here that animates — and it stops entirely under prefers-reduced-motion,
/// where the surrounding status text carries the meaning instead.
export const Spinner = ({ size = 14 }: P) => (
  <svg {...base(size)} style={{ animation: 'spin 900ms linear infinite' }}>
    <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
  </svg>
);
