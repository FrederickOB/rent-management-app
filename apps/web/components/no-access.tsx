import { Card, CardBody } from './ui/card';

/** Shown when the API refuses a section; the navigation already hides it, so this is rare. */
export function NoAccess({ what }: { readonly what: string }) {
  return (
    <Card data-testid="no-access">
      <CardBody>
        <p className="text-sm text-slate-700">
          You do not have access to {what} in this company. If you need it, ask an administrator.
        </p>
      </CardBody>
    </Card>
  );
}
