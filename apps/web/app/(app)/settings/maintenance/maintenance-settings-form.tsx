'use client';

import type { CompanyProfile } from '@rent/contracts';
import { MAINTENANCE_PRIORITIES, MAINTENANCE_PRIORITY_LABELS } from '@rent/domain/maintenance';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toProblem } from '@/lib/errors';
import { parseInteger } from '@/lib/integers';
import {
  hoursText,
  maintenanceSettingsDraftOf,
  maintenanceSettingsPatch,
  type MaintenanceSettingsDraft,
} from '@/lib/maintenance-settings';

/** The targets per priority (MI-02, decision 4) and auto-close days (MI-06, decision 7). */
export function MaintenanceSettingsForm({ company }: { readonly company: CompanyProfile }) {
  const router = useRouter();
  const [draft, setDraft] = useState<MaintenanceSettingsDraft>(() =>
    maintenanceSettingsDraftOf(company.settings),
  );
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    const result = maintenanceSettingsPatch(draft);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const profile = await api().company.updateSettings(result.patch);
      setDraft(maintenanceSettingsDraftOf(profile.settings));
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setProblem(toProblem(failure).message);
    } finally {
      setPending(false);
    }
  }

  const words = (text: string) => {
    const hours = parseInteger(text);
    return hours !== null && hours > 0 ? hoursText(hours) : undefined;
  };

  return (
    <Card data-testid="maintenance-settings">
      <CardHeader
        title="Target times and closing"
        description="Calendar hours from the report. “Respond” means assigned or attended. The manager is warned as a target is about to be missed, and again when it is missed. A job already triaged keeps its targets."
      />
      <CardBody>
        <form onSubmit={submit} noValidate aria-label="Maintenance settings" className="space-y-6">
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          {saved ? <Alert tone="success">Saved the maintenance settings.</Alert> : null}
          {MAINTENANCE_PRIORITIES.map((p) => (
            <fieldset
              key={p}
              className="space-y-2 rounded-md border border-slate-200 p-3"
              data-testid={`targets-${p}`}
            >
              <legend className="px-1 text-sm font-semibold text-slate-900">
                {MAINTENANCE_PRIORITY_LABELS[p]}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Respond within, hours"
                  inputMode="numeric"
                  value={draft.targets[p].respondHours}
                  error={errors[`${p}.respond`]}
                  hint={words(draft.targets[p].respondHours)}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      targets: {
                        ...d.targets,
                        [p]: { ...d.targets[p], respondHours: event.target.value },
                      },
                    }))
                  }
                />
                <TextField
                  label="Complete within, hours"
                  inputMode="numeric"
                  value={draft.targets[p].completeHours}
                  error={errors[`${p}.complete`]}
                  hint={words(draft.targets[p].completeHours)}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      targets: {
                        ...d.targets,
                        [p]: { ...d.targets[p], completeHours: event.target.value },
                      },
                    }))
                  }
                />
              </div>
            </fieldset>
          ))}
          <TextField
            label="Close a finished job without the tenant’s reply after, days"
            hint="After the work is marked done, the tenant is asked to confirm. With no reply in this many days, the job closes and the record says so."
            inputMode="numeric"
            value={draft.autoCloseDays}
            error={errors.autoClose}
            onChange={(event) => setDraft((d) => ({ ...d, autoCloseDays: event.target.value }))}
            className="max-w-md"
          />
          <Button type="submit" pending={pending}>
            Save the maintenance settings
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
