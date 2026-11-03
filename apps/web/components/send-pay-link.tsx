'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { payLinkOutcome } from '@/lib/collection';
import { toProblem } from '@/lib/errors';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

/**
 * Sends the tenant a pay link for one invoice (BC-04; M4b plan 4.3), by SMS and email where
 * consent is recorded (CM-09). The API decides where it can go and says why when it cannot: no
 * consent, or no usable settlement account for the lease's owner (ADR-008). The link itself is
 * never shown here; only the tenant receives it.
 */
export function SendPayLink({
  invoiceId,
  label = 'Send a pay link',
  detail,
}: {
  readonly invoiceId: string;
  readonly label?: string;
  /** Which invoice it is for, read with the button. */
  readonly detail?: string;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: boolean; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function send() {
    setPending(true);
    setProblem(null);
    setOutcome(null);
    try {
      setOutcome(payLinkOutcome(await api().paymentsQueue.sendPayLink({ invoiceId })));
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="send-pay-link">
      <Button variant="secondary" pending={pending} onClick={() => void send()}>
        {outcome?.sent ? 'Send it again' : label}
        {detail ? <span className="sr-only"> {detail}</span> : null}
      </Button>
      {outcome ? (
        <Alert tone={outcome.sent ? 'success' : 'warning'}>
          <span data-testid="pay-link-outcome">{outcome.text}</span>
        </Alert>
      ) : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
    </div>
  );
}
