'use client';

import { Alert, List, Stack, Text } from '@mantine/core';
import {
  pularPorRecusaAnterior,
  recusaEstoqueDoAnuncioShopeeLegivel,
  recusaPrecoDoAnuncioShopeeLegivel,
  type ProdutoShopeeLink,
} from '@delfrance/schemas';

import { formatarInstanteShopee } from '@/lib/shopee/anuncioProduto';
import { textoPreenchido } from './campos';

export interface RecusasAnuncioShopeeProps {
  link: ProdutoShopeeLink;
  /** The instant the stock skip set is read against (`pularPorRecusaAnterior` takes it as a parameter). */
  agoraMs: number;
}

/**
 * What was REFUSED on this listing, as the senders stored it: the last failed
 * publish, the stock and the price refusals, a failed scheduled publish, and a
 * fiscal block that was left out.
 *
 * ⚠️ WHEN a stored refusal still shows is never decided here (#1369). It is
 * `shopeeLinkLeitura.ts` in `@delfrance/schemas` — a refusal shows while no
 * success stamp is newer, a tie shows it — the module `apps/shopee` reads the
 * same documents with. The stock refusal ALSO shows while the stock gate's skip
 * set is armed (`pularPorRecusaAnterior`, the gate's own function): that skip is
 * the operative fact even when a late success stamp hid the sentence.
 */
export function RecusasAnuncioShopee({ link, agoraMs }: RecusasAnuncioShopeeProps) {
  const falha = lerFalhaPublicacao(link.falhaPublicacao);
  const estoqueLegivel = recusaEstoqueDoAnuncioShopeeLegivel(link);
  const estoqueSuspenso = pularPorRecusaAnterior(link, agoraMs);
  const prazoEstoque = formatarInstanteShopee(link.estoqueRecusaAte);
  const precoLegivel = recusaPrecoDoAnuncioShopeeLegivel(link);
  const agendamentoFalhouEm = formatarInstanteShopee(link.agendamentoFalhouEm);
  const taxInfoOmitido = textoPreenchido(link.taxInfoOmitido);

  if (
    falha === null &&
    !estoqueLegivel &&
    !estoqueSuspenso &&
    !precoLegivel &&
    agendamentoFalhouEm === null &&
    taxInfoOmitido === null
  ) {
    return null;
  }

  return (
    <Stack gap="xs">
      {falha !== null && (
        <Alert color="red" variant="light" title="A última publicação falhou">
          <Text size="sm">
            {[
              falha.em === null ? null : `Em ${falha.em}`,
              falha.etapa === null ? null : `etapa ${falha.etapa}`,
            ]
              .filter((p): p is string => p !== null)
              .join(', ')}
          </Text>
          {falha.problemas.length > 0 ? (
            <List size="sm" spacing={2}>
              {falha.problemas.map((p, i) => (
                <List.Item key={i}>{p}</List.Item>
              ))}
            </List>
          ) : (
            falha.mensagem !== null && <Text size="sm">{falha.mensagem}</Text>
          )}
        </Alert>
      )}
      {(estoqueLegivel || estoqueSuspenso) && (
        <Alert color="yellow" variant="light" title="Estoque recusado">
          <Text size="sm">
            {sentencaDaRecusa(
              link.estoqueRecusaEm,
              link.estoqueRecusaMensagem,
              link.estoqueRecusaMotivo,
              link.estoqueRecusaCodigo,
            )}
          </Text>
          {estoqueSuspenso && (
            <Text size="sm" mt={4}>
              O envio automático de estoque está suspenso para este anúncio: a Shopee já o recusou
              neste mesmo estado. Ele volta quando o anúncio mudar.
              {prazoEstoque === null ? '' : ` Prazo registrado: ${prazoEstoque}.`}
            </Text>
          )}
        </Alert>
      )}
      {precoLegivel && (
        <Alert color="yellow" variant="light" title="Preço recusado">
          <Text size="sm">
            {sentencaDaRecusa(
              link.precoRecusaEm,
              link.precoRecusaMensagem,
              link.precoRecusaMotivo,
              link.precoRecusaCodigo,
            )}
          </Text>
        </Alert>
      )}
      {agendamentoFalhouEm !== null && (
        <Alert color="orange" variant="light">
          Uma publicação agendada falhou em {agendamentoFalhouEm} — a Shopee não informa o motivo.
        </Alert>
      )}
      {taxInfoOmitido !== null && (
        <Text size="sm" c="dimmed">
          Dados fiscais não enviados na última publicação ({taxInfoOmitido}).
        </Text>
      )}
    </Stack>
  );
}

/**
 * `Em <data>: <mensagem> (código <código>)` — the stored sentence first, the
 * slug when no sentence was stored, and Shopee's code VERBATIM (it is stored
 * unstripped so it can be matched against Shopee's own documentation).
 */
function sentencaDaRecusa(
  em: unknown,
  mensagem: unknown,
  motivo: unknown,
  codigo: unknown,
): string {
  const quando = formatarInstanteShopee(em);
  const texto =
    textoPreenchido(mensagem) ?? textoPreenchido(motivo) ?? 'Recusado sem motivo registrado.';
  const cod = textoPreenchido(codigo);
  return `${quando === null ? '' : `Em ${quando}: `}${texto}${cod === null ? '' : ` (código ${cod})`}`;
}

/** The last failed publish, read field by field from the stored (possibly raw) value. */
function lerFalhaPublicacao(valor: unknown): {
  em: string | null;
  etapa: string | null;
  mensagem: string | null;
  problemas: string[];
} | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  const f = valor as Record<string, unknown>;
  const problemas = Array.isArray(f.problemas)
    ? f.problemas.flatMap((p: unknown) => {
        if (typeof p !== 'object' || p === null) return [];
        const texto = textoPreenchido((p as Record<string, unknown>).mensagem);
        return texto === null ? [] : [texto];
      })
    : [];
  return {
    em: formatarInstanteShopee(f.em),
    etapa: textoPreenchido(f.etapa),
    mensagem: textoPreenchido(f.mensagem),
    problemas,
  };
}
