import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colours = {
  ink: '#111827',
  muted: '#4B5563',
  line: '#D1D5DB',
  brand: '#0F766E',
  brandInk: '#FFFFFF',
  danger: '#B91C1C',
  surface: '#FFFFFF',
  page: '#F9FAFB',
};

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.body}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.text}>{children}</Text>;
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colours.muted}
        style={styles.input}
        {...input}
      />
    </View>
  );
}

export function Button({
  label,
  onPress,
  busy,
  testID,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  testID?: string;
  variant?: 'primary' | 'quiet';
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: Boolean(busy), disabled: Boolean(busy) }}
      disabled={busy}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.quiet,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colours.brandInk : colours.brand} />
      ) : (
        <Text style={primary ? styles.primaryText : styles.quietText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" testID="error" style={styles.error}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colours.page },
  body: { flex: 1, padding: 20, gap: 16, maxWidth: 480, width: '100%', alignSelf: 'center' },
  title: { fontSize: 26, fontWeight: '700', color: colours.ink, marginTop: 12 },
  text: { fontSize: 16, lineHeight: 24, color: colours.muted },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600', color: colours.ink },
  input: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    color: colours.ink,
    backgroundColor: colours.surface,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 50,
    justifyContent: 'center',
  },
  primary: { backgroundColor: colours.brand },
  quiet: { backgroundColor: 'transparent' },
  pressed: { opacity: 0.85 },
  primaryText: { color: colours.brandInk, fontSize: 17, fontWeight: '600' },
  quietText: { color: colours.brand, fontSize: 16, fontWeight: '600' },
  error: { color: colours.danger, fontSize: 15 },
});
