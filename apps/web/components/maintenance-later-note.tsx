import { Alert } from './ui/alert';

/** Said plainly on every repairs page (CM-04 stub; M6 decision 12): the board comes in M8. */
export function MaintenanceLaterNote() {
  return (
    <Alert tone="info" title="The full maintenance board arrives later">
      For now this is a read-only list of reported repairs. Assigning artisans, tracking the work
      and its costs, and telling the tenant it is done come with the maintenance board in a later
      release. Until then, follow a repair up in the tenant’s conversation.
    </Alert>
  );
}
