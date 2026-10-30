// Line-art pictures for empty states. Drawn here, not copied from any library: 96 by 96, one stroke weight,
// stroke="currentColor" so the colour comes from text-muted-foreground. Decorative only, hidden from assistive tech.

const SHAPES = {
  inbox: (
    <>
      <path d="M12 56 L24 22 H72 L84 56" />
      <path d="M12 56 V74 H84 V56 H64 L58 66 H38 L32 56 Z" />
    </>
  ),
  calendar: (
    <>
      <rect x="16" y="20" width="64" height="60" rx="8" />
      <path d="M16 38 H80" />
      <path d="M34 12 V26" />
      <path d="M62 12 V26" />
      <path d="M32 54 H36" />
      <path d="M44 54 H48" />
      <path d="M56 54 H60" />
      <path d="M32 66 H36" />
    </>
  ),
  receipt: (
    <>
      <path d="M24 12 H72 V84 L64 78 L56 84 L48 78 L40 84 L32 78 L24 84 Z" />
      <path d="M34 32 H62" />
      <path d="M34 44 H62" />
      <path d="M34 56 H50" />
    </>
  ),
  people: (
    <>
      <circle cx="38" cy="36" r="12" />
      <path d="M16 80 C16 62 26 54 38 54 C50 54 60 62 60 80" />
      <circle cx="68" cy="42" r="9" />
      <path d="M60 60 C72 58 82 64 82 78" />
    </>
  ),
  chart: (
    <>
      <path d="M16 14 V80 H84" />
      <rect x="26" y="56" width="10" height="24" />
      <rect x="42" y="40" width="10" height="40" />
      <rect x="58" y="48" width="10" height="32" />
      <rect x="74" y="28" width="10" height="52" />
    </>
  )
};

export function EmptyArt({ name }) {
  const shape = SHAPES[name];
  if (!shape) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="96"
      height="96"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="block shrink-0 text-muted-foreground"
    >
      {shape}
    </svg>
  );
}
