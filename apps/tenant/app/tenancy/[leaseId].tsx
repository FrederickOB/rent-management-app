import type { TenancyDetailView } from '@rent/contracts';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../src/api';
import {
  formatDate,
  formatMoney,
  leaseStatusLabel,
  leaseStatusTone,
  noticeLabel,
  optionalMoney,
  rentLabel,
  termLabel,
} from '../../src/format';
import { openFetchedUrl } from '../../src/open-url';
import { toProblem } from '../../src/problems';
import { useSession } from '../../src/session';
import {
  BackLink,
  Badge,
  Body,
  Button,
  Card,
  ErrorText,
  Fact,
  Heading,
  Loading,
  Notice,
  Screen,
  Small,
} from '../../src/ui';
import { useLoad, useReloadOnReturn } from '../../src/use-load';

/** Tenancy (TL-01): the lease's terms and status, and the signed copy to download. */
export default function TenancyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ leaseId?: string | string[] }>();
  const leaseId = Array.isArray(params.leaseId) ? params.leaseId[0] : params.leaseId;
  const { me, loading } = useSession();
  const load = useCallback(() => api.tenantApp.tenancy({ leaseId: leaseId ?? '' }), [leaseId]);
  const tenancy = useLoad(load, Boolean(me && leaseId));
  useReloadOnReturn(tenancy.reload);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!loading && !me) return <Redirect href="/sign-in" />;

  const state = tenancy.state;
  const top = <BackLink onPress={back} label="Your tenancies" />;
  // 400: the address holds something that is not a lease id at all.
  const notFound =
    state.status === 'error' && (state.problem.status === 404 || state.problem.status === 400);
  if (!leaseId || notFound) {
    return (
      <Screen title="Tenancy not found" top={top}>
        <Body>We could not find this tenancy. It may have been cancelled by your landlord.</Body>
      </Screen>
    );
  }
  if (state.status === 'loading') {
    return (
      <Screen title="Tenancy" top={top}>
        <Loading label="Loading the tenancy" />
      </Screen>
    );
  }
  if (state.status === 'error') {
    return (
      <Screen title="Tenancy" top={top}>
        <ErrorText>We could not load this tenancy. {state.problem.message}</ErrorText>
        <Button label="Try again" variant="quiet" testID="retry" onPress={tenancy.retry} />
      </Screen>
    );
  }
  return (
    <Screen title={state.data.unitCode} top={top} scroll>
      {state.refreshProblem && state.refreshProblem.status !== 401 ? (
        <Notice testID="refresh-problem">
          We could not update this just now, so it may be out of date.
        </Notice>
      ) : null}
      <Details tenancy={state.data} onToSign={() => router.push('/to-sign')} />
    </Screen>
  );
}

function Details({ tenancy, onToSign }: { tenancy: TenancyDetailView; onToSign: () => void }) {
  return (
    <View style={styles.stack} testID="tenancy-detail">
      <Badge
        label={leaseStatusLabel(tenancy.status)}
        tone={leaseStatusTone(tenancy.status)}
        testID="tenancy-status"
      />
      <View>
        <Heading>{tenancy.propertyName}</Heading>
        {tenancy.address ? <Body>{tenancy.address}</Body> : null}
        <Small testID="landlord-name">Rented from {tenancy.landlord.name}</Small>
      </View>

      <Card label="Lease terms">
        <Heading>Lease terms</Heading>
        <Fact
          label="Dates"
          value={termLabel(tenancy.startDate, tenancy.endDate)}
          testID="fact-dates"
        />
        <Fact
          label="Rent"
          value={rentLabel(tenancy.monthlyRentMinor, tenancy.cycle)}
          testID="fact-rent"
        />
        {tenancy.steps.length > 0 ? (
          <Fact
            label="Rent changes"
            testID="fact-steps"
            value={tenancy.steps.map(
              (step) =>
                `From ${formatDate(step.effectiveFrom)}: ${formatMoney(step.monthlyRentMinor)} a month`,
            )}
          />
        ) : null}
        <Fact label="Deposit" value={optionalMoney(tenancy.depositMinor)} testID="fact-deposit" />
        <Fact
          label="Service charge"
          value={optionalMoney(tenancy.serviceChargeMonthlyMinor, ' a month')}
          testID="fact-service-charge"
        />
        <Fact label="Notice period" value={noticeLabel(tenancy.noticeDays)} testID="fact-notice" />
      </Card>

      <Signing tenancy={tenancy} onToSign={onToSign} />
    </View>
  );
}

/** How the lease was signed, and the signed copy (a scan for a lease signed on paper). */
function Signing({ tenancy, onToSign }: { tenancy: TenancyDetailView; onToSign: () => void }) {
  const { expire } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opening = useRef(false);
  const documentId = tenancy.documentId;

  function download() {
    if (!documentId || opening.current) return;
    opening.current = true;
    setBusy(true);
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited.
    void openFetchedUrl(
      () => api.tenantApp.documentDownload({ documentId }),
      'Opening your signed lease…',
    )
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(
          found.status === 404
            ? 'We could not find the signed copy. Ask your landlord to send it to you.'
            : `We could not open the signed copy. ${found.message}`,
        );
      })
      .finally(() => {
        opening.current = false;
        setBusy(false);
      });
  }

  const waiting = tenancy.status === 'pending_signatures';
  return (
    <Card label="Signing">
      <Heading>Signing</Heading>
      <Body testID="signed-how">
        {waiting
          ? 'This lease is waiting for signatures.'
          : tenancy.signedOnPaper
            ? 'Signed on paper.'
            : 'Signed electronically.'}
      </Body>
      {waiting ? (
        <Button label="See what to sign" variant="quiet" testID="go-to-sign" onPress={onToSign} />
      ) : null}
      {documentId ? (
        <Button
          label="Download the signed lease"
          testID="download-signed"
          busy={busy}
          onPress={download}
        />
      ) : null}
      {problem ? <ErrorText testID="download-error">{problem}</ErrorText> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
});
