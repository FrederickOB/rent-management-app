import type { CompanyProfile } from '@rent/contracts';
import { DEFAULT_SIGNING_REMINDER_HOURS } from '@rent/domain/esign';
import {
  companySettingsSchema,
  defaultCompanySettings,
  tenancySettingsOf,
} from '@rent/domain/settings';
import { formatIntegerList, parseIntegerList } from './integers';

// The M3 company settings (plan 4.8, 4.11 and 4.16; decision 4): product choices with the plan's
// defaults, not law (CLAUDE.md section 7). Each list is checked by the domain's own schema, so
// the form refuses exactly what the API would.

type Settings = CompanyProfile['settings'];

export interface TenancySettingsValues {
  readonly witnessRequired: boolean;
  readonly rentControlCommercial: boolean;
  readonly rentControlReminderDaysBefore: string;
  readonly stampingReminderDaysBefore: string;
  readonly signingReminderHours: string;
}

export type TenancyListField =
  'rentControlReminderDaysBefore' | 'stampingReminderDaysBefore' | 'signingReminderHours';

export type TenancySettingsErrors = Partial<Record<TenancyListField, string>>;

export interface TenancySettings {
  readonly witnessRequired: boolean;
  readonly rentControlCommercial: boolean;
  readonly rentControlReminderDaysBefore: number[];
  readonly stampingReminderDaysBefore: number[];
  readonly signingReminderHours: number[];
}

const DEFAULTS = tenancySettingsOf(defaultCompanySettings());

/** The defaults people see in the hints, from the domain. */
export const TENANCY_DEFAULTS = {
  witnessRequired: DEFAULTS.witnessRequired,
  rentControlCommercial: DEFAULTS.rentControlCommercial,
  rentControlReminderDaysBefore: formatIntegerList(DEFAULTS.rentControlReminderDaysBefore),
  stampingReminderDaysBefore: formatIntegerList(DEFAULTS.stampingReminderDaysBefore),
  signingReminderHours: formatIntegerList(DEFAULT_SIGNING_REMINDER_HOURS),
} as const;

/** The form's values from the settings in force. The API sends them with defaults applied. */
export function tenancyValuesOf(settings: Settings): TenancySettingsValues {
  return {
    witnessRequired: settings.witnessRequired ?? DEFAULTS.witnessRequired,
    rentControlCommercial: settings.rentControlCommercial ?? DEFAULTS.rentControlCommercial,
    rentControlReminderDaysBefore: formatIntegerList(
      settings.rentControlReminderDaysBefore ?? DEFAULTS.rentControlReminderDaysBefore,
    ),
    stampingReminderDaysBefore: formatIntegerList(
      settings.stampingReminderDaysBefore ?? DEFAULTS.stampingReminderDaysBefore,
    ),
    signingReminderHours: formatIntegerList(
      settings.signingReminderHours ?? DEFAULT_SIGNING_REMINDER_HOURS,
    ),
  };
}

const MESSAGES: Record<TenancyListField, string> = {
  rentControlReminderDaysBefore:
    'Enter 1 to 12 whole numbers of days, from 0 to 366, separated by commas.',
  stampingReminderDaysBefore:
    'Enter 1 to 12 whole numbers of days, from 0 to 366, separated by commas.',
  signingReminderHours:
    'Enter 1 to 12 whole numbers of hours, from 1 to 720 (30 days), separated by commas.',
};

function list(
  text: string,
  field: TenancyListField,
  errors: { -readonly [K in TenancyListField]?: string },
): number[] {
  const values = parseIntegerList(text);
  const checked = companySettingsSchema.shape[field].safeParse(values ?? []);
  if (!values || !checked.success || !checked.data) {
    errors[field] = MESSAGES[field];
    return [];
  }
  return [...checked.data];
}

/** The settings to save, or the problems by field, checked by the domain's schema. */
export function parseTenancySettings(values: TenancySettingsValues): {
  readonly settings: TenancySettings;
  readonly errors: TenancySettingsErrors;
} {
  const errors: { -readonly [K in TenancyListField]?: string } = {};
  const settings: TenancySettings = {
    witnessRequired: values.witnessRequired,
    rentControlCommercial: values.rentControlCommercial,
    rentControlReminderDaysBefore: list(
      values.rentControlReminderDaysBefore,
      'rentControlReminderDaysBefore',
      errors,
    ),
    stampingReminderDaysBefore: list(
      values.stampingReminderDaysBefore,
      'stampingReminderDaysBefore',
      errors,
    ),
    signingReminderHours: list(values.signingReminderHours, 'signingReminderHours', errors),
  };
  return { settings, errors };
}
