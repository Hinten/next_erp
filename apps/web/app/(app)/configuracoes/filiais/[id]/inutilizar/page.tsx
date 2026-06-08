'use client';

/**
 * Per-filial inutilização de numeração screen. Reached from the filiais list
 * action "Inutilizar numeração" (one filial selected), mirroring the old
 * Flutter `filiaisTableView` action → `InutNFeTable(filialUid)`. The filial is
 * fixed by the route param, so the form has no filial selector.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { useDocSnapshot } from '@delfrance/data/hooks';
import type { Filial } from '@delfrance/schemas';

import { RequirePerm } from '@/lib/auth';
import { filialCollection } from '@/lib/data/filialCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

import { InutilizarForm } from './_components/InutilizarForm';

function InutilizarContent() {
  const params = useParams<{ id: string }>();
  const filialId = params.id;
  const db = getFirebaseFirestore();

  const ref = useMemo(() => filialCollection.docRef(db, {}, filialId), [db, filialId]);
  const { data: filialDoc } = useDocSnapshot(ref);
  const filial = filialDoc?.data as Filial | undefined;
  const nome = filial?.fantasia ?? filial?.razaoSocial ?? filialId;

  return (
    <Stack p="md" gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>Inutilizar numeração — {nome}</Title>
          <Text c="dimmed" size="sm">
            Inutiliza uma faixa de números de NF-e desta filial que nunca serão usados (lacunas de
            numeração). A operação é síncrona e definitiva na SEFAZ.
          </Text>
        </Stack>
        <Anchor component={Link} href="/configuracoes/filiais" size="sm">
          ← Voltar às filiais
        </Anchor>
      </Group>

      <InutilizarForm filialId={filialId} />
    </Stack>
  );
}

export default function InutilizarFilialPage() {
  return (
    <RequirePerm bit={PERM.fiscal.read} redirectTo="/inicio">
      <InutilizarContent />
    </RequirePerm>
  );
}
