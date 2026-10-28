'use client';

import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import {
  textoUtilizavelShopee,
  type RecomendacaoDto,
  type RespostaRecomendacaoCategoriaShopee,
} from '@delfrance/schemas';

import {
  CATEGORIAS_SHOPEE_STALE_MS,
  ShopeeCategoriaBrowser,
  rotuloCategoriaShopee,
  useCategoriasShopee,
} from '@/components/shopee/ShopeeCategoriaBrowser';
import { FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE } from '@/lib/shopee/anuncioProduto';
import { useShopeeClient, type ShopeeClient } from '@/lib/shopee/client';
import {
  CODIGO_FALHA_SHOPEE,
  MENSAGEM_CATEGORIA_DESCONHECIDA,
  codigoDaFalhaShopee,
  descreverFalhaShopee,
  shopeeQueryRetry,
} from '@/lib/shopee/erros';
import type { RespostaCategoriasShopee } from '@/lib/shopee/wire';

export interface CategoriaRascunhoShopeeProps {
  /** The conta (`integracao` id) whose tree every read is (`useCategoriasShopee`, `recomendacaoCategoria`, `ShopeeCategoriaBrowser`); supplied by `RascunhoShopee`. */
  contaId: string;
  /** The draft's link doc id — the test ids' suffix only; supplied by `RascunhoShopee`. */
  linkDocId: string;
  /** The category the form holds (`bloco.valores.category_id`); `null` = none chosen — the label then makes NO request (rev. 2a B.7 (b)). */
  categoryId: number | null;
  /** The form's current title (`bloco.valores.item_name`) — the Shopee suggestions' `nome`; blank or `null` ⇒ no suggestions section and no request. */
  titulo: string | null;
  /** The picker opens (`bloco.categoriaEditavel` — never while the reading is `incerta`); `false` ⇒ the path label alone. */
  editavel: boolean;
  /** The held projection stores attributes (`bloco.atributosGravados`) — the modal says `FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE` before a pick. */
  atributosGravados: boolean;
  /** A LEAF was picked (a browser row, or a suggestion with `isLeaf === true`); `RascunhoShopee` forwards it as `onCampo('category_id', categoryId)`. */
  onEscolher: (categoryId: number) => void;
}

/** The modal's title (DC §2.10). */
export const TITULO_ESCOLHA_CATEGORIA_SHOPEE = 'Categoria na Shopee';

/** No category on the draft yet — its pendência says what to do. */
export const FRASE_SEM_CATEGORIA_RASCUNHO_SHOPEE = 'Nenhuma categoria escolhida.';

/** A held category the tree has but which is not a leaf: the publish refuses it. */
export const FRASE_CATEGORIA_NAO_FOLHA_SHOPEE = 'não é uma categoria final — escolha outra';

/** The suggestions need a title (the route's `nome`). */
export const FRASE_SUGESTOES_SEM_TITULO_SHOPEE =
  'Escreva o título do anúncio para ver as sugestões da Shopee.';

/** Shopee suggested nothing for the title. */
export const FRASE_SEM_SUGESTOES_SHOPEE =
  'A Shopee não sugeriu nenhuma categoria para este título.';

/** The route's `applied: false`, said to the operator: a suggestion is a list to pick from. */
export const FRASE_SUGESTOES_NUNCA_APLICADAS_SHOPEE = 'Sugestões nunca são aplicadas sozinhas.';

/** A suggestion that is not a leaf of this conta's tree cannot be picked. */
export const FRASE_SUGESTAO_NAO_FOLHA_SHOPEE = 'Não é uma categoria final';

/** A suggested id this conta's tree does not hold (`isLeaf: null`) cannot be picked. */
export const FRASE_SUGESTAO_FORA_DA_ARVORE_SHOPEE = 'Não existe na árvore desta conta';

/** How many suggested ids the conta's tree lacks (`unresolved`). */
export function fraseDasSugestoesForaDaArvoreShopee(n: number): string {
  return `${String(n)} sugestão(ões) não existem na árvore desta conta.`;
}

/**
 * `['shopee','recomendacao',integracaoId,nome]` (DC §2.10) — one cache entry
 * per conta and title, kept as long as the tree's (`CATEGORIAS_SHOPEE_STALE_MS`).
 */
export function chaveRecomendacaoCategoriaShopee(
  integracaoId: string,
  nome: string,
): readonly unknown[] {
  return ['shopee', 'recomendacao', integracaoId, nome];
}

function lerRecomendacao(
  client: ShopeeClient | null,
  integracaoId: string,
  nome: string,
): Promise<RespostaRecomendacaoCategoriaShopee> {
  // `enabled` keeps a null client from ever reaching here; this is the type's due.
  if (client === null) throw new Error('cliente da Shopee indisponível');
  return client.recomendacaoCategoria({ integracaoId, nome });
}

/** A suggestion's label: the conta tree's path (root › … › leaf), else its own name, else its id. */
function rotuloDaSugestao(r: RecomendacaoDto): string {
  if (r.pathFromRoot.length > 0) return r.pathFromRoot.map(rotuloCategoriaShopee).join(' › ');
  return rotuloCategoriaShopee({ categoryId: r.categoryId, name: r.name, originalName: null });
}

/**
 * The held category's label: the conta tree's path (root › … › leaf), its id,
 * and what is wrong with it — not a leaf, or gone from the tree. Until the tree
 * answers, a spinner beside the id.
 */
function RotuloDaCategoria({
  categoryId,
  consulta,
  testId,
}: {
  categoryId: number;
  consulta: UseQueryResult<RespostaCategoriasShopee, unknown>;
  testId: string;
}) {
  const id = (
    <Text span size="xs" c="dimmed">
      {`#${String(categoryId)}`}
    </Text>
  );
  const no = consulta.data?.no ?? null;
  if (no !== null) {
    const caminho =
      no.pathFromRoot.length > 0
        ? no.pathFromRoot.map(rotuloCategoriaShopee).join(' › ')
        : rotuloCategoriaShopee(no);
    return (
      <Group gap="xs" data-testid={testId}>
        <Text size="sm">{caminho}</Text>
        {id}
        {!no.isLeaf && (
          <Badge color="orange" variant="light">
            {FRASE_CATEGORIA_NAO_FOLHA_SHOPEE}
          </Badge>
        )}
      </Group>
    );
  }
  if (consulta.isError) {
    const mensagem =
      codigoDaFalhaShopee(consulta.error) === CODIGO_FALHA_SHOPEE.categoriaDesconhecida
        ? MENSAGEM_CATEGORIA_DESCONHECIDA
        : descreverFalhaShopee(consulta.error, {
            desconhecido: 'Não foi possível carregar a categoria da Shopee.',
          }).mensagem;
    return (
      <Group gap="xs" data-testid={testId}>
        <Text size="sm" c="red">
          {mensagem}
        </Text>
        {id}
      </Group>
    );
  }
  return (
    <Group gap="xs" data-testid={testId}>
      {consulta.data === undefined && <Loader size="xs" />}
      <Text size="sm">{`Categoria ${String(categoryId)}`}</Text>
    </Group>
  );
}

/** Shopee's suggestions for the title — offered, never applied; only leaves are pickable. */
function SugestoesDaCategoria({
  contaId,
  titulo,
  onEscolher,
}: {
  contaId: string;
  titulo: string | null;
  onEscolher: (categoryId: number) => void;
}) {
  const client = useShopeeClient();
  // The trimmed title the publisher would read — `null` when blank: no request.
  const nome = textoUtilizavelShopee(titulo);
  const consulta = useQuery({
    queryKey: chaveRecomendacaoCategoriaShopee(contaId, nome ?? ''),
    queryFn: () => lerRecomendacao(client, contaId, nome ?? ''),
    enabled: client !== null && nome !== null,
    staleTime: CATEGORIAS_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });

  let corpo: ReactNode;
  if (nome === null) {
    corpo = (
      <Text size="sm" c="dimmed">
        {FRASE_SUGESTOES_SEM_TITULO_SHOPEE}
      </Text>
    );
  } else if (consulta.isError) {
    const { mensagem, repetivel } = descreverFalhaShopee(consulta.error, {
      desconhecido: 'Não foi possível obter as sugestões da Shopee.',
    });
    corpo = (
      <Alert color="red" variant="light">
        <Stack gap="xs">
          <Text size="sm">{mensagem}</Text>
          {repetivel && (
            <Button
              type="button"
              size="xs"
              variant="light"
              w="fit-content"
              onClick={() => void consulta.refetch()}
            >
              Tentar de novo
            </Button>
          )}
        </Stack>
      </Alert>
    );
  } else if (consulta.data === undefined) {
    corpo = <Loader size="xs" />;
  } else {
    const { recomendacoes, unresolved } = consulta.data;
    corpo = (
      <Stack gap={4}>
        {recomendacoes.length === 0 && (
          <Text size="sm" c="dimmed">
            {FRASE_SEM_SUGESTOES_SHOPEE}
          </Text>
        )}
        {recomendacoes.map((r) => (
          <Group
            key={`${String(r.position)}-${String(r.categoryId)}`}
            justify="space-between"
            wrap="nowrap"
            gap="xs"
            data-testid={`shopee-rascunho-sugestao-${String(r.position)}`}
          >
            <Text size="sm">{rotuloDaSugestao(r)}</Text>
            {r.isLeaf === true ? (
              <Button
                type="button"
                size="xs"
                variant="light"
                onClick={() => onEscolher(r.categoryId)}
              >
                Usar esta
              </Button>
            ) : (
              <Text size="xs" c="dimmed">
                {r.isLeaf === false
                  ? FRASE_SUGESTAO_NAO_FOLHA_SHOPEE
                  : FRASE_SUGESTAO_FORA_DA_ARVORE_SHOPEE}
              </Text>
            )}
          </Group>
        ))}
        {unresolved > 0 && (
          <Text size="xs" c="dimmed">
            {fraseDasSugestoesForaDaArvoreShopee(unresolved)}
          </Text>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="xs" data-testid="shopee-rascunho-sugestoes">
      <Text size="sm" fw={500}>
        Sugestões da Shopee para o título
      </Text>
      {corpo}
      <Text size="xs" c="dimmed">
        {FRASE_SUGESTOES_NUNCA_APLICADAS_SHOPEE}
      </Text>
    </Stack>
  );
}

/**
 * The draft's Categoria (#1911 P10, DC §2.10): the path label of the held
 * category (`useCategoriasShopee` + `rotuloCategoriaShopee`) and the "Escolher
 * categoria" modal — Shopee's suggestions for the title (`recomendacaoCategoria`,
 * requested only once the modal is open; never applied on their own) above
 * `ShopeeCategoriaBrowser` opened at `categoryId`. Only leaves are pickable.
 *
 * The two reads are this component's own (DC assigns them here); it writes
 * nothing. Root `data-testid="shopee-rascunho-categoria-<linkDocId>"`.
 *
 * - **No category, no request** (rev. 2a B.7 (b)): the label reads the tree
 *   only for a held id, so a draft without one renders with zero apps/shopee
 *   calls — what keeps the seeded e2e draft stub-free.
 * - **Leaves only.** A suggestion is pickable exactly when Shopee's answer,
 *   resolved against THIS conta's tree, says `isLeaf: true` — whatever the
 *   suggestions' order means (undocumented). A `null` (not in the tree) or
 *   `false` row says why it is not.
 * - **Not editable ⇒ no modal at all** — and one already open closes, so no
 *   pick can land while the reading is `incerta` or the block is busy.
 */
export function CategoriaRascunhoShopee({
  contaId,
  linkDocId,
  categoryId,
  titulo,
  editavel,
  atributosGravados,
  onEscolher,
}: CategoriaRascunhoShopeeProps) {
  const [aberto, setAberto] = useState(false);
  const atual = useCategoriasShopee(contaId, categoryId, { enabled: categoryId !== null });
  const raiz = `shopee-rascunho-categoria-${linkDocId}`;
  // ONE decision for the modal AND its body: the body (and its suggestions
  // request) never depends on Mantine's unmount-on-close default.
  const modalAberto = aberto && editavel;

  const escolher = (id: number) => {
    setAberto(false);
    onEscolher(id);
  };

  return (
    <Stack gap={4} data-testid={raiz}>
      <Text size="sm" fw={500}>
        Categoria
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        {categoryId === null ? (
          <Text size="sm" c="dimmed" data-testid={`${raiz}-rotulo`}>
            {FRASE_SEM_CATEGORIA_RASCUNHO_SHOPEE}
          </Text>
        ) : (
          <RotuloDaCategoria categoryId={categoryId} consulta={atual} testId={`${raiz}-rotulo`} />
        )}
        {editavel && (
          <Button type="button" size="xs" variant="light" onClick={() => setAberto(true)}>
            {categoryId === null ? 'Escolher categoria' : 'Trocar categoria'}
          </Button>
        )}
      </Group>
      <Modal
        opened={modalAberto}
        onClose={() => setAberto(false)}
        title={TITULO_ESCOLHA_CATEGORIA_SHOPEE}
        size="lg"
        centered
      >
        {modalAberto && (
          <Stack gap="md" data-testid={`${raiz}-modal`}>
            {atributosGravados && (
              <Alert color="yellow" variant="light">
                {FRASE_TROCA_DE_CATEGORIA_APAGA_ATRIBUTOS_SHOPEE}
              </Alert>
            )}
            <SugestoesDaCategoria contaId={contaId} titulo={titulo} onEscolher={escolher} />
            <ShopeeCategoriaBrowser
              integracaoId={contaId}
              categoriaInicial={categoryId}
              onEscolher={(c) => escolher(c.categoryId)}
            />
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
