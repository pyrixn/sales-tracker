// Brand logos for payment methods: bKash, Nagad, Upay (supplied images), Bank (SVG).

// Decorative: every use sits next to the method name, so alt is empty.
// Supplied brand images from web/public/logos. Sized like the SVG icons (size-*) and kept inside that box with object-contain.
function BrandImage({ src, alt, className = 'size-5' }) {
  return <img src={src} alt={alt} className={`${className} object-contain`} draggable={false} />;
}

export function BkashLogo({ className = 'size-5' }) {
  return <BrandImage src="/logos/bkash.png" alt="" className={className} />;
}

export function NagadLogo({ className = 'size-5' }) {
  return <BrandImage src="/logos/nagad.png" alt="" className={className} />;
}

export function UpayLogo({ className = 'size-5' }) {
  return <BrandImage src="/logos/upay.png" alt="" className={className} />;
}

export function BankLogo({ className = 'size-5' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 21h18" />
      <path d="M3 10h18" />
      <path d="M5 6l7-3 7 3" />
      <path d="M4 10v11" />
      <path d="M20 10v11" />
      <path d="M8 14v4" />
      <path d="M12 14v4" />
      <path d="M16 14v4" />
    </svg>
  );
}

export function PayMethodIcon({ method, className = 'size-5' }) {
  switch (method) {
    case 'bkash':
      return <BkashLogo className={className} />;
    case 'nagad':
      return <NagadLogo className={className} />;
    case 'upay':
      return <UpayLogo className={className} />;
    case 'bank':
      return <BankLogo className={className} />;
    default:
      return null;
  }
}
