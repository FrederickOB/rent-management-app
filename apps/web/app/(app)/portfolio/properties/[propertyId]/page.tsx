import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { NoAccess } from '@/components/no-access';
import { PageHeader } from '@/components/page-header';
import { allowed } from '@/lib/policy';
import { getMe, loadOwners, loadProperty, loadRegisterOptions } from '@/lib/server/session';
import { PropertyDetail } from './property-detail';

type Params = Promise<{ readonly propertyId: string }>;

// One API call per request, shared by the title and the page.
const property = cache((propertyId: string) => loadProperty(propertyId));

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  const loaded = await property((await params).propertyId);
  return { title: loaded.ok ? `${loaded.data.code} ${loaded.data.name}` : 'Property' };
}

/** A property: units by block, address, owner, photos and papers, meters (PR-01 to PR-05). */
export default async function PropertyPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ propertyId }, query, me] = await Promise.all([params, searchParams, getMe()]);
  if (!me) return null;
  const loaded = await property(propertyId);
  if (!loaded.ok) {
    // Outside this person's scope looks exactly like a property that does not exist (AD-02).
    if (loaded.status !== 403) notFound();
    return (
      <>
        <PageHeader title="Property" />
        <NoAccess what="this property" />
      </>
    );
  }
  const can = {
    manage: allowed(me, 'register.manage'),
    changeOwner: allowed(me, 'owner.manage'),
    upload: allowed(me, 'property_file.upload'),
    seePhotos: allowed(me, 'property_photo.view'),
    seePapers: allowed(me, 'property_paper.view'),
  };
  const [options, owners] = await Promise.all([
    can.manage ? loadRegisterOptions() : null,
    can.changeOwner ? loadOwners() : null,
  ]);
  return (
    <PropertyDetail
      initial={loaded.data}
      can={can}
      options={options?.ok ? options.data : null}
      owners={owners?.ok ? owners.data.filter((o) => !o.archived) : []}
      created={query.created === '1'}
    />
  );
}
