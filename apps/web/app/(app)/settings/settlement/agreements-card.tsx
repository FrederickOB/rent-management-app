'use client';

import type { SettlementAccountView } from '@rent/contracts';
import type { RentDestination } from '@rent/domain/payments';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Empty } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBusinessDate, todayIn } from '@/lib/business-dates';
import { toProblem } from '@/lib/errors';
import {
  agreementChanges,
  DESTINATION_LABELS,
  DESTINATION_OPTIONS,
  destinationProblem,
  destinationProblemText,
  type AgreementRow,
} from '@/lib/settlement';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where each owner's rent goes, in an agency (M4b decision 6): the owner's own account or the
 * agency's client account, from a date. There is no default, so pay links for an owner's leases
 * wait until the agency chooses. Every change, the first included, is a request a second person
 * approves (M4b review); the owner is told when it is asked and when it is approved, and it takes
 * effect on the day asked or the first day 24 hours after approval, whichever is later. Fee terms
 * come later (AC-02).
 */
export function AgreementsCard({
  agreements,
  accounts,
  canChange,
  seeApprovals,
  onChanged,
}: {
  readonly agreements: readonly AgreementRow[];
  readonly accounts: readonly SettlementAccountView[];
  readonly canChange: boolean;
  readonly seeApprovals: boolean;
  readonly onChanged: (text: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card data-testid="management-agreements">
      <CardHeader
        title="Where each owner’s rent goes"
        description="Choose, for each owner, whether rent settles into their own account or the agency’s client account. Pay links for an owner’s leases cannot be sent until this is chosen. Every change needs a second person’s approval, and the owner is told."
      />
      <CardBody>
        {agreements.length === 0 ? (
          <Empty>No owners yet.</Empty>
        ) : (
          <Table caption="Where each owner’s rent goes">
            <thead>
              <tr>
                <Th>Owner</Th>
                <Th>Rent goes to</Th>
                <Th>From</Th>
                <Th>Pay links</Th>
                {canChange ? <Th>Change</Th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {agreements.map((agreement) => {
                const problem = destinationProblem(agreement, accounts);
                const changes = agreementChanges(agreement);
                return (
                  <tr key={agreement.ownerId} data-testid="management-agreement">
                    <Td className="font-medium">{agreement.ownerName}</Td>
                    <Td>
                      {agreement.destination ? (
                        DESTINATION_LABELS[agreement.destination]
                      ) : (
                        <Badge tone="amber">Not chosen</Badge>
                      )}
                      {changes.next ? (
                        <p className="text-xs text-slate-700" data-testid="agreement-next">
                          {changes.next}
                        </p>
                      ) : null}
                      {changes.waiting ? (
                        <p className="text-xs text-amber-900" data-testid="agreement-waiting">
                          {changes.waiting}{' '}
                          {seeApprovals ? (
                            <Link href="/approvals" className="underline underline-offset-2">
                              Open Approvals
                            </Link>
                          ) : null}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {agreement.effectiveFrom ? formatBusinessDate(agreement.effectiveFrom) : '—'}
                    </Td>
                    <Td>
                      {problem ? (
                        <span className="text-amber-900">{destinationProblemText(problem)}</span>
                      ) : (
                        <span className="text-slate-700">Can be sent</span>
                      )}
                    </Td>
                    {canChange ? (
                      <Td>
                        {/* One request at a time: a second waits until the first is decided. */}
                        {agreement.openRequest ? (
                          <span className="text-sm text-slate-600">Waiting for approval</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={open === agreement.ownerId}
                            onClick={() => setOpen(agreement.ownerId)}
                          >
                            {agreement.destination ? 'Change' : 'Choose'}
                            <span className="sr-only"> for {agreement.ownerName}</span>
                          </Button>
                        )}
                      </Td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {open ? (
          <AgreementForm
            key={open}
            agreement={agreements.find((a) => a.ownerId === open) ?? null}
            onDone={(text) => {
              setOpen(null);
              onChanged(text);
            }}
            onCancel={() => setOpen(null)}
          />
        ) : null}
        <p className="text-sm text-slate-600">
          The hint under “Pay links” is worked out from the accounts above; when a link is sent, the
          API checks again and says why if it cannot go.
        </p>
      </CardBody>
    </Card>
  );
}

function AgreementForm({
  agreement,
  onDone,
  onCancel,
}: {
  readonly agreement: AgreementRow | null;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const { timeZone } = useApp();
  const [destination, setDestination] = useState<RentDestination | ''>(
    agreement?.destination ?? '',
  );
  const today = todayIn(timeZone);
  const [from, setFrom] = useState(today);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!agreement) return null;
  // Where rent goes never changes in the past (the API refuses it too).
  const errors = {
    destination: destination ? null : 'Choose where the rent goes',
    from: !ISO_DATE.test(from)
      ? 'Choose the date it takes effect'
      : from < today
        ? 'Choose today or a later day'
        : null,
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    if (!agreement || !destination || errors.from) return;
    setPending(true);
    try {
      const saved = await api().settlement.setAgreement({
        ownerId: agreement.ownerId,
        destination,
        effectiveFrom: from,
      });
      // Nothing changes yet: the change waits for a second person (M4b review).
      onDone(
        `Asked for ${saved.ownerName}’s rent to go to ${DESTINATION_LABELS[destination].toLowerCase()} from ${formatBusinessDate(from)}. A second person must approve it; it takes effect on that day, or 24 hours after approval if that is later. The owner has been told.`,
      );
    } catch (failure) {
      setError(toProblem(failure).message);
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Where ${agreement.ownerName}’s rent goes`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4"
    >
      <p className="text-sm font-medium text-slate-900">Where {agreement.ownerName}’s rent goes</p>
      <p className="text-sm text-slate-700">
        This asks for a change; nothing changes yet. A second person must approve it, and the owner
        is told when it is asked and when it is approved. It takes effect on the day you choose, or
        on the first day 24 hours after approval if that is later.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Rent goes to"
          value={destination}
          error={tried ? errors.destination : null}
          disabled={pending}
          options={[{ value: '', label: 'Choose' }, ...DESTINATION_OPTIONS]}
          onChange={(event) =>
            setDestination(
              DESTINATION_OPTIONS.find((o) => o.value === event.target.value)?.value ?? '',
            )
          }
        />
        <TextField
          label="From"
          type="date"
          min={today}
          value={from}
          error={tried ? errors.from : null}
          disabled={pending}
          onChange={(event) => setFrom(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Ask for approval
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
