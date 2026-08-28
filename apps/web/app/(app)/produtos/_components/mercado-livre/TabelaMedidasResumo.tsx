'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Group, Stack, Table, Text } from '@mantine/core';
import { mlSizeChartsForConta } from '@delfrance/schemas';

import { catalogDomainOf } from '@/lib/mercado-livre/categoriaTree';
import { useMercadoLivreClient } from '@/lib/mercado-livre/client';
import { mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import {
  GUIA_ATRIBUTOS,
  type GuiaAtributoId,
  type Verdito,
  avaliarTabela,
  avisoDominioTabela,
} from '@/lib/mercado-livre/tabelaMedidasBinding';

/** Matches `CategoriaField` — ML catalog metadata changes on the order of months. */
const METADATA_STALE_MS = 30 * 60 * 1000;

const ROTULO: Record<GuiaAtributoId, string> = { BRAND: 'Marca', GENDER: 'Gênero' };

export interface TabelaMedidasResumoProps {
  integracaoId: string;
  /** The listing's `category_id` — null on a draft that has none yet. */
  categoryId: string | null;
  /** The tabela's `nome`; null while the tabMedi doc is still loading. */
  nomeDaTabela: string | null;
  /** The raw `tabelasDeMedidasMercadoLivre` map off the tabMedi doc. */
  chartsMap: Record<string, unknown> | null;
  /** The anúncio's own stored attributes — the other side of every comparison. */
  linkAttributes: readonly { id?: string; value_id?: string | null; value_name?: string | null }[];
}

/**
 * The produto's tabela de medidas, guia by guia, next to what this anúncio asks
 * for.
 *
 * ⚠️ **The three columns are not decoration — they are exactly what decides the
 * binding** (#1087). `domain_id` vs the category's `catalog_domain` is a hard
 * filter, and `BRAND`/`GENDER` are the attributes the server's scoring loop
 * counts hits over. Before this, none of the three was visible anywhere on the
 * tab: a publish whose tabela sat in `MLB-SHIRTS` while the category asked for
 * `MLB-T_SHIRTS` went out with no `SIZE_GRID_ID` and Mercado Livre answered
 * `Attribute [SIZE_GRID_ID] is missing`, naming neither domain.
 *
 * ⚠️ **Costs no request.** Both queries reuse the EXACT keys `CategoriaField`
 * and `ListingForm` already fetch under, so on a rendered listing they are cache
 * hits. Changing either key here silently doubles the ML metadata traffic.
 *
 * ⚠️ It explains; it never gates. Publish refuses the mismatch itself, before
 * any ML call, so a wrong ✓ here cannot let a bad payload out.
 */
export function TabelaMedidasResumo({
  integracaoId,
  categoryId,
  nomeDaTabela,
  chartsMap,
  linkAttributes,
}: TabelaMedidasResumoProps) {
  const client = useMercadoLivreClient();

  // Same key as CategoriaField's `pathQuery` — a cache hit, not a second call.
  const categoriaQuery = useQuery({
    queryKey: ['ml', 'categorias', integracaoId, categoryId],
    enabled: categoryId != null && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categorias({ integracaoId, categoryId }),
    retry: mercadoLivreQueryRetry,
  });

  // Same key as ListingForm's attribute grid (`['ml','atributos',…]`), for the
  // same reason — this listing's form has already fetched it.
  const atributosQuery = useQuery({
    queryKey: ['ml', 'atributos', integracaoId, categoryId],
    enabled: categoryId != null && client != null,
    staleTime: METADATA_STALE_MS,
    queryFn: () => client!.categoriaAtributos({ integracaoId, categoryId: categoryId! }),
    retry: mercadoLivreQueryRetry,
  });

  const charts = useMemo(
    () => mlSizeChartsForConta(chartsMap ?? null, integracaoId),
    [chartsMap, integracaoId],
  );

  const catalogDomain = catalogDomainOf(categoriaQuery.data?.node ?? null);
  const avaliacao = useMemo(
    () => avaliarTabela(charts, catalogDomain, linkAttributes),
    [charts, catalogDomain, linkAttributes],
  );

  /**
   * ⚠️ `null` while the attributes are in flight, never `false`. Guessing
   * `false` early would silence the warning on exactly the categories that need
   * it.
   *
   * ⚠️ Matched on the **id**, not on `motivo`. The server's
   * `categoriaUsaGuiaDeTamanhos` tests `value_type === 'grid_id'` — the ITEM
   * half alone — while the `tabela-de-medidas` omission covers
   * `SIZE_CHART_VALUE_TYPES = ['grid_id', 'grid_row_id']`, so a category
   * carrying only the VARIATION half would warn here and publish silently. The
   * two definitions have to name the same attribute; keep them in step.
   */
  const categoriaUsaGuia: boolean | null = atributosQuery.data
    ? atributosQuery.data.omitidos.some((o) => o.id === 'SIZE_GRID_ID')
    : null;

  const aviso = avisoDominioTabela({ nomeDaTabela, avaliacao, categoriaUsaGuia, categoryId });

  if (charts.length === 0) {
    return (
      <Alert color="yellow" variant="light" data-testid="ml-tabela-medidas-resumo">
        A tabela de medidas {nomeDaTabela ? `"${nomeDaTabela}" ` : ''}não tem nenhuma guia nesta
        conta do Mercado Livre. Crie a guia em Medidas › Mercado Livre.
      </Alert>
    );
  }

  return (
    <Stack gap="xs" data-testid="ml-tabela-medidas-resumo">
      <Text size="xs" c="dimmed">
        Tabela de medidas{nomeDaTabela ? ` — ${nomeDaTabela}` : ''}
      </Text>
      {aviso != null && (
        <Alert color="yellow" variant="light" data-testid="ml-tabela-medidas-aviso">
          {aviso}
        </Alert>
      )}
      <Table withTableBorder withColumnBorders striped="odd" fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Guia</Table.Th>
            <Table.Th>Domínio</Table.Th>
            {GUIA_ATRIBUTOS.map((id) => (
              <Table.Th key={id}>{ROTULO[id]}</Table.Th>
            ))}
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {avaliacao.guias.map((guia, index) => (
            <Table.Tr key={guia.chartId ?? `rascunho-${String(index)}`}>
              <Table.Td>{guia.nome ?? '—'}</Table.Td>
              <Table.Td>
                <Celula verdito={guia.dominioOk} valor={guia.dominio} />
              </Table.Td>
              {GUIA_ATRIBUTOS.map((id) => (
                <Table.Td key={id}>
                  <Celula verdito={guia.veredito[id]} valor={guia.valores[id]} />
                </Table.Td>
              ))}
              <Table.Td>
                {!guia.enviada ? (
                  <Badge size="xs" color="gray" variant="light">
                    nunca enviada
                  </Badge>
                ) : guia.vincula ? (
                  <Badge size="xs" color="green" variant="light">
                    vincula
                  </Badge>
                ) : (
                  <Badge size="xs" color="gray" variant="light">
                    não vincula
                  </Badge>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {/* The other side of every comparison above, so the operator never has to
          hold the anúncio's values in their head while reading the table. */}
      <Text size="xs" c="dimmed" data-testid="ml-tabela-medidas-anuncio">
        Este anúncio: domínio {avaliacao.anuncio.dominio ?? '—'}
        {GUIA_ATRIBUTOS.map(
          (id) => ` · ${ROTULO[id].toLowerCase()} ${avaliacao.anuncio.valores[id] ?? '—'}`,
        ).join('')}
      </Text>
    </Stack>
  );
}

/**
 * One value with its verdict.
 *
 * ⚠️ `null` renders as neither ✓ nor ✗ — an attribute missing on either side
 * cannot score, so claiming a verdict about it would be the guess this panel
 * exists to remove.
 */
function Celula({ verdito, valor }: { verdito: Verdito; valor: string | null }) {
  return (
    <Group gap={4} wrap="nowrap">
      {verdito === true && <Text c="green">✓</Text>}
      {verdito === false && <Text c="red">✗</Text>}
      <Text c={verdito === false ? 'red' : undefined}>{valor ?? '—'}</Text>
    </Group>
  );
}
