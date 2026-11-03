import { Redirect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../src/api';
import { formatDate, formatMoney, formatTime, paymentMethodLabel } from '../src/format';
import { openFetchedUrl } from '../src/open-url';
import { byLandlord, unitsOf, type LandlordPayments, type Payment } from '../src/payment-groups';
import { toProblem } from '../src/problems';
import { useSession } from '../src/session';
import {
  BackLink,
  Badge,
  Body,
  Button,
  Card,
  colours,
  ErrorText,
  Heading,
  Loading,
  Notice,
  Screen,
  Small,
} from '../src/ui';
import { useCachedLoad } from '../src/use-cached-load';
import { useReloadOnReturn } from '../src/use-load';

const loadPayments = async () => api.tenantMoney.payments();
const loadTenancies = async () => api.tenantApp.tenancies();

/**
 * Payments and receipts (M4b plan 4.10): every payment the tenant has made, with its receipt to
 * download through a 5-minute link fetched at the tap and never kept. Offline, the last list
 * fetched on this device shows, with the time it was fetched.
 */
export default function Payments() {
  const router = useRouter();
  const { me, loading } = useSession();
  const payments = useCachedLoad('payments', loadPayments, Boolean(me));
  const tenancies = useCachedLoad('tenancies', loadTenancies, Boolean(me));
  const { reload: reloadPayments } = payments;
  const { reload: reloadTenancies } = tenancies;
  useReloadOnReturn(
    useCallback(() => {
      reloadPayments();
      reloadTenancies();
    }, [reloadPayments, reloadTenancies]),
  );

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!loading && !me) return <Redirect href="/sign-in" />;

  const view = payments.view;
  const groups = tenancies.view.status === 'ready' ? tenancies.view.data : null;
  return (
    <Screen title="Payments and receipts" top={<BackLink onPress={back} label="Home" />} scroll>
      {view.status === 'loading' ? <Loading label="Loading your payments" /> : null}
      {view.status === 'error' ? (
        <View style={styles.stack}>
          <ErrorText>We could not load your payments. {view.problem.message}</ErrorText>
          <Button label="Try again" variant="quiet" testID="retry" onPress={payments.retry} />
        </View>
      ) : null}
      {view.status === 'ready' ? (
        <View style={styles.stack}>
          {view.offline ? (
            <Notice testID="offline">
              You are offline. This is the list we last fetched, at {formatTime(view.fetchedAt)}, so
              it may be out of date. Receipts download once you are back online.
            </Notice>
          ) : null}
          {view.refreshProblem && view.refreshProblem.status !== 401 ? (
            <Notice testID="refresh-problem">
              We could not update this just now, so it may be out of date.
            </Notice>
          ) : null}
          {view.data.length === 0 ? (
            <Body testID="no-payments">
              No payments yet. When you pay, the payment and its receipt appear here.
            </Body>
          ) : (
            byLandlord(view.data, groups).map((box) => (
              <LandlordBox key={box.key} box={box} units={unitsOf(groups)} />
            ))
          )}
          <Button label="Refresh" variant="quiet" testID="refresh" onPress={payments.reload} />
        </View>
      ) : null}
    </Screen>
  );
}

/** One landlord's payments, in a box of their own (TL-12). */
function LandlordBox({ box, units }: { box: LandlordPayments; units: Map<string, string> }) {
  return (
    <Card testID="landlord-payments" label={`Paid to ${box.name}`}>
      <View>
        <Small>Paid to</Small>
        <Heading>{box.name}</Heading>
      </View>
      {box.payments.map((payment) => (
        <PaymentRow key={payment.id} payment={payment} unitCode={units.get(payment.leaseId)} />
      ))}
    </Card>
  );
}

function PaymentRow({ payment, unitCode }: { payment: Payment; unitCode: string | undefined }) {
  const { expire } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opening = useRef(false);
  const receiptId = payment.receiptId;
  const reversed = payment.status === 'reversed';

  function download() {
    if (!receiptId || opening.current) return;
    opening.current = true;
    setBusy(true);
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited.
    void openFetchedUrl(
      () => api.tenantMoney.receiptDownload({ receiptId }),
      'Opening your receipt…',
    )
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(
          found.status === 404
            ? 'Your receipt is not ready yet. Try again in a minute.'
            : `We could not open your receipt. ${found.message}`,
        );
      })
      .finally(() => {
        opening.current = false;
        setBusy(false);
      });
  }

  return (
    <View style={styles.row} testID="payment-row">
      <View style={styles.rowTop}>
        <Text style={[styles.amount, reversed && styles.struck]}>
          {formatMoney(payment.amountMinor)}
        </Text>
        <Badge label={reversed ? 'Reversed' : 'Received'} tone={reversed ? 'past' : 'ok'} />
      </View>
      <Small>
        {formatDate(payment.receivedOn)} · {paymentMethodLabel(payment.method)}
        {unitCode ? ` · ${unitCode}` : ''}
      </Small>
      {payment.receiptNumber ? (
        <Small testID="receipt-number">Receipt {payment.receiptNumber}</Small>
      ) : (
        <Small>The receipt is being prepared.</Small>
      )}
      {reversed ? (
        <Small>This payment was reversed, so it no longer counts towards your rent.</Small>
      ) : null}
      {receiptId ? (
        <Button
          label="Download the receipt"
          variant="quiet"
          testID="download-receipt"
          busy={busy}
          onPress={download}
        />
      ) : null}
      {problem ? <ErrorText testID="download-error">{problem}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  row: { borderTopWidth: 1, borderTopColor: colours.line, paddingTop: 12, gap: 4 },
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  amount: { fontSize: 17, fontWeight: '700', color: colours.ink },
  struck: { textDecorationLine: 'line-through', color: colours.muted },
});
