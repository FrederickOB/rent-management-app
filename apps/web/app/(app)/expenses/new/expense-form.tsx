'use client';

import type { MaintenanceJob } from '@rent/contracts';
import { MEDIA_RULES } from '@rent/domain/maintenance';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { FileField } from '@/components/file-field';
import { PropertyUnitFields } from '@/components/property-unit-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { api, keyedApi } from '@/lib/api';
import { todayIn } from '@/lib/business-dates';
import {
  CATEGORY_OPTIONS,
  emptyExpense,
  expenseCategoryOf,
  expenseInput,
  paidByOf,
  paidByOptions,
  type ExpenseDraft,
} from '@/lib/expenses';
import { errorCode } from '@/lib/errors';
import { isKeyReused, moneyProblem, sendOnce, useIdempotencyKeeper } from '@/lib/idempotency';
import { useHoldWhileSending } from '@/lib/in-flight';
import { declaredMediaType } from '@/lib/maintenance';
import { fileProblem, sendToStorage, StorageUploadError, type UploadRule } from '@/lib/upload';

/** A receipt: a PDF or a photo, by the media rules (decision 2); the API checks its first bytes. */
const RECEIPT_RULE: UploadRule = {
  types: [...MEDIA_RULES.document.contentTypes, ...MEDIA_RULES.image.contentTypes],
  maxBytes: MEDIA_RULES.document.maxBytes,
};

export function ExpenseForm({
  initial,
  can,
}: {
  readonly initial: {
    readonly jobId: string;
    readonly propertyId: string;
    readonly unitId: string;
  };
  readonly can: { readonly linkJobs: boolean; readonly agency: boolean };
}) {
  const router = useRouter();
  const { timeZone } = useApp();
  const today = todayIn(timeZone);
  const keeper = useIdempotencyKeeper();
  const receipt = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new WeakMap<File, string>());
  const keyedFor = useRef<string | null>(null);
  const [draft, setDraft] = useState<ExpenseDraft>(() =>
    emptyExpense(today, initial.jobId, initial.propertyId, initial.unitId),
  );
  const [jobs, setJobs] = useState<readonly MaintenanceJob[]>([]);
  const [tried, setTried] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const parsed = expenseInput(draft, today, can.agency);
  const errors = tried ? parsed.errors : {};
  const working = status !== null;
  useHoldWhileSending(working);

  // The property's repairs, to link the expense to one (decision 8): Growth only.
  useEffect(() => {
    if (!can.linkJobs || !draft.propertyId) return undefined;
    let current = true;
    api()
      .maintenance.list({ propertyId: draft.propertyId, limit: 100 })
      .then(
        (page) => {
          if (current) setJobs(page.items);
        },
        () => {
          if (current) setJobs([]);
        },
      );
    return () => {
      current = false;
    };
  }, [can.linkJobs, draft.propertyId]);

  async function receiptId(file: File): Promise<string> {
    const known = uploaded.current.get(file);
    if (known) return known;
    const slot = await api().expenses.createUpload({
      contentType: declaredMediaType(file),
      sizeBytes: file.size,
    });
    await sendToStorage(slot, file);
    uploaded.current.set(file, slot.uploadId);
    return slot.uploadId;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    const file = receipt.current?.files?.[0] ?? null;
    const issue = file
      ? fileProblem(
          { name: file.name, type: declaredMediaType(file), size: file.size },
          RECEIPT_RULE,
        )
      : null;
    setFileError(issue);
    const input = parsed.input;
    if (!input || issue) return;
    const content = JSON.stringify([input, file?.name, file?.size, file?.lastModified]);
    if (keyedFor.current !== content) {
      keeper.reset();
      keyedFor.current = content;
    }
    try {
      let receiptUploadId: string | null = null;
      if (file) {
        setStatus('Uploading the receipt…');
        receiptUploadId = await receiptId(file);
      }
      setStatus('Recording the expense…');
      const recorded = await sendOnce(keeper, (key) =>
        keyedApi(key).expenses.record({ ...input, receiptUploadId }),
      );
      router.push(recorded.job ? `/repairs/${recorded.job.id}` : '/expenses?saved=1');
    } catch (failure) {
      setStatus(null);
      if (failure instanceof StorageUploadError) {
        setError(failure.message);
        return;
      }
      // The upload itself refused (a renamed file, or one that expired): send it again next time.
      if (file && /^(UPLOAD|MEDIA)_/.test(errorCode(failure))) uploaded.current.delete(file);
      setError(moneyProblem(failure));
      if (isKeyReused(failure)) {
        keeper.reset();
        keyedFor.current = null;
      }
    }
  }

  const job = jobs.find((j) => j.id === draft.jobId);
  return (
    <Card>
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Record an expense" className="space-y-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <PropertyUnitFields
            propertyId={draft.propertyId}
            unitId={draft.unitId}
            onChange={(place) =>
              setDraft((d) => ({
                ...d,
                ...place,
                jobId: place.propertyId === d.propertyId ? d.jobId : '',
              }))
            }
            disabled={working}
            noUnitLabel="The whole property"
            errors={{ propertyId: errors.propertyId, unitId: errors.unitId }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Category"
              value={draft.category}
              error={errors.category}
              hint="Repairs go to repairs and maintenance; the rest to other property costs."
              options={[{ value: '', label: 'Choose the category' }, ...CATEGORY_OPTIONS]}
              onChange={(event) =>
                setDraft((d) => ({ ...d, category: expenseCategoryOf(event.target.value) ?? '' }))
              }
            />
            <TextField
              label="Supplier"
              autoComplete="off"
              maxLength={120}
              value={draft.supplierName}
              error={errors.supplierName}
              hint="Who was paid, or is owed."
              onChange={(event) => setDraft((d) => ({ ...d, supplierName: event.target.value }))}
            />
            <TextField
              label="Amount (GH₵)"
              inputMode="decimal"
              autoComplete="off"
              value={draft.amount}
              error={errors.amount}
              onChange={(event) => setDraft((d) => ({ ...d, amount: event.target.value }))}
            />
            <TextField
              label="Date of the expense"
              type="date"
              max={today}
              value={draft.expenseDate}
              error={errors.expenseDate}
              onChange={(event) => setDraft((d) => ({ ...d, expenseDate: event.target.value }))}
            />
            <SelectField
              label="Who paid"
              value={draft.paidBy}
              error={errors.paidBy}
              options={[{ value: '', label: 'Choose who paid' }, ...paidByOptions(can.agency)]}
              onChange={(event) =>
                setDraft((d) => ({ ...d, paidBy: paidByOf(event.target.value) ?? '' }))
              }
            />
            {can.linkJobs && draft.propertyId ? (
              <SelectField
                label="For a repair (optional)"
                value={draft.jobId}
                error={errors.jobId}
                hint="The repair’s cost is the sum of its expenses."
                options={[
                  { value: '', label: 'Not for a repair' },
                  ...(draft.jobId && !job
                    ? [{ value: draft.jobId, label: 'The repair you came from' }]
                    : []),
                  ...jobs.map((j) => ({
                    value: j.id,
                    label: `${j.ticket}${j.unit ? ` · ${j.unit.code}` : ''} · ${j.description.slice(0, 60)}`,
                  })),
                ]}
                onChange={(event) => setDraft((d) => ({ ...d, jobId: event.target.value }))}
              />
            ) : null}
          </div>
          <FileField
            ref={receipt}
            label="Receipt"
            rule={RECEIPT_RULE}
            disabled={working}
            error={fileError}
            note="A photo or PDF of the supplier’s receipt or invoice. Add it if you have it."
          />
          <TextAreaField
            label="Note (optional)"
            rows={2}
            maxLength={500}
            value={draft.note}
            error={errors.note}
            onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
            className="[&_textarea]:font-sans"
          />
          {status ? (
            <p role="status" className="text-sm text-slate-700">
              {status}
            </p>
          ) : null}
          <Button type="submit" pending={working}>
            Record the expense
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
