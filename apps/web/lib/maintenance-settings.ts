import type { CompanyProfile } from '@rent/contracts';
import {
  MAINTENANCE_PRIORITIES,
  maintenanceSettingsOf,
  type MaintenancePriority,
} from '@rent/domain/maintenance';
import { parseInteger } from './integers';

// Maintenance settings (MI-02, MI-06; M8 decisions 4 and 7): the respond and complete targets per
// priority, in calendar hours, and the days after work done that a job closes without the
// tenant's reply. Product settings, not law; the domain holds the defaults.

export interface TargetDraft {
  readonly respondHours: string;
  readonly completeHours: string;
}

export interface MaintenanceSettingsDraft {
  readonly targets: Readonly<Record<MaintenancePriority, TargetDraft>>;
  readonly autoCloseDays: string;
}

export function maintenanceSettingsDraftOf(
  settings: CompanyProfile['settings'],
): MaintenanceSettingsDraft {
  const inForce = maintenanceSettingsOf({
    ...(settings.maintenanceTargets ? { maintenanceTargets: settings.maintenanceTargets } : {}),
    ...(settings.maintenanceAutoCloseDays !== undefined
      ? { maintenanceAutoCloseDays: settings.maintenanceAutoCloseDays }
      : {}),
  });
  const targets = Object.fromEntries(
    MAINTENANCE_PRIORITIES.map((p) => [
      p,
      {
        respondHours: String(inForce.targets[p].respondHours),
        completeHours: String(inForce.targets[p].completeHours),
      },
    ]),
  ) as Record<MaintenancePriority, TargetDraft>;
  return { targets, autoCloseDays: String(inForce.autoCloseDays) };
}

const HOURS_MAX = 24 * 90;

/** "2 hours", "3 days", "14 days and 6 hours": how a target reads beside its field. */
export function hoursText(hours: number): string {
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const h = rest === 1 ? '1 hour' : `${rest} hours`;
  if (days === 0) return h;
  const d = days === 1 ? '1 day' : `${days} days`;
  return rest === 0 ? d : `${d} and ${h}`;
}

export type MaintenanceSettingsPatch = {
  maintenanceTargets: Record<MaintenancePriority, { respondHours: number; completeHours: number }>;
  maintenanceAutoCloseDays: number;
};

/**
 * The settings to save, or the problems by field (`<priority>.respond`, `<priority>.complete`,
 * `autoClose`): whole hours from 1 to 2,160 (90 days), the response no later than the completion,
 * and auto-close after 1 to 60 days, as the settings contract takes them.
 */
export function maintenanceSettingsPatch(
  draft: MaintenanceSettingsDraft,
):
  | { readonly patch: MaintenanceSettingsPatch }
  | { readonly errors: Readonly<Record<string, string>> } {
  const errors: Record<string, string> = {};
  const targets = {} as Record<
    MaintenancePriority,
    { respondHours: number; completeHours: number }
  >;
  for (const p of MAINTENANCE_PRIORITIES) {
    const respond = parseInteger(draft.targets[p].respondHours);
    const complete = parseInteger(draft.targets[p].completeHours);
    if (respond === null || respond < 1 || respond > HOURS_MAX)
      errors[`${p}.respond`] = 'Whole hours from 1 to 2,160 (90 days)';
    if (complete === null || complete < 1 || complete > HOURS_MAX)
      errors[`${p}.complete`] = 'Whole hours from 1 to 2,160 (90 days)';
    if (respond !== null && complete !== null && respond > complete)
      errors[`${p}.respond`] = 'The response target must come before the completion target';
    if (respond !== null && complete !== null)
      targets[p] = { respondHours: respond, completeHours: complete };
  }
  const days = parseInteger(draft.autoCloseDays);
  if (days === null || days < 1 || days > 60) errors.autoClose = 'Whole days from 1 to 60';
  if (Object.keys(errors).length > 0 || days === null) return { errors };
  return { patch: { maintenanceTargets: targets, maintenanceAutoCloseDays: days } };
}
