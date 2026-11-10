'use client';

import { useEffect, useRef, useState } from 'react';
import { startDownload } from '@/lib/browser-files';
import { errorCode, toProblem } from '@/lib/errors';
import { Button } from './ui/button';

const POLL_MS = 2_000;
const POLL_TRIES = 15;

/** The document did not finish rendering within the polls. */
class StillRendering extends Error {}

/**
 * Downloads a document through its short-lived link (M10: a subscription invoice or receipt). The
 * link is served as an attachment, so it downloads from the page and no empty tab is left. While
 * the PDF renders (409 `DOCUMENT_RENDERING`), it asks again a few times.
 */
export function DocumentDownload({
  label,
  name,
  load,
  testId,
}: {
  readonly label: string;
  /** The button's full name for assistive technology, such as "Download invoice SUB-2026-000001". */
  readonly name?: string;
  readonly load: () => Promise<{ readonly url: string }>;
  readonly testId?: string;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    setPending(true);
    setProblem(null);
    try {
      let url: string | null = null;
      for (let tries = 0; url === null && tries < POLL_TRIES; tries += 1) {
        try {
          url = (await load()).url;
        } catch (failure) {
          if (errorCode(failure) !== 'DOCUMENT_RENDERING') throw failure;
          await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
          if (!mounted.current) return;
        }
      }
      if (!url) throw new StillRendering();
      startDownload(url);
    } catch (failure) {
      if (!mounted.current) return;
      setProblem(
        failure instanceof StillRendering
          ? 'The PDF is still being made. Try again in a minute.'
          : failure instanceof Error && failure.message === 'unexpected link'
            ? 'The PDF link could not be opened. Try again.'
            : toProblem(failure).message,
      );
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        pending={pending}
        onClick={() => void run()}
        aria-label={name}
        data-testid={testId}
      >
        {label}
      </Button>
      {problem ? (
        <span role="alert" className="text-sm font-medium text-red-700">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
