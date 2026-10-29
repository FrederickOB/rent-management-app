import type { CSSProperties, ReactNode } from 'react';
import type { Branding } from './branding';

type BrandStyle = CSSProperties & Record<`--brand-${string}`, string>;

/**
 * The base layout every company document uses (AD-01): logo, sender name and the company's
 * colours, which templates reach through `var(--brand-primary)` and `var(--brand-accent)`.
 */
export function Letterhead({ branding, children }: { branding: Branding; children: ReactNode }) {
  const style: BrandStyle = {
    '--brand-primary': branding.primaryColour,
    '--brand-accent': branding.accentColour,
  };
  return (
    <div className="document" style={style}>
      <header className="letterhead">
        {branding.logoDataUri ? (
          <img className="logo" src={branding.logoDataUri} alt={`${branding.senderName} logo`} />
        ) : null}
        <div className="sender">{branding.senderName}</div>
      </header>
      <div className="accent-rule" />
      <main>{children}</main>
    </div>
  );
}
