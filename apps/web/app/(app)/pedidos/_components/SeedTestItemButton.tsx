'use client';

/**
 * Detail-page button that appends a hardcoded CSOSN-102 test item to
 * `pedido.itens` so the orchestrator has something to emit. Strictly
 * a dev-time convenience for testing the NF-e flow end-to-end.
 *
 * The item carries a pre-stamped `imposto` blob (Simples Nacional,
 * CSOSN 102) plus the orchestrator's required `sku`/`nomeDeVenda`/
 * `precoDeVenda`/`quantidade` fields. CFOP/NCM/unidade come from the
 * imposto, so the operação doesn't need to provide them (per the
 * fallback rule in
 * `apps/nfe/lib/nfe/orchestrator.ts:buildGeneratorInput`).
 */
import { useState } from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { doc, getDoc, updateDoc } from 'firebase/firestore';

import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const TEST_ITEM = {
  produtoUid: null,
  ordem: 1,
  ensureUniqueId: null,
  mktplaceId: null,
  sku: 'TEST-NFE-001',
  gtin: null,
  nomeDeVenda: 'Produto de Teste NF-e',
  precoDeVenda: 100,
  descontoUnitario: 0,
  quantidade: 1,
  custo: null,
  timestamp: null,
  imposto: {
    origem: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '61099000',
    unidade: 'UN',
    configuracaoICMS: { crt: '1', csosn: '102' },
    configuracaoPIS: null,
    configuracaoCOFINS: null,
  },
};

export function SeedTestItemButton({ pedidoId }: { pedidoId: string }) {
  const [loading, setLoading] = useState(false);
  const db = getFirebaseFirestore();

  async function handleSeed() {
    setLoading(true);
    try {
      const ref = doc(db, pedidoCollection.resolvePath({}), pedidoId);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        notifications.show({
          title: 'Pedido não encontrado',
          message: `Pedido ${pedidoId} não existe no Firestore.`,
          color: 'red',
        });
        return;
      }
      const existingItens =
        (snap.data() as { itens?: Record<string, unknown[]> }).itens ?? {};
      const existingIds =
        (snap.data() as { itensIds?: string[] }).itensIds ?? [];
      const key = 'NONE'; // produtoUid bucket for items without a produto bound
      const bucket = Array.isArray(existingItens[key])
        ? (existingItens[key] as unknown[])
        : [];
      const next = {
        itens: { ...existingItens, [key]: [...bucket, TEST_ITEM] },
        itensIds: existingIds.includes(key) ? existingIds : [...existingIds, key],
      };
      await updateDoc(ref, next);
      notifications.show({
        title: 'Item de teste adicionado',
        message: 'Item CSOSN-102 (R$ 100,00) adicionado em pedido.itens.NONE.',
        color: 'teal',
        autoClose: 6000,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      notifications.show({
        title: 'Falha ao adicionar item de teste',
        message: err.message,
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleSeed} loading={loading} variant="default" color="gray">
      + Item de teste (NF-e)
    </Button>
  );
}
