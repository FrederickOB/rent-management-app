import {
  AVAILABILITY,
  AVAILABILITY_LABELS,
  BAND_REASON_MIN_LENGTH,
  BILLING_BANDS,
  checkAvailabilityChange,
  defaultBandFor,
  STATUS_REASON_MIN_LENGTH,
  type Availability,
  type BillingBand,
  type DisplayStatus,
  type UnitType,
} from '@rent/domain/portfolio';

/**
 * The availability changes a person may choose for a unit (PR-06): the domain's state machine
 * decides, so the form offers exactly what the API accepts. Occupancy comes from leases (M3): a
 * lease holds the unit while it is occupied, and also while it is reserved between signature and
 * start (PB-09), so both keep the unit available or under repair, as the API does.
 */
export function availabilityChoices(
  from: Availability,
  status: DisplayStatus,
  occupancy?: 'occupied' | 'reserved' | 'vacant',
): Availability[] {
  const occupied = status === 'occupied' || (occupancy !== undefined && occupancy !== 'vacant');
  return AVAILABILITY.filter((to) => {
    try {
      checkAvailabilityChange(from, to, { occupied });
      return true;
    } catch {
      return false;
    }
  });
}

/** Why nothing can be chosen, for a unit whose availability must go back to available first. */
export function availabilityHint(from: Availability, choices: readonly Availability[]): string {
  if (choices.length === 0) return 'No change is possible from here.';
  if (from === 'available')
    return 'Reserve the unit, mark it under repair, or take it off the market.';
  return `A unit that is ${AVAILABILITY_LABELS[from].toLowerCase()} is made available again before anything else.`;
}

export function reasonProblem(reason: string): string | null {
  return reason.trim().length < STATUS_REASON_MIN_LENGTH ? 'Give a reason for the change' : null;
}

/** The bands an override can choose: every band but the one the unit has. */
export function bandChoices(current: BillingBand): BillingBand[] {
  return BILLING_BANDS.filter((band) => band !== current);
}

/**
 * Checks a band override (PB-01): a band that differs from the type's default needs a reason of
 * at least BAND_REASON_MIN_LENGTH characters; choosing the default needs none.
 */
export function bandOverrideProblem(
  type: UnitType,
  band: BillingBand,
  reason: string,
): string | null {
  if (band === defaultBandFor(type)) return null;
  return reason.trim().length < BAND_REASON_MIN_LENGTH
    ? `Give a reason of at least ${BAND_REASON_MIN_LENGTH} characters`
    : null;
}
