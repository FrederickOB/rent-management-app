/**
 * Who acted on a job, or who it is assigned to (M8): artisans and tenants as kinds of actor, not
 * staff roles. Role checks stay in the policy module (CLAUDE.md section 5); these name the kinds
 * once so the code compares against them by name.
 */
export const ARTISAN_KIND = 'artisan' as const;
export const TENANT_KIND = 'tenant' as const;
