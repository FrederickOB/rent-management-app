'use client';

import type { CompanyProfile } from '@rent/contracts';
import {
  LADDER_NOTICE_TYPES,
  NOTICE_TYPE_LABELS,
  type LadderNoticeType,
} from '@rent/domain/notices';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import {
  ladderIsFull,
  noticeSettingsDraftOf,
  noticeSettingsPatch,
  type NoticeSettingsDraft,
} from '@/lib/notice-settings';
import { ladderConfigOf, ladderSummary, type LadderDraft } from '@/lib/notices';

/** The ladder per type, the sending window and link expiry (plan 4.9). */
export function NoticeSettingsForm({
  company,
  canEdit,
}: {
  readonly company: CompanyProfile;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<NoticeSettingsDraft>(() =>
    noticeSettingsDraftOf(company.settings),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setLadder = (type: LadderNoticeType, next: Partial<LadderDraft>) =>
    setDraft((current) => ({
      ...current,
      ladders: { ...current.ladders, [type]: { ...current.ladders[type], ...next } },
    }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    const result = noticeSettingsPatch(draft);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const profile = await api().company.updateSettings({
        noticeLadders: result.patch.noticeLadders,
        noticeSendWindow: result.patch.noticeSendWindow,
        noticeLinkExpiryDays: result.patch.noticeLinkExpiryDays,
      });
      setDraft(noticeSettingsDraftOf(profile.settings));
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card data-testid="notice-settings">
      <CardHeader
        title="Reminders, quiet hours and links"
        description="Hours count from issue. A step that falls outside the sending window waits for it; tasks and alerts to staff are never held. A notice already issued keeps the ladder it was issued with."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Notice settings" className="space-y-6">
          <fieldset className="space-y-4" disabled={!canEdit}>
            <legend className="text-sm font-semibold text-slate-900">Ladder per notice type</legend>
            {LADDER_NOTICE_TYPES.map((type) => {
              const ladder = draft.ladders[type];
              const parsed = ladderConfigOf(ladder);
              return (
                <div
                  key={type}
                  className="space-y-2 rounded-md border border-slate-200 p-3"
                  data-testid={`ladder-${type}`}
                >
                  <p className="text-sm font-medium text-slate-900">{NOTICE_TYPE_LABELS[type]}</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <TextField
                      label="Reminders, hours after issue"
                      hint="Such as 24, 72. Up to 6."
                      value={ladder.reminderHours}
                      onChange={(event) => setLadder(type, { reminderHours: event.target.value })}
                    />
                    {ladderIsFull(type) ? (
                      <>
                        <TextField
                          label="In person, hours after issue"
                          hint="A task for the caretaker and an alert to the manager. Blank: none."
                          inputMode="numeric"
                          value={ladder.inPersonHours}
                          onChange={(event) =>
                            setLadder(type, { inPersonHours: event.target.value })
                          }
                        />
                        <TextField
                          label="Escalation, hours after issue"
                          hint="The physical service pack. Blank: none."
                          inputMode="numeric"
                          value={ladder.escalationHours}
                          onChange={(event) =>
                            setLadder(type, { escalationHours: event.target.value })
                          }
                        />
                      </>
                    ) : null}
                  </div>
                  {errors[type] ? (
                    <p className="text-sm font-medium text-red-700">{errors[type]}</p>
                  ) : 'config' in parsed ? (
                    <p className="text-sm text-slate-600">{ladderSummary(parsed.config)}</p>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
          <fieldset className="space-y-2" disabled={!canEdit}>
            <legend className="text-sm font-semibold text-slate-900">
              Sending window for tenants (company time, {company.timeZone})
            </legend>
            <div className="grid max-w-md grid-cols-2 gap-3">
              <TextField
                label="From"
                type="time"
                value={draft.from}
                error={errors.window}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              />
              <TextField
                label="To"
                type="time"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              />
            </div>
          </fieldset>
          <fieldset disabled={!canEdit} className="max-w-md">
            <TextField
              label="Days a link works for a notice without a notice period"
              hint="From 30 to 366. A notice with a period keeps its links until the period ends."
              inputMode="numeric"
              value={draft.linkExpiryDays}
              error={errors.linkExpiryDays}
              onChange={(event) => setDraft({ ...draft, linkExpiryDays: event.target.value })}
            />
          </fieldset>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {saved ? <Alert tone="success">Saved the notice settings.</Alert> : null}
          {canEdit ? (
            <Button type="submit" pending={pending}>
              Save notice settings
            </Button>
          ) : (
            <p className="text-sm text-slate-600">Ask an administrator to change these.</p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
