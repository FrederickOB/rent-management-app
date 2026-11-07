'use client';

import { useCallback, useState } from 'react';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { useLoad } from '@/lib/use-load';

/**
 * The signed-in staff member's own opt-in to emergency repair alerts on WhatsApp in this company
 * (M8 decision 5; CM-09): a consent record, as tenants have. SMS alerts go to staff phones anyway.
 */
export function WhatsappAlertsCard() {
  const load = useCallback(() => api().me.whatsappConsent(), []);
  const { state, reload } = useLoad(load);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function set(granted: boolean) {
    setPending(true);
    setProblem(null);
    setNotice(null);
    try {
      await api().me.setWhatsappConsent({ granted });
      setNotice(
        granted
          ? 'Emergency alerts will come to you on WhatsApp too.'
          : 'Emergency alerts will no longer come to you on WhatsApp. You still get them by SMS.',
      );
      reload();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="whatsapp-alerts">
      <CardHeader
        title="Emergency alerts on WhatsApp"
        description="When a repair becomes an emergency on a property you look after, you are alerted at once by SMS, and on WhatsApp if you agree here."
      />
      <CardBody>
        {state.status === 'loading' ? <Loading what="your choice" /> : null}
        {state.status === 'error' ? (
          <LoadFailed message={state.problem.message} onRetry={reload} />
        ) : null}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {state.status === 'ready' ? (
          <>
            <p className="text-sm" data-testid="whatsapp-alerts-state">
              {state.data.granted
                ? `You agreed: alerts come to you on WhatsApp${state.data.phoneMasked ? ` at ${state.data.phoneMasked}` : ''}.`
                : 'You have not agreed: alerts come to you by SMS only.'}
            </p>
            {!state.data.phoneMasked ? (
              <p className="text-sm text-slate-600">
                There is no phone number on your profile, so alerts cannot reach you by phone yet.
                Ask your administrator to add it.
              </p>
            ) : null}
            <Button
              variant={state.data.granted ? 'secondary' : 'primary'}
              pending={pending}
              onClick={() => void set(!state.data.granted)}
            >
              {state.data.granted ? 'Stop WhatsApp alerts' : 'Get alerts on WhatsApp too'}
            </Button>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
