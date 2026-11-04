'use client';

import Link from 'next/link';
import { textLink } from './link-styles';
import { Button } from './ui/button';

/**
 * A form's Cancel: a link away, disabled while the form's write is on its way, so nobody leaves
 * before knowing whether the money was recorded.
 */
export function CancelLink({
  href,
  disabled,
  children = 'Cancel',
}: {
  readonly href: string;
  readonly disabled: boolean;
  readonly children?: string;
}) {
  if (disabled)
    return (
      <Button variant="ghost" disabled>
        {children}
      </Button>
    );
  return (
    <Link href={href} className={textLink}>
      {children}
    </Link>
  );
}
