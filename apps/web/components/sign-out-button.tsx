'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { Button, type ButtonProps } from './ui/button';

/** Ends this session on the server, then leaves with a full page load so nothing stale remains. */
export function SignOutButton({
  variant = 'secondary',
  size = 'sm',
  className,
}: Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient().signOut();
    } finally {
      window.location.assign('/sign-in');
    }
  }

  return (
    <Button variant={variant} size={size} pending={pending} onClick={signOut} className={className}>
      Sign out
    </Button>
  );
}
