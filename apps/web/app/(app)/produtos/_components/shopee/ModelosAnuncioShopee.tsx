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
 * How many `variashopee` docs are read per variation child before the tab says
 * it stopped. A child holds one row per listing of the PARENT it is a model of,
 * across EVERY conta (the editor itself reads up to 200 listings), plus the rows
 * a recriar leaves behind — so this sits well above any real family and only
 * fences a corrupt subcollection off from turning one click into an unbounded
 * read. Reaching it is SAID (`shopee-modelos-truncado-*`), never read as "no
 * linked variation".
 *
 * ⚠️ The rows are filtered by listing only AFTER the read (no index exists for a
 * `produtoShopeeOuterRef` filter, and none is added — root `CLAUDE.md` rule 1),
 * so a bound smaller than the subcollection hides THIS listing's rows behind
 * other listings' ones. It was 50 and did exactly that (#1951 review).
 *
 * ONE read of `MAX + 1` rows, not cursor pages: Enterprise has no key index on
 * `variashopee`, and a document-key range is not index-bounded there — every
 * `startAfter` page re-scans the whole subcollection (measured on `arquivos`,
 * #1874), so paging would multiply the scan this single read pays once. It is
 * also how `apps/shopee`'s `lerLinksDeVariacao` reads the same subcollection:
 * whole, filtered in memory.
 */
export const MAX_MODELOS_POR_FILHO = 500;

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
 *    that would full-scan, silently) — bounded by {@link MAX_MODELOS_POR_FILHO},
 *    and a read that reaches the bound says so.
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

interface VarLinksDosFilhos {
  /** Each child's `variashopee` rows, each with its own doc id beside the raw fields. */
  readonly porFilho: ReadonlyMap<string, VarLinkShopeeCru[]>;
  /** The children whose read reached {@link MAX_MODELOS_POR_FILHO}: their rows may be incomplete. */
  readonly truncados: ReadonlySet<string>;
}

async function lerVarLinksDosFilhos(
  db: Firestore,
  filhoIds: readonly string[],
): Promise<VarLinksDosFilhos> {
  const lidos = await Promise.all(
    filhoIds.map(async (filhoId) => {
      // `+ 1`: the one row past the bound is what tells "exactly the bound"
      // from "more than it". It is real, so it is kept like any other.
      const snap = await getDocs(
        buildQuery(variacaoShopeeLinkCollection.ref(db, { produtoId: filhoId }), [
          limit(MAX_MODELOS_POR_FILHO + 1),
        ]),
      );
      const varLinks: VarLinkShopeeCru[] = snap.docs.map((d) => ({
        ...(d.data() as Record<string, unknown>),
        varLinkDocId: d.id,
      }));
      return { filhoId, varLinks, truncado: snap.docs.length > MAX_MODELOS_POR_FILHO };
    }),
  );
  return {
    porFilho: new Map(lidos.map((l) => [l.filhoId, l.varLinks])),
    truncados: new Set(lidos.filter((l) => l.truncado).map((l) => l.filhoId)),
  };
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

  const leitura = useMemo(() => {
    if (filhos === undefined || varLinksQuery.data === undefined) return null;
    const { porFilho, truncados } = varLinksQuery.data;
    const familia = filhos.map((f) => ({
      produtoId: f.id,
      nome: textoPreenchido(f.data.nome) ?? f.id,
      varLinks: porFilho.get(f.id) ?? [],
    }));
    return {
      linhas: varLinksDoAnuncio(familia, linkDocId),
      truncados: familia.filter((f) => truncados.has(f.produtoId)).map((f) => f.nome),
    };
  }, [filhos, varLinksQuery.data, linkDocId]);

  const erro = filhosSnap.error ?? (varLinksQuery.isError ? varLinksQuery.error : null);
  if (erro) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar as variações deste anúncio: {erro.message}
      </Alert>
    );
  }
  if (leitura === null) {
    return (
      <Group justify="center" py="xs">
        <Loader size="xs" />
      </Group>
    );
  }
  const { linhas, truncados } = leitura;
  // A read that stopped at the bound may have left THIS listing's rows unread:
  // say so, and never answer "no linked variation" from an incomplete read.
  const avisoTruncado = truncados.length > 0 && (
    <Alert color="yellow" variant="light" data-testid={`shopee-modelos-truncado-${linkDocId}`}>
      Há mais de {MAX_MODELOS_POR_FILHO} registros de modelos em: {truncados.join(', ')} — a leitura
      parou aí. A lista pode estar incompleta: pode haver variações vinculadas a este anúncio que
      não aparecem aqui.
    </Alert>
  );
  if (linhas.length === 0) {
    return (
      <Stack gap="xs">
        {avisoTruncado}
        <Text size="sm" c="dimmed" data-testid={`shopee-modelos-${linkDocId}`}>
          {truncados.length > 0
            ? 'Nenhuma das variações lidas está vinculada a este anúncio.'
            : 'Nenhuma variação deste produto está vinculada a este anúncio.'}
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="xs">
      {avisoTruncado}
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
                    {
                      precoRecusaEm: varLink.precoRecusaEm,
                      precoEnviadoEm: varLink.precoEnviadoEm,
                    },
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
    </Stack>
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
