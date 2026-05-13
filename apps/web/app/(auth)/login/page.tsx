'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithEmailAndPassword } from 'firebase/auth';
import {
  Alert,
  Anchor,
  Button,
  Center,
  Paper,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { getFirebaseAuth } from '@/lib/firebase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      router.replace('/inicio');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao entrar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Center h="100vh" px="md">
      <Paper p="xl" radius="md" shadow="sm" withBorder maw={400} w="100%">
        <Title order={2} mb="lg" ta="center">
          Delfrance
        </Title>
        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="E-mail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
            <PasswordInput
              label="Senha"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={submitting} fullWidth>
              Entrar
            </Button>
            <Anchor href="/recuperar" ta="center" size="sm">
              Esqueci minha senha
            </Anchor>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
