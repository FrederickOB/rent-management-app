'use client';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** Unexpected failures, most often the API being unreachable. Details stay out of the page. */
export default function ErrorPage({
  retry,
}: {
  readonly error: unknown;
  readonly retry: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-md space-y-4 px-4 py-12">
      <Alert tone="error" title="We could not load this page">
        The server did not answer as expected. Check your connection, then try again.
      </Alert>
      <Button onClick={() => retry()}>Try again</Button>
    </main>
  );
}
