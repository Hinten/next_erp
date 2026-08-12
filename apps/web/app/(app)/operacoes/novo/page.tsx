'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Anchor, Group, Stack, Title } from '@mantine/core';
import { addDoc, getDocs } from 'firebase/firestore';
import { type FieldConfig, ObjectView } from '@delfrance/ui';
import { nowMillis } from '@delfrance/core/datetime';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { regraImpostoCollection } from '@/lib/data/regraImpostoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useAuth } from '@/lib/auth';
import { MacrosTab } from '../_components/MacrosTab';
import {
  OPERACAO_EXCLUDED_FIELDS,
  OPERACAO_SECTIONS,
  OPERACAO_TRANSIENT_FIELDS,
  operacaoPageSchema,
  operacaoStaticFields,
} from '../_components/operacaoFields';

export default function NovaOperacaoPage() {
  const router = useRouter();
  const { user } = useAuth();
  const db = getFirebaseFirestore();
  // When duplicating, copy the source's regras subcollection too (the
  // ObjectView copy mode only clones the operação doc).
  const copyFromId = useSearchParams().get('copyFrom');

  const fields = useMemo<Record<string, FieldConfig>>(
    () => ({
      ...operacaoStaticFields,
      macros: {
        section: 'Regras de imposto',
        label: 'Regras de imposto',
        renderInput: (p) => <MacrosTab disabled={p.disabled} />,
      },
    }),
    [],
  );

  async function copyMacros(sourceId: string, targetId: string) {
    const src = await getDocs(regraImpostoCollection.ref(db, { operacaoId: sourceId }));
    await Promise.all(
      src.docs.map((d) => {
        const { id: _id, dataCadastro: _dc, ...data } = d.data();
        return addDoc(regraImpostoCollection.ref(db, { operacaoId: targetId }), {
          ...data,
          dataCadastro: nowMillis(),
        } as never);
      }),
    );
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={2}>Nova operação fiscal</Title>
        <Anchor component={Link} href="/operacoes" size="sm">
          Cancelar
        </Anchor>
      </Group>

      <ObjectView
        schema={operacaoPageSchema}
        collection={operacaoCollection}
        db={db}
        currentUserUid={user?.uid ?? ''}
        sections={[...OPERACAO_SECTIONS]}
        fields={fields}
        excludedFields={OPERACAO_EXCLUDED_FIELDS}
        transientFields={OPERACAO_TRANSIENT_FIELDS}
        defaultValues={{
          tipo: 1,
          ehServico: false,
          ehExterior: false,
          ehConsumidorFinal: false,
          ehFiscal: true,
          padrao: false,
          ativo: true,
          movimentaEstoque: true,
          movimentaIndisponivelEstoque: true,
          indPres: '2',
          indIntermed: '1',
        }}
        saveLabel="Criar"
        showSaveAndContinue={false}
        onSaved={async (id) => {
          if (copyFromId) await copyMacros(copyFromId, id);
          router.replace(`/operacoes/${id}`);
        }}
      />
    </Stack>
  );
}
