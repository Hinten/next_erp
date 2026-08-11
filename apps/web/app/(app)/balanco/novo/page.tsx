'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { balancoSchema } from '@delfrance/schemas';
import { ObjectView } from '@delfrance/ui';
import { depositoRefRenderInput } from '@/components/pickers/DepositoPicker';
import { balancoCollection } from '@/lib/data/balancoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';

/**
 * Create a balanço: a name and a depósito, nothing else. The three workflow
 * fields are server-owned and must be absent (or null) on a client create —
 * the generated rules deny the write otherwise — so they are excluded here.
 */
export default function NovoBalancoPage() {
  const router = useRouter();
  const { user } = useAuth();

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Novo balanço</Title>
        <Anchor component={Link} href="/balanco" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={balancoSchema}
        collection={balancoCollection}
        db={getFirebaseFirestore()}
        currentUserUid={user?.uid ?? ''}
        excludedFields={[
          'estado',
          'dataFinalizado',
          'finalizacao',
          'timestamp',
          'ultimaModificacao',
        ]}
        fields={{
          // A raw outerRef renders as a text box asking for
          // `documents/depositos/<id>`; the picker emits that string itself.
          depositoOuterRef: { renderInput: depositoRefRenderInput(true) },
        }}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={(id) => router.replace(`/balanco/${id}`)}
      />
    </Stack>
  );
}
