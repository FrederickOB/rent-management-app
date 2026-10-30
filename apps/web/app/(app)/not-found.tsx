import Link from 'next/link';
import { PageHeader } from '@/components/page-header';

/**
 * A record that does not exist, or that this person may not see (AD-02): the API answers both
 * the same way, so nobody learns what is outside their scope.
 */
export default function SignedInNotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p className="text-sm text-slate-700">
        This page does not exist, or it is not part of what you can see in this company.
      </p>
      <Link href="/" className="text-sm font-medium underline underline-offset-2">
        Go to the home page
      </Link>
    </>
  );
}
