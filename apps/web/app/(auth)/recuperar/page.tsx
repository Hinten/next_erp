'use client';

import { useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import {
  Alert,
  Anchor,
  Button,
  Center,
  Paper,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { getFirebaseAuth } from '@/lib/firebase/client';

export default function RecoverPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Center h="100vh" px="md">
      <Paper p="xl" radius="md" shadow="sm" withBorder maw={400} w="100%">
        <Title order={2} mb="lg" ta="center">
          Recuperar acesso
        </Title>
        {sent ? (
          <Alert color="green">
            Se este e-mail estiver cadastrado, enviaremos um link para redefinir a senha.
          </Alert>
        ) : (
          <form onSubmit={handleSubmit}>
            <Stack>
              <TextInput
                label="E-mail"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
              />
              {error && <Alert color="red">{error}</Alert>}
              <Button type="submit" loading={submitting} fullWidth>
                Enviar link
              </Button>
              <Anchor href="/login" ta="center" size="sm">
                Voltar ao login
              </Anchor>
            </Stack>
          </form>
        )}
      </Paper>
    </Center>
  );
}
