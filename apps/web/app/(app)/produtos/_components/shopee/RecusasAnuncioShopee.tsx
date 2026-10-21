'use client';

import { Alert, List, Stack, Text } from '@mantine/core';
import {
  mecanismosDaRecusaAnterior,
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
 * set is armed (`mecanismosDaRecusaAnterior`, the two halves of the gate's own
 * `pularPorRecusaAnterior`): that skip is the operative fact even when a late
 * success stamp hid the sentence, and WHICH half is armed decides what the
 * notice promises (`fraseDaSuspensao`).
 */
export function RecusasAnuncioShopee({ link, agoraMs }: RecusasAnuncioShopeeProps) {
  const falha = lerFalhaPublicacao(link.falhaPublicacao);
  const estoqueLegivel = recusaEstoqueDoAnuncioShopeeLegivel(link);
  const suspensao = mecanismosDaRecusaAnterior(link, agoraMs);
  const estoqueSuspenso = suspensao.tempo || suspensao.estado;
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
              {fraseDaSuspensao(suspensao, link.estoqueRecusaAte)}
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
 * Why the stock sender skips this listing, worded by WHICH of the gate's two
 * mechanisms is armed (`mecanismosDaRecusaAnterior` — never re-derived here):
 *
 * - TIME only — it lifts at the deadline, whatever the listing does meanwhile;
 *   "it comes back when the listing changes" would be false.
 * - STATE only — it lifts when the listing's reading moves. No deadline is
 *   printed: one that is absent or already past is not what holds it.
 * - both — a promotion refusal records the fingerprint beside its deadline, so
 *   after the deadline the STATE half still holds until the reading moves.
 */
function fraseDaSuspensao(
  { tempo, estado }: { readonly tempo: boolean; readonly estado: boolean },
  ate: unknown,
): string {
  const prazo = formatarInstanteShopee(ate);
  const ateOPrazo = prazo === null ? 'até o prazo registrado' : `até ${prazo}`;
  if (tempo && estado) {
    return (
      `O envio automático de estoque está suspenso para este anúncio ${ateOPrazo}; ` +
      'depois disso, como a Shopee já o recusou neste mesmo estado, só volta quando o anúncio mudar.'
    );
  }
  if (tempo) return `O envio automático de estoque está suspenso para este anúncio ${ateOPrazo}.`;
  return (
    'O envio automático de estoque está suspenso para este anúncio: a Shopee já o recusou ' +
    'neste mesmo estado. Ele volta quando o anúncio mudar.'
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
