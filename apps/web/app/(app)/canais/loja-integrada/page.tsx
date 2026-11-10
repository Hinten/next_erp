'use client';

import { useState } from 'react';
import Link from 'next/link';
import { deleteDoc } from 'firebase/firestore';
import { Alert, Badge, Button, Stack, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import {
  INTEGRACAO_TIPO,
  type Integracao,
  integracaoMeta,
  integracaoSchema,
} from '@delfrance/schemas';
import { TableView } from '@delfrance/ui';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { type ContaRef, contaRefFromRow } from '@/lib/marketplace/contaJobs/types';
import type { AlvoResultadoImportacaoLi } from './_components/CartaoImportacaoLi';
import { DialogoImportacaoLi } from './_components/DialogoImportacaoLi';
import { ImportacoesLiPanel } from './_components/ImportacoesLiPanel';
import { ResultadoImportacaoLi } from './_components/ResultadoImportacaoLi';
import { useImportarProdutosLiAction } from './_components/useImportarProdutosLiAction';

/**
 * `/canais/loja-integrada`: the Loja Integrada contas list, and the product
 * import (master plan step 9) — "Importar produtos da loja", started for the
 * selected contas from the action rail, with one progress card per conta under
 * the button (`_components/ImportacoesLiPanel.tsx`), and each ended job's
 * result — its report, its tax-review list and, from a finished Simular,
 * "Importar selecionados" (`_components/ResultadoImportacaoLi.tsx`). Shopee's
 * page is the reference shape.
 *
 * This screen replaced the static `CanalCapsPanel` placeholder once the channel
 * gained a registered conta (master-plan step 2). The panel component itself
 * stays: it is what the channels with no screen yet still render.
 */
export default function CanalLojaIntegradaPage() {
  const db = getFirebaseFirestore();
  // The import's start and cancel are PERM.integracao.write-gated on the
  // backend, its reads PERM.integracao.read; the delete is
  // PERM.integracao.delete-gated by the Firestore rules. `ActionConfig` has no
  // `hidden` flag, so gating means filtering the array (same shape as
  // /canais/shopee). `usePermission` reports `false` while claims resolve, so the
  // button and the rail appear a beat after mount.
  const { allowed: canRead } = usePermission(PERM.integracao.read);
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const { allowed: canDelete } = usePermission(PERM.integracao.delete);
  const importacao = useImportarProdutosLiAction();
  const [selecionadas, setSelecionadas] = useState<readonly ContaRef[]>([]);
  // The ended job whose result is open, or `null`. Set from a card's "Ver resultado".
  const [resultado, setResultado] = useState<AlvoResultadoImportacaoLi | null>(null);

  // The `integracao` collection holds every channel type; this screen is one
  // slice. `integracaoMeta.defaultQuery` declares the `tipo` param + `nome`
  // ordering (and its Firestore index); `queryParams` binds the slice.
  return (
    <>
      {/*
        What THIS screen does, as code — never a claim about what is deployed.
        An operator has no way to tell a channel that is merely quiet from one
        that is not wired up, so the copy says what runs here and what does not.
        The token is validated ONCE, when it is saved — the copy says so, and
        does not call the conta "conectada". The import calls the store, so it
        sits behind the same read switch as every such call: until the migration
        a start answers that the calls are off (`LI_CHAMADAS_DESLIGADAS`), and
        the start's card carries that sentence. The channel sends no NF-e to the
        store, so the copy does not promise it.
      */}
      <Alert color="blue" title="O que esta tela faz hoje" mb="md">
        <Stack gap="xs">
          <Text size="sm">
            Esta tela cadastra a conta da Loja Integrada e guarda o Personal Token de cada conta: o
            token é validado na Loja Integrada no momento em que é salvo, e a tela da conta mostra a
            validade informada, avisando a partir de 30 dias antes do vencimento. A tela da conta
            também guarda o mapeamento do frete (por qual integração de frete sai cada forma de
            envio da loja) e os horários de corte do despacho.
          </Text>
          <Text size="sm">
            Para as contas selecionadas, &ldquo;Importar produtos da loja&rdquo; lê os produtos da
            loja e os vincula aos do ERP. Em &ldquo;Simular&rdquo;, mostra o que seria feito sem
            gravar nada; em &ldquo;Importar&rdquo;, grava. Com &ldquo;Completar&rdquo;, também cria
            no ERP os produtos que faltam e preenche só os campos vazios: nada já preenchido no ERP
            é substituído, e preço e estoque nunca são importados. O andamento de cada conta aparece
            no painel ao lado da lista. Como tudo o que chama a Loja Integrada, a importação só
            funciona depois da migração para este sistema: até lá, iniciar uma importação responde
            que as chamadas à Loja Integrada estão desligadas.
          </Text>
          <Text size="sm">
            Importar pedidos, enviar estoque e enviar preço não estão rodando neste canal, e nada é
            sincronizado automaticamente com a Loja Integrada, em nenhuma direção: a importação de
            produtos só roda quando alguém a inicia aqui.
          </Text>
        </Stack>
      </Alert>

      <TableView<typeof integracaoSchema>
        title="Loja Integrada"
        description="Contas da integração com a Loja Integrada."
        schema={integracaoSchema}
        collection={integracaoCollection}
        db={db}
        meta={integracaoMeta}
        queryParams={{ tipo: INTEGRACAO_TIPO.lojaIntegrada }}
        // Overrides `integracaoMeta.defaultQuery.columns`: the same meta backs
        // every channel list, and this conta has no channel-specific column.
        defaultColumns={['nome', 'ativo', 'padrao']}
        rowHref={(id) => `/canais/loja-integrada/${id}`}
        rowLinkColumn="nome"
        renderNewButton={() => (
          <Button component={Link} href="/canais/loja-integrada/novo">
            Nova conta
          </Button>
        )}
        fields={{
          ativo: {
            renderCell: (value) =>
              value ? (
                <Badge color="green" variant="light">
                  Ativo
                </Badge>
              ) : (
                <Badge color="gray" variant="light">
                  Inativo
                </Badge>
              ),
          },
          padrao: {
            renderCell: (value) =>
              value ? (
                <Badge color="blue" variant="outline">
                  Padrão
                </Badge>
              ) : (
                '—'
              ),
          },
        }}
        selectable
        onSelectionChange={(rows) => setSelecionadas(rows.map(contaRefFromRow))}
        // An import runs for MINUTES and its progress has to stay on screen while
        // the operator keeps working the table — the rail can host it, the top
        // ActionBar cannot (#816). 300px keeps the cards legible.
        actionsPanel={{ width: 300 }}
        // The panel's reads are `.read` routes, so a viewer who may only read
        // still follows the imports (and cannot cancel them); one who may only
        // start still gets the card of the start, its reads answering 403.
        renderActionsPanelExtra={
          canRead || canWrite
            ? ({ collapsed }) => (
                <ImportacoesLiPanel
                  collapsed={collapsed}
                  selecionadas={selecionadas}
                  importacao={importacao.state}
                  podeCancelar={canWrite}
                  onAbrirResultado={setResultado}
                />
              )
            : undefined
        }
        actions={[
          ...(canWrite ? [importacao.action] : []),
          ...(canDelete
            ? [
                {
                  id: 'delete',
                  label: 'Excluir',
                  color: 'red' as const,
                  requiresSelection: true,
                  // One conta at a time: deleting a conta drops its channel
                  // credential, and a multi-row confirm names none of the
                  // accounts it is about to take down.
                  maxSelection: 1,
                  refreshOnComplete: true,
                  confirm: {
                    title: 'Excluir conta Loja Integrada',
                    message:
                      'Excluir a conta remove a configuração e a credencial do canal. Confirmar exclusão?',
                  },
                  run: async (rows: Array<{ id: string; data: Integracao }>) => {
                    await Promise.all(
                      rows.map((r) => deleteDoc(integracaoCollection.docRef(db, {}, r.id))),
                    );
                  },
                },
              ]
            : []),
        ]}
      />

      {/* Portalled — its position in the tree is irrelevant, but it must stay
          mounted unconditionally: the action opens it. */}
      <DialogoImportacaoLi state={importacao.state} />
      {/* Same: opened from a card in the rail. "Importar selecionados" starts
          through the action's own state, so only a writer gets it. */}
      <ResultadoImportacaoLi
        alvo={resultado}
        onClose={() => setResultado(null)}
        importacao={canWrite ? importacao.state : null}
      />
    </>
  );
}
