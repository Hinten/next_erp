'use client';

import { useParams } from 'next/navigation';
import { Stack } from '@mantine/core';

import { IntFreteEditPage } from '../../_components/IntFretePages';
import { LOGISTICA_SLICES } from '../../_components/slices';
import { ContaPanel } from '../_components/ContaPanel';

export default function MelhorEnviosEditPage() {
  const params = useParams();
  const id = typeof params.id === 'string' ? params.id : null;

  return (
    <Stack>
      <IntFreteEditPage slice={LOGISTICA_SLICES['melhor-envios']} />
      {id && <ContaPanel intFreteId={id} />}
    </Stack>
  );
}
