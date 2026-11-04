import type { TenantGroup } from '@rent/contracts';

// Tenant groups (CM-08): named audiences for broadcasts. The API checks the same bounds.

export interface GroupDraft {
  readonly name: string;
  readonly description: string;
}

export const GROUP_NAME_MIN = 2;
export const GROUP_NAME_MAX = 60;
export const GROUP_DESCRIPTION_MAX = 300;

export function groupErrors(draft: GroupDraft): Partial<Record<keyof GroupDraft, string>> {
  const errors: { -readonly [K in keyof GroupDraft]?: string } = {};
  const name = draft.name.trim().length;
  if (name < GROUP_NAME_MIN || name > GROUP_NAME_MAX)
    errors.name = `Give the group a name of ${GROUP_NAME_MIN} to ${GROUP_NAME_MAX} characters`;
  if (draft.description.trim().length > GROUP_DESCRIPTION_MAX)
    errors.description = `Use at most ${GROUP_DESCRIPTION_MAX} characters`;
  return errors;
}

/** The fields that changed, as the update route takes them; empty when nothing did. */
export function groupPatch(
  group: Pick<TenantGroup, 'name' | 'description'>,
  draft: GroupDraft,
): { name?: string; description?: string | null } {
  const patch: { name?: string; description?: string | null } = {};
  if (draft.name.trim() !== group.name) patch.name = draft.name.trim();
  const description = draft.description.trim() || null;
  if (description !== (group.description ?? null)) patch.description = description;
  return patch;
}

/**
 * A group by id among lists of groups. The detail page now reads one group from
 * `GET /tenant-groups/{groupId}`; this stays with its unit test, which has passed (review rule 1).
 */
export function findGroup(
  lists: readonly (readonly TenantGroup[])[],
  groupId: string,
): TenantGroup | null {
  for (const list of lists) {
    const found = list.find((g) => g.id === groupId);
    if (found) return found;
  }
  return null;
}
