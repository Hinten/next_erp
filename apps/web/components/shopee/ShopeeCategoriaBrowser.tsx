'use client';

import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Breadcrumbs,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';

import { useShopeeClient, type ShopeeClient } from '@/lib/shopee/client';
import {
  CODIGO_FALHA_SHOPEE,
  MENSAGEM_CATEGORIA_DESCONHECIDA,
  codigoDaFalhaShopee,
  descreverFalhaShopee,
  shopeeQueryRetry,
} from '@/lib/shopee/erros';
import type { CategoriaResumoDto, RespostaCategoriasShopee } from '@/lib/shopee/wire';

/**
 * A drill-down over ONE Shopee conta's category tree, through the backend's
 * `taxonomia/categorias` route — the first Shopee category UI in this app,
 * written to be reused (step 21's produto tab, #1432): it knows nothing about
 * size charts.
 *
 * - **Leaf-only pick.** Only an `isLeaf` row offers "Escolher"; a non-leaf row
 *   drills in. The backend decides `isLeaf` with its one leaf gate — this file
 *   never re-derives it from `children`.
 * - **A drill-down, not a tree.** The route answers the ROOTS, or ONE node with
 *   its ancestors (`pathFromRoot`, the breadcrumb) and its direct children; the
 *   whole tree never crosses the wire.
 * - **No text filter.** A filter is a fold (case, accents) and would have to be
 *   inventoried as one (root `CLAUDE.md`, #1372); a level is short.
 * - `categoriaInicial` opens the browser where an existing pick lives: a LEAF
 *   opens on its parent's level (so its siblings are the alternatives), a legacy
 *   non-leaf on its own children. One the tree no longer holds (404
 *   `SHOPEE_CATEGORIA_DESCONHECIDA`) opens the roots with a note saying so.
 *
 * Reads only; writes nothing. Retries follow `shopeeQueryRetry` — never a 502,
 * which is how a Shopee rate limit reaches the browser.
 */
export interface ShopeeCategoriaBrowserProps {
  integracaoId: string;
  /** Where to open (an existing pick's category). `null` → the roots. */
  categoriaInicial: number | null;
  /** Fires ONLY for a leaf row (`isLeaf === true`). */
  onEscolher: (categoria: CategoriaResumoDto) => void;
  /** Nothing is clickable — no drilling, no breadcrumb, no "Escolher". */
  disabled?: boolean;
}

/** The backend caches the tree for 15 min (`taxonomia/cache.ts`); asking sooner learns nothing new. */
export const CATEGORIAS_SHOPEE_STALE_MS = 15 * 60_000;

/** `['shopee','categorias',integracaoId,categoryId|null]` — shared with every other reader of one level. */
export function chaveCategoriasShopee(
  integracaoId: string,
  categoryId: number | null,
): readonly unknown[] {
  return ['shopee', 'categorias', integracaoId, categoryId];
}

/**
 * One level of the tree (the roots for `null`), cached under
 * {@link chaveCategoriasShopee}. Exported so a card that only needs ONE
 * category's path and leaf flag reads the same cache entry the browser filled.
 */
export function useCategoriasShopee(
  integracaoId: string,
  categoryId: number | null,
  opcoes: { enabled?: boolean } = {},
): UseQueryResult<RespostaCategoriasShopee, unknown> {
  const client = useShopeeClient();
  return useQuery({
    queryKey: chaveCategoriasShopee(integracaoId, categoryId),
    queryFn: () => lerCategorias(client, integracaoId, categoryId),
    enabled: client !== null && (opcoes.enabled ?? true),
    staleTime: CATEGORIAS_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });
}

function lerCategorias(
  client: ShopeeClient | null,
  integracaoId: string,
  categoryId: number | null,
): Promise<RespostaCategoriasShopee> {
  // `enabled` keeps a null client from ever reaching here; this is the type's due.
  if (client === null) throw new Error('cliente da Shopee indisponível');
  return client.categorias({ integracaoId, categoryId });
}

/** The ONE label of a category row: display name, else the original name, else its id. */
export function rotuloCategoriaShopee(categoria: {
  readonly categoryId: number;
  readonly name: string | null;
  readonly originalName: string | null;
}): string {
  return categoria.name ?? categoria.originalName ?? `Categoria ${String(categoria.categoryId)}`;
}

function ehCategoriaDesconhecida(err: unknown): boolean {
  return codigoDaFalhaShopee(err) === CODIGO_FALHA_SHOPEE.categoriaDesconhecida;
}

const FALHA_CATEGORIAS = 'Não foi possível carregar as categorias da Shopee.';

/**
 * Where the browser opens, derived from the initial node's answer. `undefined`
 * while that answer is still unknown; `{ foco: null }` is the roots.
 */
function focoDaCategoriaInicial(
  categoriaInicial: number | null,
  inicial: UseQueryResult<RespostaCategoriasShopee, unknown>,
): { foco: number | null; desconhecida: boolean } | undefined {
  if (categoriaInicial === null) return { foco: null, desconhecida: false };
  if (inicial.isError) {
    return ehCategoriaDesconhecida(inicial.error) ? { foco: null, desconhecida: true } : undefined;
  }
  const no = inicial.data?.no;
  if (no === undefined) return undefined;
  if (no === null) return { foco: null, desconhecida: false };
  if (!no.isLeaf) return { foco: no.categoryId, desconhecida: false };
  // `parentId` 0 marks a root: a root leaf opens on the roots themselves.
  return { foco: no.parentId === 0 ? null : no.parentId, desconhecida: false };
}

function ErroComRetentativa({
  err,
  onTentar,
  extra,
}: {
  err: unknown;
  onTentar: () => void;
  extra?: ReactNode;
}) {
  const { mensagem, repetivel } = descreverFalhaShopee(err, { desconhecido: FALHA_CATEGORIAS });
  return (
    <Alert color="red" variant="light" title="Categorias da Shopee">
      <Stack gap="xs">
        <Text size="sm">{mensagem}</Text>
        <Group gap="xs">
          {repetivel && (
            <Button size="xs" variant="light" onClick={onTentar}>
              Tentar de novo
            </Button>
          )}
          {extra}
        </Group>
      </Stack>
    </Alert>
  );
}

export function ShopeeCategoriaBrowser({
  integracaoId,
  categoriaInicial,
  onEscolher,
  disabled = false,
}: ShopeeCategoriaBrowserProps) {
  // `undefined` until the operator navigates; from then on THEIR focus wins
  // over the one derived from `categoriaInicial`.
  const [focoEscolhido, setFocoEscolhido] = useState<{ id: number | null } | undefined>(undefined);

  const inicial = useCategoriasShopee(integracaoId, categoriaInicial, {
    enabled: categoriaInicial !== null && focoEscolhido === undefined,
  });
  const derivado = focoDaCategoriaInicial(categoriaInicial, inicial);
  const foco = focoEscolhido !== undefined ? focoEscolhido.id : derivado?.foco;
  const nivel = useCategoriasShopee(integracaoId, foco ?? null, { enabled: foco !== undefined });

  const irPara = (id: number | null) => setFocoEscolhido({ id });

  let corpo: ReactNode;
  if (foco === undefined) {
    corpo = inicial.isError ? (
      <ErroComRetentativa
        err={inicial.error}
        onTentar={() => void inicial.refetch()}
        extra={
          <Button size="xs" variant="subtle" onClick={() => irPara(null)} disabled={disabled}>
            Começar pelas categorias principais
          </Button>
        }
      />
    ) : (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  } else if (nivel.isError) {
    corpo = (
      <ErroComRetentativa
        err={nivel.error}
        onTentar={() => void nivel.refetch()}
        extra={
          foco === null ? undefined : (
            <Button size="xs" variant="subtle" onClick={() => irPara(null)} disabled={disabled}>
              Voltar às categorias principais
            </Button>
          )
        }
      />
    );
  } else if (nivel.data === undefined) {
    corpo = (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  } else {
    const no = nivel.data.no;
    const linhas = (foco === null ? nivel.data.raizes : no?.children) ?? [];
    corpo = (
      <Stack gap="xs">
        <Breadcrumbs separator="›" data-testid="shopee-categoria-caminho">
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => irPara(null)}
            disabled={disabled || foco === null}
          >
            Categorias
          </Anchor>
          {(foco === null || no === null ? [] : no.pathFromRoot).map((passo, i, caminho) =>
            i === caminho.length - 1 ? (
              <Text key={passo.categoryId} size="sm" fw={600}>
                {rotuloCategoriaShopee(passo)}
              </Text>
            ) : (
              <Anchor
                key={passo.categoryId}
                component="button"
                type="button"
                size="sm"
                onClick={() => irPara(passo.categoryId)}
                disabled={disabled}
              >
                {rotuloCategoriaShopee(passo)}
              </Anchor>
            ),
          )}
        </Breadcrumbs>
        {linhas.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nenhuma subcategoria neste nível.
          </Text>
        ) : (
          <Stack gap={4}>
            {linhas.map((c) => (
              <Group
                key={c.categoryId}
                justify="space-between"
                wrap="nowrap"
                gap="xs"
                data-testid={`shopee-categoria-linha-${String(c.categoryId)}`}
              >
                {c.isLeaf ? (
                  <>
                    <Text size="sm">{rotuloCategoriaShopee(c)}</Text>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => onEscolher(c)}
                      disabled={disabled}
                    >
                      Escolher
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="subtle"
                    rightSection={<IconChevronRight size={14} />}
                    onClick={() => irPara(c.categoryId)}
                    disabled={disabled}
                  >
                    {rotuloCategoriaShopee(c)}
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <Paper withBorder p="sm" data-testid="shopee-categoria-browser">
      <Stack gap="xs">
        {focoEscolhido === undefined && derivado?.desconhecida === true && (
          <Alert color="yellow" variant="light" data-testid="shopee-categoria-desconhecida">
            {MENSAGEM_CATEGORIA_DESCONHECIDA}
          </Alert>
        )}
        {corpo}
      </Stack>
    </Paper>
  );
}
