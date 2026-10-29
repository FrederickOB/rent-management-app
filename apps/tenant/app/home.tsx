import type { TenancyGroupView, TenantSigningView } from '@rent/contracts';
import { Redirect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../src/api';
import { leasesAre, leaseStatusLabel, leaseStatusTone, rentLabel, termLabel } from '../src/format';
import { useSession } from '../src/session';
import {
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
import { useLoad, useReloadOnReturn, type LoadState } from '../src/use-load';

type Tenancy = TenancyGroupView['tenancies'][number];

const loadTenancies = () => api.tenantApp.tenancies();
const loadSigning = () => api.tenantApp.signing();

/**
 * Home (TL-01): the tenant's tenancies, grouped by landlord, and what is waiting for their
 * signature (TL-07). Each landlord's tenancies stay in a box of their own (TL-12): the screen never
 * merges or compares one landlord's records with another's. Balance, paid-until and next due
 * arrive with the ledger (M4a).
 */
export default function Home() {
  const router = useRouter();
  const { me, loading } = useSession();
  const tenancies = useLoad(loadTenancies, Boolean(me));
  const signing = useLoad(loadSigning, Boolean(me));
  const { reload: reloadTenancies } = tenancies;
  const { reload: reloadSigning } = signing;
  useReloadOnReturn(
    useCallback(() => {
      reloadTenancies();
      reloadSigning();
    }, [reloadTenancies, reloadSigning]),
  );

  if (!loading && !me) return <Redirect href="/sign-in" />;
  return (
    <Screen title={me ? `Hello, ${me.name}` : 'Hello'} scroll>
      <ToSignEntry state={signing.state} onOpen={() => router.push('/to-sign')} />
      <Tenancies
        state={tenancies.state}
        onRetry={tenancies.retry}
        onOpen={(leaseId) => router.push(`/tenancy/${leaseId}`)}
      />
      <Button
        label="Profile and devices"
        variant="quiet"
        testID="open-profile"
        onPress={() => router.push('/profile')}
      />
    </Screen>
  );
}

/** Leases out for the tenant's signature, or waiting on the others once the tenant has signed. */
function ToSignEntry({
  state,
  onOpen,
}: {
  state: LoadState<TenantSigningView[]>;
  onOpen: () => void;
}) {
  // Nothing to say until it is known; a failure is said quietly, under the tenancies' own state.
  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return state.problem.status === 401 ? null : (
      <Small testID="to-sign-error">
        We could not check for leases to sign. {state.problem.message}
      </Small>
    );
  }
  const items = state.data;
  if (items.length === 0) return null;
  const waiting = items.filter((i) => i.status === 'pending' && i.signer.status === 'pending');
  return (
    <Card testID="to-sign-entry" label="To sign" highlight={waiting.length > 0}>
      <Heading>To sign</Heading>
      <Body>
        {waiting.length > 0
          ? `${leasesAre(waiting.length)} waiting for your signature.`
          : 'You have signed. We are waiting for the others to sign.'}
      </Body>
      <Button
        label={waiting.length > 0 ? 'Review and sign' : 'See who has signed'}
        variant={waiting.length > 0 ? 'primary' : 'quiet'}
        testID="open-to-sign"
        onPress={onOpen}
      />
    </Card>
  );
}

function Tenancies({
  state,
  onRetry,
  onOpen,
}: {
  state: LoadState<TenancyGroupView[]>;
  onRetry: () => void;
  onOpen: (leaseId: string) => void;
}) {
  if (state.status === 'loading') return <Loading label="Loading your tenancies" />;
  if (state.status === 'error') {
    return (
      <View style={styles.stack}>
        <ErrorText>We could not load your tenancies. {state.problem.message}</ErrorText>
        <Button label="Try again" variant="quiet" testID="retry" onPress={onRetry} />
      </View>
    );
  }
  const groups = state.data;
  return (
    <View style={styles.stack}>
      {state.refreshProblem && state.refreshProblem.status !== 401 ? (
        <Notice testID="refresh-problem">
          We could not update this just now, so it may be out of date.{' '}
          {state.refreshProblem.message}
        </Notice>
      ) : null}
      {groups.length === 0 ? (
        <Body testID="no-tenancies">
          You have no tenancies yet. When your landlord adds your tenancy, it will appear here.
        </Body>
      ) : (
        groups.map((group) => (
          <LandlordGroup key={group.landlord.companyId} group={group} onOpen={onOpen} />
        ))
      )}
    </View>
  );
}

/** One landlord's tenancies, in a box of their own (TL-12). */
function LandlordGroup({
  group,
  onOpen,
}: {
  group: TenancyGroupView;
  onOpen: (leaseId: string) => void;
}) {
  return (
    <Card testID="landlord-group" label={`Rented from ${group.landlord.name}`}>
      <View>
        <Small>Rented from</Small>
        <Heading>{group.landlord.name}</Heading>
      </View>
      {group.tenancies.map((tenancy) => (
        <TenancyRow key={tenancy.leaseId} tenancy={tenancy} onOpen={onOpen} />
      ))}
    </Card>
  );
}

function TenancyRow({ tenancy, onOpen }: { tenancy: Tenancy; onOpen: (leaseId: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the lease terms"
      testID="tenancy-card"
      onPress={() => onOpen(tenancy.leaseId)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.unit}>{tenancy.unitCode}</Text>
        <Badge label={leaseStatusLabel(tenancy.status)} tone={leaseStatusTone(tenancy.status)} />
      </View>
      <Text style={styles.property}>{tenancy.propertyName}</Text>
      <Small>{rentLabel(tenancy.monthlyRentMinor, tenancy.cycle)}</Small>
      <Small>{termLabel(tenancy.startDate, tenancy.endDate)}</Small>
      <Text style={styles.more}>See the lease ›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  row: {
    borderTopWidth: 1,
    borderTopColor: colours.line,
    paddingTop: 12,
    gap: 4,
  },
  pressed: { opacity: 0.7 },
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  unit: { fontSize: 17, fontWeight: '700', color: colours.ink },
  property: { fontSize: 16, color: colours.ink },
  more: { fontSize: 15, fontWeight: '600', color: colours.brand, marginTop: 4 },
});
