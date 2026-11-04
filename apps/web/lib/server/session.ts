import 'server-only';
import type {
  CompanyProfile,
  MembershipRow,
  Me,
  OwnerRow,
  PropertyDetailView,
  UnitDetailView,
} from '@rent/contracts';
import { createApiClient, type ApiClient } from '@rent/contracts/client';
import { headers } from 'next/headers';
import { cache } from 'react';
import { statusOf } from '../errors';

// Server-side only: server components call the API directly, never through the browser proxy.
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3700').replace(/\/+$/, '');

/** The API as the person making this request: their cookie header is forwarded as it came. */
async function serverApi(): Promise<ApiClient> {
  const cookie = (await headers()).get('cookie');
  const forwarded: Record<string, string> = cookie ? { cookie } : {};
  return createApiClient({ baseUrl: API_BASE_URL, headers: () => forwarded });
}

/** The signed-in person and what their session may do, or null when nobody is signed in. */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    return await (await serverApi()).me.get();
  } catch (error) {
    if (statusOf(error) === 401) return null;
    throw error;
  }
});

/** The active company, or null when this session may not see it (for example a platform admin). */
export const getCompany = cache(async (): Promise<CompanyProfile | null> => {
  try {
    return await (await serverApi()).company.get();
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403 || status === 404) return null;
    throw error;
  }
});

export type Loaded<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number | null };

/** People in the active company; a refusal is returned, not thrown, so a page can hide the section. */
export async function loadMemberships(): Promise<Loaded<MembershipRow[]>> {
  try {
    return { ok: true, data: await (await serverApi()).memberships.list() };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403 || status === 404) return { ok: false, status };
    throw error;
  }
}

/**
 * Calls the API as this person. A refusal (403), a record that is missing or outside their
 * scope (404) or a malformed id in the address (400) is returned, not thrown, so the page can
 * show "not found" or "no access"; anything else is a real failure.
 */
async function load<T>(call: (api: ApiClient) => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await call(await serverApi()) };
  } catch (error) {
    const status = statusOf(error);
    if (status === 400 || status === 401 || status === 403 || status === 404)
      return { ok: false, status };
    throw error;
  }
}

type RegisterOptions = Awaited<ReturnType<ApiClient['register']['options']>>;
type PropertyList = Awaited<ReturnType<ApiClient['register']['listProperties']>>;
type UnitList = Awaited<ReturnType<ApiClient['register']['listUnits']>>;

/** Regions, meter suppliers, portfolios and whether address lookups work (M2). */
export const loadRegisterOptions = cache((): Promise<Loaded<RegisterOptions>> =>
  load((api) => api.register.options()),
);

/** Owners this person may see (AD-02), archived ones too when asked. */
export function loadOwners(includeArchived = false): Promise<Loaded<OwnerRow[]>> {
  return load((api) => api.owners.list(includeArchived ? { includeArchived: 'true' } : {}));
}

/** Every property this person may see, with unit counts by status. */
export function loadPropertyList(): Promise<Loaded<PropertyList>> {
  return load((api) => api.register.listProperties({}));
}

/** Unit counts by status across everything this person may see (one row, for the counts). */
export function loadUnitCounts(): Promise<Loaded<UnitList>> {
  return load((api) => api.register.listUnits({ limit: 1 }));
}

export function loadProperty(propertyId: string): Promise<Loaded<PropertyDetailView>> {
  return load((api) => api.register.getProperty({ propertyId }));
}

export function loadUnit(unitId: string): Promise<Loaded<UnitDetailView>> {
  return load((api) => api.register.getUnit({ unitId }));
}

// M3: tenants, leases and templates (plan 4.16). Each returns a refusal or a missing record
// instead of throwing, so the page can show "not found" or "no access".

type TenantView = Awaited<ReturnType<ApiClient['tenants']['get']>>;
type LeaseView = Awaited<ReturnType<ApiClient['leases']['get']>>;
type TemplateView = Awaited<ReturnType<ApiClient['leaseTemplates']['get']>>;
type ExpiringList = Awaited<ReturnType<ApiClient['leases']['expiring']>>;

export function loadTenant(tenantId: string): Promise<Loaded<TenantView>> {
  return load((api) => api.tenants.get({ tenantId }));
}

export function loadLease(leaseId: string): Promise<Loaded<LeaseView>> {
  return load((api) => api.leases.get({ leaseId }));
}

export function loadTemplate(templateId: string): Promise<Loaded<TemplateView>> {
  return load((api) => api.leaseTemplates.get({ templateId }));
}

/** Leases ending in the next `days` days (TL-09): the home page and the expiring list. */
export function loadExpiring(days = 90): Promise<Loaded<ExpiringList>> {
  return load((api) => api.leases.expiring({ days }));
}

type TemplateList = Awaited<ReturnType<ApiClient['leaseTemplates']['list']>>;

/** The company's lease templates, with the three starters seeded on first use (TL-05). */
export function loadTemplates(): Promise<Loaded<TemplateList>> {
  return load((api) => api.leaseTemplates.list({}));
}

// M4a: invoices and payments (plan 4.18). A refusal or a missing record is returned, not thrown.

type InvoiceView = Awaited<ReturnType<ApiClient['invoices']['get']>>;
type PaymentView = Awaited<ReturnType<ApiClient['payments']['get']>>;

/** An invoice with its lines, allocations and warnings (BC-01, CT-04). */
export function loadInvoice(invoiceId: string): Promise<Loaded<InvoiceView>> {
  return load((api) => api.invoices.get({ invoiceId }));
}

/** A payment with its allocations, receipts and reversal options (BC-07, P21). */
export function loadPayment(paymentId: string): Promise<Loaded<PaymentView>> {
  return load((api) => api.payments.get({ paymentId }));
}
