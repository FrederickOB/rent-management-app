'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { EVIDENCE_LABELS, type EvidenceKind } from '@/lib/billing-format';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { Button } from './ui/button';

/**
 * Opens a money record's photo, proof or slip (BC-05, P07, P28) through a short-lived link the API
 * issues after a policy check (`GET /payment-files/{documentId}/download`). Nothing is kept here.
 */
export function EvidenceButton({
  documentId,
  kind,
  size = 'sm',
}: {
  readonly documentId: string;
  readonly kind: EvidenceKind;
  readonly size?: 'sm' | 'md';
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function open() {
    setProblem(null);
    setPending(true);
    try {
      await openFetchedLink(async () => (await api().payments.paymentFile({ documentId })).url);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size={size} variant="secondary" pending={pending} onClick={() => void open()}>
        {EVIDENCE_LABELS[kind]}
      </Button>
      {problem ? (
        <span role="alert" className="text-sm font-medium text-red-700">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
