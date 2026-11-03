import type { LeaseStatus } from '@rent/domain/tenancy';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from './api';
import {
  dueNowLabel,
  formatMoney,
  formatTime,
  nextDueLabel,
  paidUntilLabel,
  rentToCome,
} from './format';
import { openFetchedUrl } from './open-url';
import { toProblem, type Problem } from './problems';
import { useSession } from './session';
import { Button, ErrorText, Fact, Small } from './ui';
import { useCachedLoad } from './use-cached-load';

/** Leases that can have money on them: signed, in force, or over with something still owed. */
const BILLED = new Set(['signed', 'active', 'ending', 'holding_over', 'ended', 'terminated']);
export const isBilled = (status: string): boolean => BILLED.has(status);

/** Why the pay page could not be opened, in words for the tenant. */
function payLinkMessage(problem: Problem): string {
  if (problem.status === 404) return 'Nothing is waiting to be paid on this lease just now.';
  if (problem.status === 409 || problem.status === 422) return problem.message;
  return `We could not open the pay page. ${problem.message}`;
}

/**
 * One tenancy's money (M4b plan 4.10): due now, paid-until and the next payment, from the
 * ledger, with Pay. Pay asks the API for a fresh pay link and opens the pay page in the app's
 * browser, as To sign does; the link is used once and never kept. The figures reload when the
 * person comes back (`refreshTick`), and, offline, the last copy shows with when it was fetched.
 */
export function TenancyMoney({
  leaseId,
  status,
  endDate,
  refreshTick,
}: {
  leaseId: string;
  status: LeaseStatus;
  endDate: string;
  refreshTick: number;
}) {
  const { expire } = useSession();
  // Async, so even a client that throws at once becomes a failed load.
  const load = useCallback(async () => api.tenantMoney.billing({ leaseId }), [leaseId]);
  const billing = useCachedLoad(`billing:${leaseId}`, load);
  const { reload } = billing;
  const seenTick = useRef(refreshTick);
  useEffect(() => {
    if (refreshTick === seenTick.current) return;
    seenTick.current = refreshTick;
    reload();
  }, [refreshTick, reload]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opening = useRef(false);

  function pay() {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited.
    void openFetchedUrl(() => api.tenantMoney.payLink({ leaseId }), 'Opening the pay page…')
      .then((result) => {
        if (result === 'returned') reload();
      })
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(payLinkMessage(found));
        reload();
      })
      .finally(() => {
        opening.current = false;
        setBusy(false);
      });
  }

  const view = billing.view;
  if (view.status === 'loading') return <Small testID="money-loading">Loading what is due…</Small>;
  if (view.status === 'error') {
    // Not billed (404), or the session ended (401, handled by the loader): nothing to say here.
    if (view.problem.status === 404 || view.problem.status === 401) return null;
    return (
      <Small testID="money-error">We could not load what is due. {view.problem.message}</Small>
    );
  }
  const figures = view.data;
  return (
    <View style={styles.money} testID="tenancy-money">
      <Fact label="Due now" value={dueNowLabel(figures.dueNowMinor)} testID="due-now" />
      <Fact
        label="Paid until"
        value={paidUntilLabel(figures.paidUntil, figures.partial)}
        testID="paid-until"
      />
      <Fact
        label="Next payment"
        value={nextDueLabel(figures.nextDue, rentToCome(status, endDate, figures.paidUntil))}
        testID="next-due"
      />
      {figures.creditMinor > 0 ? (
        <Fact
          label="Credit"
          value={`${formatMoney(figures.creditMinor)}, kept for the months ahead`}
          testID="credit"
        />
      ) : null}
      {figures.paymentReference ? (
        <Small testID="payment-reference">Payment reference {figures.paymentReference}</Small>
      ) : null}
      {view.offline ? (
        <Small testID="money-as-of">
          As of {formatTime(figures.fetchedAt)}. You are offline, so this may be out of date.
          Connect to the internet to pay.
        </Small>
      ) : figures.canPay ? (
        <Button label="Pay rent" testID="pay" busy={busy} onPress={pay} />
      ) : figures.cannotPayReason ? (
        <Small testID="cannot-pay">{figures.cannotPayReason}</Small>
      ) : null}
      {view.refreshProblem && view.refreshProblem.status !== 401 ? (
        <Small testID="money-refresh-problem">
          We could not update these figures just now, so they may be out of date.
        </Small>
      ) : null}
      {problem ? <ErrorText testID="pay-error">{problem}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  money: { gap: 8, marginTop: 4 },
});
