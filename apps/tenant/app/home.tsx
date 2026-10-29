import { Redirect, useRouter } from 'expo-router';
import { useSession } from '../src/session';
import { Body, Button, Screen } from '../src/ui';

/** Home. Balance, paid-until and next due arrive with the ledger (M4a). */
export default function Home() {
  const router = useRouter();
  const { me, loading } = useSession();
  if (!loading && !me) return <Redirect href="/sign-in" />;
  return (
    <Screen title={me ? `Hello, ${me.name}` : 'Hello'}>
      <Body>
        Your landlord has not added your tenancy yet. When they do, your balance and receipts will
        appear here.
      </Body>
      <Button
        label="Profile and devices"
        variant="quiet"
        testID="open-profile"
        onPress={() => router.push('/profile')}
      />
    </Screen>
  );
}
