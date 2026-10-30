// Shared motion presets. Animate transform and opacity only (layout animation through the `layout` prop is fine).
// CSS easing stays var(--ease-out); these are the Motion equivalents.
export const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } };
export const rise = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } } };
export const spring = { type: 'spring', stiffness: 420, damping: 34 };
export const press = { scale: 0.97 };
