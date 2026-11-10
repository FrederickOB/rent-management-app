import { redirect } from 'next/navigation';

/**
 * M9's company plans fold into the console's Companies (M10 plan 4.8): a company's tier is set on
 * its page there, with an audited reason. An old bookmark lands on the list.
 */
export default function CompanyPlansPage() {
  redirect('/platform/companies');
}
