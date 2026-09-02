'use client';

import { Alert, List, Text } from '@mantine/core';
import type { Integracao, IntegracaoTipo } from '@delfrance/schemas';
import type { IntegracoesStatus } from '@/lib/data/useIntegracoes';

import type { PushAlvo } from '../push/types';
import { type AcaoCanal, type VereditoCanal, mensagemNaoSuportado } from './suporteCanal';

/**
 * The pre-run half of #1430: before the operator presses the button, say which
 * of the selected produtos' channels will be skipped and WHY.
 *
 * ⚠️ It warns; it never blocks. A selection legitimately spans supported and
 * unsupported channels, and the registries deliberately still emit one row per
 * skipped listing — `registry.test.ts` pins that, because "não suportado" with
 * no channel named is not actionable. Refusing the run would throw away exactly
 * the report the operator came for.
 *
 * Takes `byId` / `status` rather than calling `useIntegracoes` itself, like
 * `ProdutoIntegracoesCell`: the caller already holds the shared
 * `['integracoes']` entry, and a pure component needs no mock to test.
 */

export interface AvisoCanaisNaoSuportadosProps {
  acao: AcaoCanal;
  alvos: readonly PushAlvo[];
  /** The operation's own bound verdict — `suporteEstoqueDoCanal` and friends. */
  veredito: (tipo: IntegracaoTipo) => VereditoCanal;
  byId: ReadonlyMap<string, Integracao>;
  status: IntegracoesStatus;
}

export function AvisoCanaisNaoSuportados({
  acao,
  alvos,
  veredito,
  byId,
  status,
}: AvisoCanaisNaoSuportadosProps) {
  // ⚠️ An empty `byId` means three different things — still loading, the read
  // failed (a user without `PERM.integracao.read` gets `permission-denied`), or
  // the collection really is empty. `useIntegracoes`'s own docstring says to
  // branch on `status` rather than guess, and warning off a failed read would
  // report a permissions problem as a capability one.
  if (status !== 'success') return null;

  const contaIds = [...new Set(alvos.flatMap((a) => [...a.integracoesComProduto]))];
  const avisos = contaIds.flatMap((id) => {
    const conta = byId.get(id);
    // A conta the denorm names but the collection does not hold is the run's
    // own "Integração não encontrada" row, not a capability question.
    if (conta === undefined) return [];
    const v = veredito(conta.tipo);
    if (v.suportado) return [];
    return [{ id, mensagem: mensagemNaoSuportado(v.motivo, acao, conta.nome, conta.tipo) }];
  });

  if (avisos.length === 0) return null;

  return (
    <Alert color="yellow" variant="light" title="Alguns canais serão pulados">
      <List size="sm" spacing={4}>
        {avisos.map((a) => (
          <List.Item key={a.id}>{a.mensagem}</List.Item>
        ))}
      </List>
      <Text size="xs" c="dimmed" mt="xs">
        O envio continua para os demais canais, e o resultado traz uma linha por anúncio.
      </Text>
    </Alert>
  );
}
