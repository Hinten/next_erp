'use client';

import { useMemo } from 'react';
import { getDocs, type Firestore } from 'firebase/firestore';
import { skipToken, useQuery } from '@tanstack/react-query';
import { Alert, Button, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { formatReais } from '@delfrance/core/money';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import {
  SHOPEE_MODEL_STATUS,
  recusaEstoqueDoModeloShopeeLegivel,
  recusaPrecoDoModeloShopeeLegivel,
  varLinksDoAnuncio,
  type ProdutoShopeeLink,
  type VarLinkShopeeCru,
} from '@delfrance/schemas';

import { produtoCollection } from '@/lib/data/produtoCollection';
import { variacaoShopeeLinkCollection } from '@/lib/data/variacaoShopeeLinkCollection';
import { formatarInstanteShopee } from '@/lib/shopee/anuncioProduto';
import { EMPTY_VALUE } from '../marketplace/ListingField';
import { numeroFinito, textoPreenchido } from './campos';

/**
 * How many `variashopee` docs are read per variation child. One per listing
 * and conta the child is a model of — a handful — so the bound only stops a
 * corrupt subcollection from turning one click into an unbounded read.
 */
const MAX_MODELOS_POR_FILHO = 50;

export interface ModelosAnuncioShopeeProps {
  db: Firestore;
  produtoId: string;
  linkDocId: string;
  /** The LISTING's doc — its clean-send stamps are what hide a model's stale refusal. */
  anuncio: ProdutoShopeeLink;
  aberto: boolean;
  onAlternar: () => void;
}

/**
 * The listing's MODELS — one row per variation child bound to it — read only
 * once the operator opens "Variações". Collapsed, it reads nothing.
 *
 * ## The reads (root `CLAUDE.md` rule 1: no new query shape)
 *
 *  - the children, through `produtos where paiId == <produto>` — the shape the
 *    edit page already holds live for the whole session, so the SDK serves it
 *    from that watch target;
 *  - each child's `variashopee`, one-shot, BY PATH — never a collection-group
 *    query (`variashopee(produtoShopeeOuterRef)` has no index; on Enterprise
 *    that would full-scan, silently).
 *
 * Which rows belong to THIS listing is `varLinksDoAnuncio` (`@delfrance/schemas`),
 * the fold the stock and price planners attribute models with: two listings
 * under one produto are legal, so a model is matched by its listing ref, never
 * by its produto. When a model's refusal still shows is `shopeeLinkLeitura.ts`'s
 * two model readers, which take the LISTING doc too — hence the `anuncio` prop.
 */
export function ModelosAnuncioShopee({
  db,
  produtoId,
  linkDocId,
  anuncio,
  aberto,
  onAlternar,
}: ModelosAnuncioShopeeProps) {
  return (
    <Stack gap="xs">
      <Group>
        <Button
          type="button"
          variant="subtle"
          size="xs"
          onClick={onAlternar}
          aria-expanded={aberto}
        >
          {aberto ? 'Ocultar variações' : 'Ver variações'}
        </Button>
      </Group>
      {aberto && (
        <TabelaDeModelos db={db} produtoId={produtoId} linkDocId={linkDocId} anuncio={anuncio} />
      )}
    </Stack>
  );
}

/** One child's `variashopee` rows, each with its own doc id beside the raw fields. */
async function lerVarLinksDosFilhos(
  db: Firestore,
  filhoIds: readonly string[],
): Promise<ReadonlyMap<string, VarLinkShopeeCru[]>> {
  const pares = await Promise.all(
    filhoIds.map(async (filhoId) => {
      const snap = await getDocs(
        buildQuery(variacaoShopeeLinkCollection.ref(db, { produtoId: filhoId }), [
          limit(MAX_MODELOS_POR_FILHO),
        ]),
      );
      const varLinks: VarLinkShopeeCru[] = snap.docs.map((d) => ({
        ...(d.data() as Record<string, unknown>),
        varLinkDocId: d.id,
      }));
      return [filhoId, varLinks] as const;
    }),
  );
  return new Map(pares);
}

function TabelaDeModelos({
  db,
  produtoId,
  linkDocId,
  anuncio,
}: Omit<ModelosAnuncioShopeeProps, 'aberto' | 'onAlternar'>) {
  const filhosQuery = useMemo(
    () => buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)]),
    [db, produtoId],
  );
  const filhosSnap = useSnapshot(filhosQuery);
  const filhos = filhosSnap.data;
  const filhoIds = useMemo(() => (filhos ?? []).map((f) => f.id).sort(), [filhos]);

  const varLinksQuery = useQuery({
    // Keyed by the child SET, so a child added while the tab is open re-reads.
    queryKey: ['shopee-modelos', produtoId, filhoIds],
    queryFn: filhos === undefined ? skipToken : () => lerVarLinksDosFilhos(db, filhoIds),
  });

  const linhas = useMemo(() => {
    if (filhos === undefined || varLinksQuery.data === undefined) return null;
    const familia = filhos.map((f) => ({
      produtoId: f.id,
      nome: textoPreenchido(f.data.nome) ?? f.id,
      varLinks: varLinksQuery.data.get(f.id) ?? [],
    }));
    return varLinksDoAnuncio(familia, linkDocId);
  }, [filhos, varLinksQuery.data, linkDocId]);

  const erro = filhosSnap.error ?? (varLinksQuery.isError ? varLinksQuery.error : null);
  if (erro) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar as variações deste anúncio: {erro.message}
      </Alert>
    );
  }
  if (linhas === null) {
    return (
      <Group justify="center" py="xs">
        <Loader size="xs" />
      </Group>
    );
  }
  if (linhas.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid={`shopee-modelos-${linkDocId}`}>
        Nenhuma variação deste produto está vinculada a este anúncio.
      </Text>
    );
  }

  return (
    <Table striped withTableBorder data-testid={`shopee-modelos-${linkDocId}`}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Variação</Table.Th>
          <Table.Th>Modelo na Shopee</Table.Th>
          <Table.Th>Situação</Table.Th>
          <Table.Th>Estoque</Table.Th>
          <Table.Th>Preço</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {linhas.map(({ filho, varLink }, i) => {
          const modelId = numeroFinito(varLink.model_id);
          const ausenteDesde = formatarInstanteShopee(varLink.modeloAusenteEm);
          const precoEnviado = numeroFinito(varLink.precoEnviado);
          return (
            <Table.Tr key={textoPreenchido(varLink.varLinkDocId) ?? `${filho.produtoId}-${i}`}>
              <Table.Td>{filho.nome}</Table.Td>
              <Table.Td>{modelId === null ? EMPTY_VALUE : String(modelId)}</Table.Td>
              <Table.Td>
                {rotuloDoModelo(varLink.model_status)}
                {ausenteDesde !== null && (
                  <Text size="xs" c="orange">
                    ausente da Shopee desde {ausenteDesde}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                {recusaEstoqueDoModeloShopeeLegivel(
                  { estoqueRecusaEm: varLink.estoqueRecusaEm },
                  anuncio,
                ) ? (
                  <Text size="sm" c="red">
                    Recusado{codigoEntreParenteses(varLink.estoqueRecusaCodigo)}
                  </Text>
                ) : (
                  EMPTY_VALUE
                )}
              </Table.Td>
              <Table.Td>
                {recusaPrecoDoModeloShopeeLegivel(
                  { precoRecusaEm: varLink.precoRecusaEm, precoEnviadoEm: varLink.precoEnviadoEm },
                  anuncio,
                ) ? (
                  <Text size="sm" c="red">
                    Recusado{codigoEntreParenteses(varLink.precoRecusaCodigo)}
                  </Text>
                ) : precoEnviado === null ? (
                  EMPTY_VALUE
                ) : (
                  formatReais(precoEnviado)
                )}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

/** Shopee's `model_status`, as the operator reads it; an unknown value is printed raw. */
function rotuloDoModelo(status: unknown): string {
  if (status === SHOPEE_MODEL_STATUS.normal) return 'Disponível';
  if (status === SHOPEE_MODEL_STATUS.unavailable) return 'Indisponível';
  return textoPreenchido(status) ?? EMPTY_VALUE;
}

/** ` (<código>)` — Shopee's `failed_reason` verbatim — or `''`. */
function codigoEntreParenteses(codigo: unknown): string {
  const texto = textoPreenchido(codigo);
  return texto === null ? '' : ` (${texto})`;
}
