'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { LeasePaperField } from '@/components/lease-paper-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { leasePaperProblems, uploadLeasePaper } from '@/lib/lease-upload';
import { onboardingMessage } from '@/lib/onboarding';
import { useLoad } from '@/lib/use-load';

/**
 * An imported paper lease whose scan is still to follow (M11 decision 2): shown only while it is
 * missing, with the upload. A lease entered by hand always has its scan (M3 decision 7).
 */
export function ScanToFollow({ leaseId }: { readonly leaseId: string }) {
  const load = useCallback(
    async () =>
      (await api().onboarding.leasesMissingScan()).some((lease) => lease.leaseId === leaseId),
    [leaseId],
  );
  const { state, reload } = useLoad(load);
  const input = useRef<HTMLInputElement>(null);
  const [noIdCopy, setNoIdCopy] = useState(false);
  const [errors, setErrors] = useState<{ file: string | null; tick: string | null }>({
    file: null,
    tick: null,
  });
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    const file = input.current?.files?.[0];
    const next = leasePaperProblems(file, { noIdCopy, missing: 'Choose the scan.' });
    setErrors(next);
    if (!file || next.file || next.tick) return;
    setPending(true);
    try {
      const scanUploadId = await uploadLeasePaper(file, leaseId);
      await api().onboarding.attachScan({ leaseId, scanUploadId });
      setDone(true);
      reload();
    } catch (failure) {
      setProblem(onboardingMessage(failure) ?? toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  if (done) return <Alert tone="success">The signed scan is attached to the lease.</Alert>;
  if (state.status !== 'ready' || !state.data) return null;
  return (
    <Card data-testid="scan-to-follow">
      <CardHeader
        title="Scan to follow"
        description="This lease came in from the onboarding workbook without its signed paper. Upload the scan when you have it."
      />
      <CardBody>
        <form
          aria-label="Attach the signed scan"
          className="space-y-3"
          onSubmit={(event) => void submit(event)}
        >
          <LeasePaperField
            ref={input}
            label="The signed lease, scanned"
            disabled={pending}
            error={errors.file}
            noIdCopy={noIdCopy}
            onNoIdCopy={setNoIdCopy}
            tickError={errors.tick}
            required
          />
          <Button type="submit" pending={pending}>
            Attach the scan
          </Button>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
        </form>
      </CardBody>
    </Card>
  );
}
