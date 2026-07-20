import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { pair } from '../api/client';
import { useSession } from '../context/SessionContext';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onSubmit = async () => {
    setError(null);
    setIsSubmitting(true);
    const result = await pair(username.trim(), setupCode.trim());
    setIsSubmitting(false);

    if (result.success) {
      await signIn({
        sessionToken: result.sessionToken,
        name: result.name,
        department: result.department,
        isAdmin: result.isAdmin
      });
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Set Up This Device</Text>
      <Text style={styles.subtitle}>Enter the username and one-time setup code your admin gave you.</Text>

      <Text style={styles.label}>Username</Text>
      <TextInput
        style={styles.input}
        value={username}
        onChangeText={setUsername}
        autoCapitalize="characters"
        placeholder="EMP001"
      />

      <Text style={styles.label}>Setup Code</Text>
      <TextInput
        style={styles.input}
        value={setupCode}
        onChangeText={setSetupCode}
        keyboardType="number-pad"
        placeholder="123456"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        style={[styles.button, isSubmitting && styles.buttonDisabled]}
        onPress={onSubmit}
        disabled={isSubmitting || !username || !setupCode}
      >
        {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Continue</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#555', marginBottom: 32, textAlign: 'center' },
  label: { fontSize: 14, color: '#555', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    fontSize: 16
  },
  error: { color: '#c0392b', marginBottom: 16, textAlign: 'center' },
  button: { backgroundColor: '#2e7d32', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' }
});
