'use client';

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Alert, Button, Group, Loader, Modal, Radio, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { entradaTabelaShopeeSchema, type EntradaTabelaShopee } from '@delfrance/schemas';

import {
  CATEGORIAS_SHOPEE_STALE_MS,
  ShopeeCategoriaBrowser,
  rotuloCategoriaShopee,
} from '@/components/shopee/ShopeeCategoriaBrowser';
import { useShopeeClient, type ShopeeClient } from '@/lib/shopee/client';
import { descreverFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import {
  indiceAtivoDaCategoria,
  type LinhaTabelaShopeeForm,
} from '@/lib/shopee/tabelasMedidasForm';
import type {
  CategoriaResumoDto,
  DetalheTabelaMedidasDto,
  ListaTabelasMedidasDto,
  RespostaLimitesShopee,
} from '@/lib/shopee/wire';

import { TabelaShopeeGrid } from './TabelaShopeeGrid';

/**
 * Pick ONE Shopee size-chart template for one conta: category (leaf only) →
 * that category's templates → confirm. The modal STORES nothing — it hands the
 * new entry to `onConfirmar`, and the tab stages it in the tabela's own form
 * (saved by "Salvar alterações", reconcile L6).
 *
 * - The entry is the corpus shape `{ categoryId, size_chart_id, name }`, and
 *   ⚠️ `name` is the CATEGORY's label, never the chart's (legacy
 *   `medidasCadastro.dart`). It is built through the strict write schema: a
 *   parse failure is OUR bug and is loud.
 * - `size_chart_limit` is ADVICE (L7): "não aceita modelo", "obrigatória" and a
 *   failed limites read are shown, and none of them disables the confirm.
 * - The list is the backend's UNCACHED walk (one Shopee detail read per
 *   template), so it is never refetched on focus; "Recarregar lista" is the
 *   explicit "I just created it in Seller Centre" path.
 * - "Substituir a tabela desta categoria" vs "Adicionar", and the warning
 *   that a "Trocar" lands on a category ANOTHER row already covers, are
 *   decided by `indiceAtivoDaCategoria` (`lib/shopee/tabelasMedidasForm.ts`):
 *   THE selector (`indiceDaEntradaShopee`, `@delfrance/schemas`) over the rows
 *   that survive the save, the same filter the tab's roles and the
 *   replace-on-add target use — never a local copy of either (#1369).
 * - An empty list says "crie no Seller Centre" only when the backend proved it
 *   complete and hid nothing, and never for a category that takes no template.
 */
export interface EscolherTabelaShopeeModalProps {
  integracaoId: string;
  contaNome: string;
  alvo: { tipo: 'adicionar' } | { tipo: 'trocar'; indice: number; categoriaAtual: number | null };
  /** This conta's rows as the FORM holds them (marks included). */
  linhas: readonly LinhaTabelaShopeeForm[];
  onConfirmar: (entrada: EntradaTabelaShopee) => void;
  onFechar: () => void;
}

/** A template list costs 1 + N Shopee reads; a minute is long enough to browse back and forth. */
export const TABELAS_SHOPEE_STALE_MS = 60_000;

/** `['shopee','tabela-medidas','lista',integracaoId,categoryId]`. */
export function chaveListaTabelasShopee(
  integracaoId: string,
  categoryId: number,
): readonly unknown[] {
  return ['shopee', 'tabela-medidas', 'lista', integracaoId, categoryId];
}

/** `['shopee','tabela-medidas','detalhe',integracaoId,sizeChartId]` — shared with the tab's cards. */
export function chaveDetalheTabelaShopee(
  integracaoId: string,
  sizeChartId: number,
): readonly unknown[] {
  return ['shopee', 'tabela-medidas', 'detalhe', integracaoId, sizeChartId];
}

/** `['shopee','limites',integracaoId,categoryId]`. */
export function chaveLimitesShopee(integracaoId: string, categoryId: number): readonly unknown[] {
  return ['shopee', 'limites', integracaoId, categoryId];
}

function exigirCliente(client: ShopeeClient | null): ShopeeClient {
  // Every query below is `enabled` only with a client; this is the type's due.
  if (client === null) throw new Error('cliente da Shopee indisponível');
  return client;
}

/**
 * One template's projected chart, cached under {@link chaveDetalheTabelaShopee}.
 * Exported so the tab's cards read the SAME cache entry (name, stale id, "Ver
 * tabela") the modal filled.
 */
export function useDetalheTabelaShopee(
  integracaoId: string,
  sizeChartId: number,
  opcoes: { enabled?: boolean } = {},
): UseQueryResult<DetalheTabelaMedidasDto, unknown> {
  const client = useShopeeClient();
  return useQuery({
    queryKey: chaveDetalheTabelaShopee(integracaoId, sizeChartId),
    queryFn: () => exigirCliente(client).tabelaMedidasDetalhe({ integracaoId, sizeChartId }),
    enabled: client !== null && (opcoes.enabled ?? true),
    staleTime: TABELAS_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });
}

/**
 * One template drawn read-only: loading, the failure in operator words (a
 * template the shop no longer has reads "não existe mais na loja — escolha
 * outra"), or {@link TabelaShopeeGrid} over the backend's projection.
 */
export function TabelaShopeeDetalhe({
  integracaoId,
  sizeChartId,
}: {
  integracaoId: string;
  sizeChartId: number;
}) {
  const detalhe = useDetalheTabelaShopee(integracaoId, sizeChartId);
  if (detalhe.isError) {
    const { mensagem, repetivel } = descreverFalhaShopee(detalhe.error, {
      desconhecido: 'Não foi possível ler esta tabela da Shopee.',
    });
    return (
      <Alert color="red" variant="light" data-testid="shopee-tabela-detalhe-erro">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm">{mensagem}</Text>
          {repetivel && (
            <Button size="xs" variant="light" onClick={() => void detalhe.refetch()}>
              Tentar de novo
            </Button>
          )}
        </Group>
      </Alert>
    );
  }
  if (detalhe.data === undefined) {
    return (
      <Group justify="center" p="xs">
        <Loader size="sm" />
      </Group>
    );
  }
  return <TabelaShopeeGrid tabela={detalhe.data.tabela} />;
}

/** The L7 advice lines. Each is three-valued upstream: only an explicit value speaks. */
function AvisosDeLimites({ limites }: { limites: UseQueryResult<RespostaLimitesShopee, unknown> }) {
  if (limites.isError) {
    return (
      <Text size="sm" c="dimmed" data-testid="shopee-tabela-limites-falha">
        Não foi possível ler as regras de tabela desta categoria.
      </Text>
    );
  }
  const limite = limites.data?.limites.sizeChartLimit ?? null;
  if (limite === null) return null;
  const naoAceita = limite.supportTemplateSizeChart === false;
  const obrigatoria = limite.sizeChartMandatory === true;
  if (!naoAceita && !obrigatoria) return null;
  return (
    <Stack gap={4} data-testid="shopee-tabela-limites">
      {naoAceita && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="sm">A Shopee informa que esta categoria não aceita modelo de tabela.</Text>
        </Alert>
      )}
      {obrigatoria && (
        <Alert color="blue" variant="light" p="xs">
          <Text size="sm">Tabela obrigatória nesta categoria (segundo a Shopee).</Text>
        </Alert>
      )}
    </Stack>
  );
}

function rotuloDoModelo(t: ListaTabelasMedidasDto['tabelas'][number]): string {
  return (
    `${t.sizeChartName ?? 'Sem nome'} #${String(t.sizeChartId)}` +
    (t.legivel ? '' : ' (detalhe ilegível)')
  );
}

/**
 * The empty-list sentence. "Crie no Seller Centre" is offered only when the
 * backend PROVED the list complete and hid nothing (`truncado: false`,
 * `idsIlegiveis: 0`) — otherwise the operator would author a duplicate of a
 * template Shopee already has — and never for a category Shopee says takes no
 * template (`supportTemplateSizeChart === false`): there is nothing to create.
 */
function textoDaListaVazia(
  lista: ListaTabelasMedidasDto,
  suportaModelo: boolean | null | undefined,
): string {
  if (lista.truncado || lista.idsIlegiveis > 0) {
    return 'Nenhum modelo desta categoria pôde ser listado aqui.';
  }
  if (suportaModelo === false) {
    return 'Nenhum modelo nesta categoria — a Shopee informa que ela não aceita modelo de tabela.';
  }
  return (
    'Nenhum modelo nesta categoria — crie no Seller Centre e recarregue.' +
    (suportaModelo === true ? '' : ' (ou a loja não tem acesso a modelos)')
  );
}

/**
 * What the backend's walk could NOT show (`listarTabelasMedidas`: "counted,
 * never dropped in silence"): a walk that stopped before proving the list
 * complete, and rows whose id Shopee sent unreadable. Shown whether or not a
 * template is left on screen — an empty list with either is NOT "this
 * category has no template".
 */
function NotasDaLista({ lista, mostradas }: { lista: ListaTabelasMedidasDto; mostradas: number }) {
  return (
    <>
      {lista.truncado && (
        <Text size="sm" c="dimmed" data-testid="shopee-tabela-lista-truncada">
          {mostradas > 0
            ? `Mostrando os primeiros ${String(mostradas)} modelos.`
            : 'A lista da Shopee veio incompleta — pode haver modelos que não aparecem aqui.'}
        </Text>
      )}
      {lista.idsIlegiveis > 0 && (
        <Text size="sm" c="dimmed" data-testid="shopee-tabela-lista-ids-ilegiveis">
          {`${String(lista.idsIlegiveis)} modelo(s) da lista da Shopee vieram sem um id legível e não aparecem aqui.`}
        </Text>
      )}
    </>
  );
}

interface EtapaModelosProps {
  integracaoId: string;
  categoria: CategoriaResumoDto;
  alvo: EscolherTabelaShopeeModalProps['alvo'];
  linhas: readonly LinhaTabelaShopeeForm[];
  onConfirmar: (entrada: EntradaTabelaShopee) => void;
  onFechar: () => void;
  onTrocarCategoria: () => void;
}

/** Step 2 — the templates of one leaf. Remounted per category, so nothing leaks between two. */
function EtapaModelos({
  integracaoId,
  categoria,
  alvo,
  linhas,
  onConfirmar,
  onFechar,
  onTrocarCategoria,
}: EtapaModelosProps) {
  const client = useShopeeClient();
  const queryClient = useQueryClient();
  const { categoryId } = categoria;
  const [escolhido, setEscolhido] = useState<number | null>(null);
  const [aberto, setAberto] = useState<number | null>(null);

  const lista = useQuery({
    queryKey: chaveListaTabelasShopee(integracaoId, categoryId),
    queryFn: () => exigirCliente(client).tabelaMedidasLista({ integracaoId, categoryId }),
    enabled: client !== null,
    staleTime: TABELAS_SHOPEE_STALE_MS,
    refetchOnWindowFocus: false,
    retry: shopeeQueryRetry,
  });
  // Separate on purpose: its failure is one muted line, never a blocked pick.
  const limites = useQuery({
    queryKey: chaveLimitesShopee(integracaoId, categoryId),
    queryFn: () => exigirCliente(client).limites({ integracaoId, categoryId }),
    enabled: client !== null,
    staleTime: CATEGORIAS_SHOPEE_STALE_MS,
    retry: shopeeQueryRetry,
  });

  const recarregar = () =>
    void queryClient.invalidateQueries({
      queryKey: chaveListaTabelasShopee(integracaoId, categoryId),
    });

  const tabelas = lista.data?.leaf === true ? lista.data.tabelas : [];
  // Only a template IN the list on screen can be confirmed: a reload that drops
  // the one selected must not leave a stale id behind the radio.
  const modelo = tabelas.find((t) => t.sizeChartId === escolhido);
  const ativa = indiceAtivoDaCategoria(linhas, categoryId);
  // A "Trocar" replaces ITS row; if ANOTHER surviving row already covers this
  // category, the conta ends with two and the selector keeps the earlier one —
  // said before the confirm, never only by the badge after it.
  const outra =
    alvo.tipo === 'trocar'
      ? indiceAtivoDaCategoria(linhas, categoryId, { exceto: alvo.indice })
      : -1;
  const rotuloConfirmar =
    alvo.tipo === 'trocar'
      ? 'Trocar'
      : ativa === -1
        ? 'Adicionar'
        : 'Substituir a tabela desta categoria';
  const suportaModelo = limites.data?.limites.sizeChartLimit?.supportTemplateSizeChart;

  const confirmar = () => {
    if (modelo === undefined) return;
    onConfirmar(
      entradaTabelaShopeeSchema.parse({
        categoryId,
        size_chart_id: modelo.sizeChartId,
        name: rotuloCategoriaShopee(categoria),
      }),
    );
  };

  let corpo: ReactNode;
  if (lista.isError) {
    const { mensagem } = descreverFalhaShopee(lista.error, {
      desconhecido: 'Não foi possível ler os modelos de tabela desta categoria.',
    });
    corpo = (
      <Alert color="red" variant="light" data-testid="shopee-tabela-lista-erro">
        <Text size="sm">{mensagem}</Text>
      </Alert>
    );
  } else if (lista.data === undefined) {
    corpo = (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  } else if (!lista.data.leaf) {
    corpo = (
      <Alert color="yellow" variant="light">
        <Text size="sm">
          A Shopee informa que esta categoria tem subcategorias — volte e escolha uma delas.
        </Text>
      </Alert>
    );
  } else if (tabelas.length === 0) {
    corpo = (
      <Stack gap="xs">
        <Text size="sm" data-testid="shopee-tabela-lista-vazia">
          {textoDaListaVazia(lista.data, suportaModelo)}
        </Text>
        <NotasDaLista lista={lista.data} mostradas={0} />
      </Stack>
    );
  } else {
    corpo = (
      <Stack gap="xs">
        <Radio.Group
          value={escolhido === null ? null : String(escolhido)}
          onChange={(v) =>
            setEscolhido(tabelas.find((t) => String(t.sizeChartId) === v)?.sizeChartId ?? null)
          }
          aria-label="Modelos de tabela desta categoria"
        >
          <Stack gap="xs">
            {tabelas.map((t) => (
              <Stack
                key={t.sizeChartId}
                gap={4}
                data-testid={`shopee-tabela-opcao-${String(t.sizeChartId)}`}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Radio value={String(t.sizeChartId)} label={rotuloDoModelo(t)} />
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setAberto(aberto === t.sizeChartId ? null : t.sizeChartId)}
                  >
                    {aberto === t.sizeChartId ? 'Ocultar' : 'Ver'}
                  </Button>
                </Group>
                {aberto === t.sizeChartId && (
                  <TabelaShopeeDetalhe integracaoId={integracaoId} sizeChartId={t.sizeChartId} />
                )}
              </Stack>
            ))}
          </Stack>
        </Radio.Group>
        <NotasDaLista lista={lista.data} mostradas={tabelas.length} />
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm">
          Categoria: <strong>{rotuloCategoriaShopee(categoria)}</strong>{' '}
          <Text span size="xs" c="dimmed">
            {`#${String(categoryId)}`}
          </Text>
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="subtle" onClick={onTrocarCategoria}>
            Trocar categoria
          </Button>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            onClick={recarregar}
            loading={lista.isFetching}
          >
            Recarregar lista
          </Button>
        </Group>
      </Group>
      <AvisosDeLimites limites={limites} />
      {corpo}
      {alvo.tipo === 'adicionar' && ativa !== -1 && (
        <Text size="sm" c="dimmed">
          Esta conta já tem uma tabela para esta categoria — ela será substituída.
        </Text>
      )}
      {alvo.tipo === 'trocar' && outra !== -1 && (
        <Text size="sm" c="orange" data-testid="shopee-tabela-trocar-duplicada">
          {outra < alvo.indice
            ? 'Outra linha desta conta já usa esta categoria e vem antes — esta ficará ignorada. Remova uma das duas.'
            : 'Outra linha desta conta já usa esta categoria — esta passará a valer e a outra ficará ignorada. Remova uma das duas.'}
        </Text>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onFechar}>
          Cancelar
        </Button>
        <Button
          onClick={confirmar}
          disabled={modelo === undefined}
          data-testid="shopee-escolher-tabela-confirmar"
        >
          {rotuloConfirmar}
        </Button>
      </Group>
    </Stack>
  );
}

export function EscolherTabelaShopeeModal({
  integracaoId,
  contaNome,
  alvo,
  linhas,
  onConfirmar,
  onFechar,
}: EscolherTabelaShopeeModalProps) {
  const [categoria, setCategoria] = useState<CategoriaResumoDto | null>(null);
  // Where the browser opens: the stored category on "Trocar", then wherever the
  // operator last chose (so "Trocar categoria" lands among the siblings).
  const [inicio, setInicio] = useState<number | null>(
    alvo.tipo === 'trocar' ? alvo.categoriaAtual : null,
  );

  return (
    <Modal opened onClose={onFechar} size="xl" title={`Tabela de medidas da Shopee — ${contaNome}`}>
      <Stack gap="sm" data-testid="shopee-escolher-tabela-modal">
        {categoria === null ? (
          <>
            <Text size="sm" c="dimmed">
              Escolha a categoria (só as categorias finais aceitam tabela).
            </Text>
            <ShopeeCategoriaBrowser
              integracaoId={integracaoId}
              categoriaInicial={inicio}
              onEscolher={setCategoria}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={onFechar}>
                Cancelar
              </Button>
            </Group>
          </>
        ) : (
          <EtapaModelos
            key={categoria.categoryId}
            integracaoId={integracaoId}
            categoria={categoria}
            alvo={alvo}
            linhas={linhas}
            onConfirmar={onConfirmar}
            onFechar={onFechar}
            onTrocarCategoria={() => {
              setInicio(categoria.categoryId);
              setCategoria(null);
            }}
          />
        )}
      </Stack>
    </Modal>
  );
}
