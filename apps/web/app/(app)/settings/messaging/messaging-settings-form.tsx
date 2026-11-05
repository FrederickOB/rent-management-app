'use client';

import type { MessagingSettings } from '@rent/contracts';
import { PLAN_FEATURE_NAMES } from '@rent/domain/settings';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LoadFailed, Loading } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { durationText } from '@/lib/inbox';
import {
  firstResponseProblem,
  minutesOf,
  normaliseTag,
  tagProblem,
} from '@/lib/messaging-settings';
import { planLabel } from '@/lib/plan';

export function MessagingSettingsForm({ canEdit }: { readonly canEdit: boolean }) {
  const [settings, setSettings] = useState<MessagingSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await api().messagingSettings.get());
      setProblem(null);
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (problem) return <LoadFailed message={problem} onRetry={() => void load()} />;
  if (!settings) return <Loading what="messaging settings" />;
  const inbox = settings.features.includes('inbox');

  return (
    <>
      <Card data-testid="whatsapp-number">
        <CardHeader
          title="Your WhatsApp number"
          description="Set up by the platform. Ask us to register your own number."
        />
        <CardBody>
          {settings.whatsappNumber ? (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-600">Number</dt>
                <dd className="font-medium">{settings.whatsappNumber.displayPhone}</dd>
              </div>
              <div>
                <dt className="text-slate-600">Name tenants see</dt>
                <dd className="font-medium">{settings.whatsappNumber.displayName}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-slate-600">Kind</dt>
                <dd>
                  {settings.whatsappNumber.kind === 'shared'
                    ? 'The shared platform number. Every template starts with your company’s name, so tenants know who it is from.'
                    : 'Your company’s own number.'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-slate-700">
              No WhatsApp number is set up yet, so messages go by SMS and email.
            </p>
          )}
        </CardBody>
      </Card>

      <Card data-testid="plan">
        <CardHeader title="Plan" />
        <CardBody>
          <p className="text-sm">
            <Badge tone="blue">{planLabel(settings.plan)}</Badge>
          </p>
          <p className="text-sm text-slate-700">
            {settings.features.length
              ? `Includes: ${settings.features.map((f) => PLAN_FEATURE_NAMES[f]).join(', ')}.`
              : 'Includes WhatsApp reminders and the assistant’s short menu. The inbox, broadcasts, tenant groups and repairs are on the Growth plan.'}
          </p>
        </CardBody>
      </Card>

      {inbox ? <InboxSettings settings={settings} canEdit={canEdit} onSaved={setSettings} /> : null}
    </>
  );
}

function InboxSettings({
  settings,
  canEdit,
  onSaved,
}: {
  readonly settings: MessagingSettings;
  readonly canEdit: boolean;
  readonly onSaved: (settings: MessagingSettings) => void;
}) {
  const router = useRouter();
  const [hours, setHours] = useState(String(Math.floor(settings.firstResponseMinutes / 60)));
  const [minutes, setMinutes] = useState(String(settings.firstResponseMinutes % 60));
  const [tags, setTags] = useState<readonly string[]>(settings.tags);
  const [newTag, setNewTag] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const total = minutesOf(hours, minutes);
  const targetProblem = tried ? firstResponseProblem(total) : null;

  function addTag() {
    const tag = normaliseTag(newTag);
    const problem = tagProblem(tag, tags);
    setTagError(problem);
    if (problem) return;
    setTags([...tags, tag]);
    setNewTag('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTried(true);
    setError(null);
    setSaved(false);
    if (firstResponseProblem(total) || total === null) return;
    if (tags.length === 0) {
      setError('Keep at least one tag.');
      return;
    }
    setPending(true);
    try {
      onSaved(
        await api().messagingSettings.update({ firstResponseMinutes: total, tags: [...tags] }),
      );
      setSaved(true);
      // The inbox reads the tag list from the company profile.
      router.refresh();
    } catch (failure) {
      setError(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  if (!canEdit) {
    return (
      <Card>
        <CardHeader title="Inbox" />
        <CardBody>
          <p className="text-sm">
            First reply within <strong>{durationText(settings.firstResponseMinutes)}</strong> of a
            tenant’s message.
          </p>
          <div className="flex flex-wrap gap-1">
            {settings.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Inbox"
        description="A conversation that waits longer than the target for its first reply is marked overdue, and its assignee (or, when nobody has it, the managers) is alerted."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Inbox settings" className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">
              First reply within (clock time)
            </legend>
            <div className="grid max-w-sm grid-cols-2 gap-3">
              <TextField
                label="Hours"
                inputMode="numeric"
                value={hours}
                error={targetProblem}
                onChange={(event) => setHours(event.target.value)}
              />
              <TextField
                label="Minutes"
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </div>
            {total !== null && !firstResponseProblem(total) ? (
              <p className="text-sm text-slate-600">
                {durationText(total)} from the tenant’s message.
              </p>
            ) : null}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">Tags staff can use</legend>
            <ul className="flex flex-wrap gap-2" aria-label="Tags">
              {tags.map((tag) => (
                <li key={tag} className="flex items-center gap-1" data-testid="settings-tag">
                  <Badge>{tag}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove the tag ${tag}`}
                    onClick={() => setTags(tags.filter((t) => t !== tag))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label="New tag"
                hint="Lower case, such as water or rent-query."
                value={newTag}
                error={tagError}
                onChange={(event) => setNewTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addTag();
                  }
                }}
              />
              <Button variant="secondary" onClick={addTag}>
                Add tag
              </Button>
            </div>
          </fieldset>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {saved ? <Alert tone="success">Saved the inbox settings.</Alert> : null}
          <Button type="submit" pending={pending}>
            Save inbox settings
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
