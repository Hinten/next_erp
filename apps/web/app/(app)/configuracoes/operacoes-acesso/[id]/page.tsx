'use client';
import { useParams } from 'next/navigation';
import { Stack, Title } from '@mantine/core';
import { AccessOperationPanel } from '@/components/AccessOperationPanel';
export default function AccessOperationPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Stack>
      <Title order={2}>Atualização de acesso</Title>
      <AccessOperationPanel id={id} />
    </Stack>
  );
}
