'use client';

import { useState, type ReactNode } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import {
  docIdDaMarcaShopee,
  textoUtilizavelShopee,
  type CategoriaResumoDto,
  type MarcaDto,
  type RespostaMarcasShopee,
} from '@delfrance/schemas';

import {
  CATEGORIAS_SHOPEE_STALE_MS,
  ShopeeCategoriaBrowser,
  rotuloCategoriaShopee,
} from '@/components/shopee/ShopeeCategoriaBrowser';
import { useShopeeClient, type ShopeeClient } from '@/lib/shopee/client';
import { descreverFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import {
  recusaDoCadastroMarcaShopee,
  type OcupanteDoRegistroMarcaShopee,
} from '@/lib/shopee/marcasDaConta';

/**
 * Pick brands from ONE Shopee leaf category's brand list to REGISTER in the
 * conta's shortlist (`integracao/{id}/brandshopee`, #1911 D10): category →
 * status → that page's brands as checkboxes → «Adicionar selecionadas». The
 * modal STORES nothing — it hands the picked DTOs to `onAdicionar`, and the
 * Marcas section stages them in the conta's form (written by "Salvar
 * alterações", in the conta's own save).
 *
 * - **Leaf only.** The route answers a mid-tree id with an EMPTY page
 *   (`leaf: false`), so the browser's leaf pick is the only way in, and a
 *   `leaf: false` answer still says so instead of reading as "no brands".
 * - **One page at a time.** The route never pages on its own (Shopee's brand
 *   API is slow); «Carregar mais» asks for the next one with `offset =
 *   nextOffset` VERBATIM — Shopee's cursor, never `offset + pageSize` — and is
 *   offered only while the LAST page says `hasNextPage`. A non-null
 *   `nextOffset` on its own is never a reason to ask again.
 * - **No text filter**: the route has no name search (Shopee's
 *   `get_brand_list` takes none), and a filter would be a fold.
 * - **What cannot be picked** is shown, never dropped: a brand already in the
 *   shortlist ("já cadastrada") or already staged ("já selecionada") is
 *   checked and disabled; a brand the registration refuses is disabled with
 *   the reason — the rule and its reason are `motivoRecusaMarcaShopee`'s (the
 *   one `linhaDeMarcaParaGravarShopee` applies), worded by
 *   `recusaDoCadastroMarcaShopee` (`lib/shopee/marcasDaConta.ts`), never
 *   re-derived here; a brand whose document id is already taken by a row that
 *   is NOT that brand is disabled too — its registration could only ever raise
 *   the save's conflict — and the line names what holds the id and what clears
 *   it: another brand's row clears with that brand's removal (the section's
 *   «Remover»); an unreadable or «Sem marca» row, which this screen never
 *   removes, only outside the ERP. Shopee's `0` ("No Brand") is hidden: «Sem
 *   marca» is always offered on the listing, and the shortlist never holds it.
 *
 * Reads only; writes nothing. Retries follow `shopeeQueryRetry`.
 */
export interface AdicionarMarcasShopeeModalProps {
  integracaoId: string;
  /** `brand_id`s the shortlist already holds (integer identity). */
  cadastradas: ReadonlySet<number>;
  /** `brand_id`s already staged for registration in this form. */
  jaSelecionadas: ReadonlySet<number>;
  /**
   * EVERY document id the shortlist holds, its unreadable and «Sem marca»
   * rows included — the ids a new registration could collide with — with what
   * occupies each (`ocupantesDosRegistrosMarcasShopee`).
   */
  ocupantes: ReadonlyMap<string, OcupanteDoRegistroMarcaShopee>;
  onAdicionar: (marcas: MarcaDto[]) => void;
  onFechar: () => void;
}

/**
 * `get_brand_list`'s `status` — 1 approved, 2 pending review (Shopee's own
 * values, `SHOPEE_BRAND_STATUS` in `@delfrance/integrations-shopee`, which the
 * browser does not depend on). The route refuses any other value.
 */
export const STATUS_MARCA_SHOPEE = { aprovadas: 1, emAnalise: 2 } as const;
type StatusMarcaShopee = (typeof STATUS_MARCA_SHOPEE)[keyof typeof STATUS_MARCA_SHOPEE];

const OPCOES_STATUS = [
  { value: String(STATUS_MARCA_SHOPEE.aprovadas), label: 'Aprovadas' },
  { value: String(STATUS_MARCA_SHOPEE.emAnalise), label: 'Em análise' },
];

/** `['shopee','marcas',integracaoId,categoryId,status]` — one entry per category and status. */
export function chaveMarcasShopee(
  integracaoId: string,
  categoryId: number,
  status: number,
): readonly unknown[] {
  return ['shopee', 'marcas', integracaoId, categoryId, status];
}

function exigirCliente(client: ShopeeClient | null): ShopeeClient {
  // The query below is `enabled` only with a client; this is the type's due.
  if (client === null) throw new Error('cliente da Shopee indisponível');
  return client;
}

/**
 * The offset of the page after `ultima`, or `undefined` when there is none to
 * ask for: only while Shopee says `hasNextPage`, and only with the cursor it
 * sent — never `offset + pageSize`, and never because `nextOffset` is non-null
 * on a last page.
 */
export function proximoOffsetDasMarcas(ultima: RespostaMarcasShopee): number | undefined {
  if (!ultima.hasNextPage || ultima.nextOffset === null) return undefined;
  return ultima.nextOffset;
}

/** Why one brand of the page cannot be ticked, or `null` when it can. */
type Bloqueio =
  | { readonly tipo: 'cadastrada' }
  | { readonly tipo: 'selecionada' }
  | { readonly tipo: 'recusada'; readonly texto: string }
  | {
      readonly tipo: 'ocupada';
      readonly docId: string;
      readonly ocupante: OcupanteDoRegistroMarcaShopee;
    };

function bloqueioDaMarca(
  dto: MarcaDto,
  props: Pick<AdicionarMarcasShopeeModalProps, 'cadastradas' | 'jaSelecionadas' | 'ocupantes'>,
): Bloqueio | null {
  if (props.cadastradas.has(dto.brandId)) return { tipo: 'cadastrada' };
  if (props.jaSelecionadas.has(dto.brandId)) return { tipo: 'selecionada' };
  const recusa = recusaDoCadastroMarcaShopee(dto);
  if (recusa !== null) return { tipo: 'recusada', texto: recusa };
  // Registrable, so it is written at this id (`linhaDeMarcaParaGravarShopee`).
  const docId = docIdDaMarcaShopee(dto.brandId);
  const ocupante = props.ocupantes.get(docId);
  if (ocupante !== undefined) return { tipo: 'ocupada', docId, ocupante };
  return null;
}

/**
 * What holds a brand's document id, and what clears it — only exits this
 * screen offers, or the plain fact that it offers none.
 */
function textoDaOcupacao(docId: string, ocupante: OcupanteDoRegistroMarcaShopee): string {
  switch (ocupante.tipo) {
    case 'marca':
      return `o registro ${docId} desta lista é da marca «${ocupante.rotulo}» — esta só pode ser cadastrada depois que essa marca for removida da lista e a remoção, salva`;
    case 'sem-marca':
      return `o registro ${docId} desta lista guarda «Sem marca» e esta tela não o remove — esta marca só pode ser cadastrada depois que ele for excluído fora do ERP, por quem administra o banco de dados`;
    case 'ilegivel':
      return `o registro ${docId} desta lista é ilegível e esta tela não o remove — esta marca só pode ser cadastrada depois que ele for excluído fora do ERP, por quem administra o banco de dados`;
  }
}

function textoDoBloqueio(b: Bloqueio): string {
  switch (b.tipo) {
    case 'cadastrada':
      return 'já cadastrada';
    case 'selecionada':
      return 'já selecionada';
    case 'recusada':
      return b.texto;
    case 'ocupada':
      return textoDaOcupacao(b.docId, b.ocupante);
  }
}

/** The name a brand row shows: Shopee's original name, plus its display name when it differs. */
function rotuloDaMarca(dto: MarcaDto): string {
  // "No text" is the registration's own test (`textoUtilizavelShopee`), so a
  // row reads "(sem nome)" exactly when it is the one refused for that.
  const original =
    textoUtilizavelShopee(dto.originalBrandName) === null ? '(sem nome)' : dto.originalBrandName;
  const exibicao =
    textoUtilizavelShopee(dto.displayBrandName) !== null &&
    dto.displayBrandName !== dto.originalBrandName
      ? ` (${String(dto.displayBrandName)})`
      : '';
  return `${original}${exibicao} · id ${String(dto.brandId)}`;
}

interface EtapaMarcasProps {
  integracaoId: string;
  categoria: CategoriaResumoDto;
  bloqueios: Pick<AdicionarMarcasShopeeModalProps, 'cadastradas' | 'jaSelecionadas' | 'ocupantes'>;
  selecionadas: ReadonlyMap<number, MarcaDto>;
  onAlternar: (dto: MarcaDto) => void;
  onTrocarCategoria: () => void;
}

/** Step 2 — one leaf's brands, by status. Remounted per category, so no page leaks between two. */
function EtapaMarcas({
  integracaoId,
  categoria,
  bloqueios,
  selecionadas,
  onAlternar,
  onTrocarCategoria,
}: EtapaMarcasProps) {
  const client = useShopeeClient();
  const { categoryId } = categoria;
  const [status, setStatus] = useState<StatusMarcaShopee>(STATUS_MARCA_SHOPEE.aprovadas);

  const paginas = useInfiniteQuery({
    queryKey: chaveMarcasShopee(integracaoId, categoryId, status),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      exigirCliente(client).marcas({ integracaoId, categoryId, status, offset: pageParam }),
    getNextPageParam: proximoOffsetDasMarcas,
    enabled: client !== null,
    // The backend caches each page for 15 min; asking sooner learns nothing.
    staleTime: CATEGORIAS_SHOPEE_STALE_MS,
    refetchOnWindowFocus: false,
    retry: shopeeQueryRetry,
  });

  const recebidas = paginas.data?.pages ?? [];
  const ultima = recebidas.at(-1);
  // A cursor that repeats a brand must not repeat a row (React keys are the id).
  const vistas = new Set<number>();
  const marcas: MarcaDto[] = [];
  let semMarcaOculta = false;
  for (const pagina of recebidas) {
    for (const dto of pagina.marcas) {
      if (dto.brandId === 0) {
        semMarcaOculta = true;
        continue;
      }
      if (vistas.has(dto.brandId)) continue;
      vistas.add(dto.brandId);
      marcas.push(dto);
    }
  }

  let corpo: ReactNode;
  if (paginas.isError && ultima === undefined) {
    const { mensagem, repetivel } = descreverFalhaShopee(paginas.error, {
      desconhecido: 'Não foi possível carregar as marcas desta categoria.',
    });
    corpo = (
      <Alert color="red" variant="light" data-testid="shopee-marcas-erro">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm">{mensagem}</Text>
          {repetivel && (
            <Button size="xs" variant="light" onClick={() => void paginas.refetch()}>
              Tentar de novo
            </Button>
          )}
        </Group>
      </Alert>
    );
  } else if (ultima === undefined) {
    corpo = (
      <Group justify="center" p="md">
        <Loader size="sm" />
      </Group>
    );
  } else if (!ultima.leaf) {
    corpo = (
      <Alert color="yellow" variant="light">
        <Text size="sm">
          A Shopee informa que esta categoria tem subcategorias — volte e escolha uma delas.
        </Text>
      </Alert>
    );
  } else {
    const falhaDaProxima = paginas.isFetchNextPageError
      ? descreverFalhaShopee(paginas.error, {
          desconhecido: 'Não foi possível carregar mais marcas.',
        }).mensagem
      : null;
    corpo = (
      <Stack gap="xs">
        {ultima.isMandatory === true && (
          <Alert color="blue" variant="light" p="xs" data-testid="shopee-marcas-obrigatoria">
            <Text size="sm">Nesta categoria a marca é obrigatória.</Text>
          </Alert>
        )}
        {marcas.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="shopee-marcas-vazia">
            {status === STATUS_MARCA_SHOPEE.aprovadas
              ? 'Nenhuma marca aprovada nesta categoria.'
              : 'Nenhuma marca em análise nesta categoria.'}
          </Text>
        ) : (
          <Stack gap={6} data-testid="shopee-marcas-lista">
            {marcas.map((dto) => {
              const bloqueio = bloqueioDaMarca(dto, bloqueios);
              const marcada =
                bloqueio?.tipo === 'cadastrada' ||
                bloqueio?.tipo === 'selecionada' ||
                (bloqueio === null && selecionadas.has(dto.brandId));
              return (
                <Stack
                  key={dto.brandId}
                  gap={0}
                  data-testid={`shopee-marca-opcao-${String(dto.brandId)}`}
                >
                  <Checkbox
                    label={rotuloDaMarca(dto)}
                    checked={marcada}
                    disabled={bloqueio !== null}
                    onChange={() => onAlternar(dto)}
                  />
                  {bloqueio !== null && (
                    <Text size="xs" c="dimmed" pl={30}>
                      {textoDoBloqueio(bloqueio)}
                    </Text>
                  )}
                </Stack>
              );
            })}
          </Stack>
        )}
        {semMarcaOculta && (
          <Text size="xs" c="dimmed" data-testid="shopee-marcas-sem-marca-oculta">
            «Sem marca» está sempre disponível no anúncio — não precisa ser cadastrada.
          </Text>
        )}
        {falhaDaProxima !== null && (
          <Text size="sm" c="red" data-testid="shopee-marcas-erro-mais">
            {falhaDaProxima}
          </Text>
        )}
        {paginas.hasNextPage ? (
          <Group justify="center">
            <Button
              size="xs"
              variant="light"
              loading={paginas.isFetchingNextPage}
              onClick={() => void paginas.fetchNextPage()}
            >
              Carregar mais
            </Button>
          </Group>
        ) : (
          ultima.hasNextPage && (
            <Text size="xs" c="dimmed" data-testid="shopee-marcas-sem-cursor">
              A Shopee indicou mais marcas, mas não informou de onde continuar.
            </Text>
          )
        )}
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
        <Button size="xs" variant="subtle" onClick={onTrocarCategoria}>
          Trocar categoria
        </Button>
      </Group>
      <SegmentedControl
        aria-label="Situação das marcas"
        data={OPCOES_STATUS}
        value={String(status)}
        onChange={(v) =>
          setStatus(
            Number(v) === STATUS_MARCA_SHOPEE.emAnalise
              ? STATUS_MARCA_SHOPEE.emAnalise
              : STATUS_MARCA_SHOPEE.aprovadas,
          )
        }
      />
      <Text size="xs" c="dimmed">
        A Shopee não busca marcas por nome: navegue pelas páginas.
      </Text>
      {corpo}
    </Stack>
  );
}

export function AdicionarMarcasShopeeModal({
  integracaoId,
  cadastradas,
  jaSelecionadas,
  ocupantes,
  onAdicionar,
  onFechar,
}: AdicionarMarcasShopeeModalProps) {
  const [categoria, setCategoria] = useState<CategoriaResumoDto | null>(null);
  // "Trocar categoria" reopens the browser among the last pick's siblings.
  const [inicio, setInicio] = useState<number | null>(null);
  // Kept across categories and statuses: a brand is a brand wherever it was
  // ticked, and the count on the confirm button names them all.
  const [selecionadas, setSelecionadas] = useState<ReadonlyMap<number, MarcaDto>>(new Map());
  const bloqueios = { cadastradas, jaSelecionadas, ocupantes };

  const alternar = (dto: MarcaDto) =>
    setSelecionadas((atual) => {
      const proxima = new Map(atual);
      if (proxima.has(dto.brandId)) proxima.delete(dto.brandId);
      else proxima.set(dto.brandId, dto);
      return proxima;
    });

  // A pick made before the shortlist or the staging changed (another tab's
  // save, the section's own undo) is never handed on once it is blocked.
  const validas = [...selecionadas.values()].filter(
    (dto) => bloqueioDaMarca(dto, bloqueios) === null,
  );

  return (
    <Modal opened onClose={onFechar} size="xl" title="Adicionar marcas da Shopee">
      <Stack gap="sm" data-testid="shopee-adicionar-marcas-modal">
        {categoria === null ? (
          <>
            <Text size="sm" c="dimmed">
              Escolha a categoria (a Shopee lista marcas só das categorias finais).
            </Text>
            <ShopeeCategoriaBrowser
              integracaoId={integracaoId}
              categoriaInicial={inicio}
              onEscolher={setCategoria}
            />
          </>
        ) : (
          <EtapaMarcas
            key={categoria.categoryId}
            integracaoId={integracaoId}
            categoria={categoria}
            bloqueios={bloqueios}
            selecionadas={selecionadas}
            onAlternar={alternar}
            onTrocarCategoria={() => {
              setInicio(categoria.categoryId);
              setCategoria(null);
            }}
          />
        )}
        {validas.length > 0 && (
          <Group gap={4} data-testid="shopee-marcas-selecionadas">
            <Text size="xs" c="dimmed">
              Selecionadas:
            </Text>
            {validas.map((dto) => (
              <Badge key={dto.brandId} variant="light" size="sm">
                {dto.originalBrandName}
              </Badge>
            ))}
          </Group>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onFechar}>
            Cancelar
          </Button>
          <Button
            onClick={() => onAdicionar(validas)}
            disabled={validas.length === 0}
            data-testid="shopee-adicionar-marcas-confirmar"
          >
            {`Adicionar selecionadas (${String(validas.length)})`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
