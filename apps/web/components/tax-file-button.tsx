'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { scanNote, type ScanNote } from '@/lib/document-scan';
import { toProblem } from '@/lib/errors';
import { Button } from './ui/button';

/**
 * Opens a tax record's file (a GRA receipt, a withholding certificate, a refund's proof) through a
 * short-lived link the API issues after a policy check, as the money records' evidence does.
 */
export function TaxFileButton({
  documentId,
  label,
}: {
  readonly documentId: string;
  readonly label: string;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<ScanNote | null>(null);
  const [pending, setPending] = useState(false);

  async function open() {
    setProblem(null);
    setNote(null);
    setPending(true);
    try {
      await openFetchedLink(async () => (await api().rentTax.file({ documentId })).url);
    } catch (failure) {
      // M11 decision 6: still being scanned (try again), or quarantined (never opened).
      const scan = scanNote(failure);
      if (scan) setNote(scan);
      else setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" variant="secondary" pending={pending} onClick={() => void open()}>
        {label}
      </Button>
      {problem ? (
        <span role="alert" className="text-sm font-medium text-red-700">
          {problem}
        </span>
      ) : null}
      {note ? (
        <span
          role={note.state === 'quarantined' ? 'alert' : 'status'}
          className={
            note.state === 'quarantined'
              ? 'text-sm font-medium text-red-700'
              : 'text-sm text-slate-700'
          }
          data-testid="scan-note"
        >
          {note.text}
        </span>
      ) : null}
    </span>
  );
}
