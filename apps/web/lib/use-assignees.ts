import type { ArtisanView, MembershipRow } from '@rent/contracts';
import { useEffect, useState } from 'react';
import { api } from './api';
import { assignable, tradesText } from './artisans';
import { roleLabel } from './format';

// Who a job can be given to (MI-04, decision 6): staff (in-house, a task) and artisans (a job sheet
// link). Lists are fetched only when this session may list them; the API checks the assignment.

export interface AssigneeOption {
  /** `staff:<personId>` or `artisan:<artisanId>`. */
  readonly value: string;
  readonly label: string;
  readonly kind: 'staff' | 'artisan';
}

/**
 * Active staff. Whether one of them may attend this job (their role and properties) is the API's
 * decision, never this list's: it refuses an assignment the policy does not allow.
 */
export function staffOptions(rows: readonly MembershipRow[]): AssigneeOption[] {
  return rows
    .filter((row) => row.status === 'active')
    .map((row) => ({
      value: `staff:${row.personId}`,
      label: `${row.name} (${roleLabel(row.role).toLowerCase()})`,
      kind: 'staff' as const,
    }));
}

export function artisanOptions(rows: readonly ArtisanView[]): AssigneeOption[] {
  return rows.filter(assignable).map((row) => ({
    value: `artisan:${row.id}`,
    label: `${row.name}, artisan (${tradesText(row.trades).toLowerCase()})`,
    kind: 'artisan' as const,
  }));
}

export function useAssignees(can: {
  readonly listStaff: boolean;
  readonly listArtisans: boolean;
}): readonly AssigneeOption[] {
  const [options, setOptions] = useState<readonly AssigneeOption[]>([]);
  useEffect(() => {
    let current = true;
    void Promise.all([
      can.listStaff
        ? api()
            .memberships.list()
            .catch(() => [])
        : Promise.resolve([]),
      can.listArtisans
        ? api()
            .artisans.list({})
            .catch(() => [])
        : Promise.resolve([]),
    ]).then(([staff, artisans]) => {
      if (current) setOptions([...staffOptions(staff), ...artisanOptions(artisans)]);
    });
    return () => {
      current = false;
    };
  }, [can.listStaff, can.listArtisans]);
  return options;
}
