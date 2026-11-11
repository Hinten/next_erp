import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Activity, type ReactNode } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { PERM } from '@delfrance/auth';
import {
  ACAO_STATUS_ANUNCIO,
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  CAMPO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  PADRAO_ID_RASCUNHO_SHOPEE,
  SHOPEE_MODEL_STATUS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  TIPO_AVISO,
  anuncioShopeeVivo,
  chaveAvisoReceitaKitShopee,
  estadoPublicacaoRascunhoShopee,
  type AtributoDto,
  type AtributoInfoDto,
  type EstadoPublicacaoRascunhoShopee,
  type ProdutoShopeeLink,
} from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  type ShopeeClient,
} from '@/lib/shopee/client';
import {
  DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE,
  FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
  FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE,
  FRASE_CONFIRMAR_DESCARTE_SHOPEE,
  FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE,
  FRASE_RASCUNHO_CARREGANDO_SHOPEE,
  FRASE_RASCUNHO_CRIADO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_SHOPEE,
  FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE,
  FRASE_RASCUNHO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
  FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_RASCUNHO_NOVO_SHOPEE,
  FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE,
  FRASE_RASCUNHO_SALVO_SHOPEE,
  FRASE_RASCUNHO_SEM_MUDANCA_SHOPEE,
  FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
  FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
  FRASE_ATESTACAO_QUE_VARRE_SHOPEE,
  FRASE_ATESTACAO_SEM_BUSCA_SHOPEE,
  FRASE_ATESTACAO_SUPERADA_SHOPEE,
  FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
  FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE,
  FRASE_PUBLICAR_SEM_ATRIBUTOS_SHOPEE,
  FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE,
  MOTIVO_ANUNCIO_SHOPEE,
  PORTA_DA_IMPORTACAO_SHOPEE,
  ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
  ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE,
  ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE,
  ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE,
  ROTULO_PUBLICAR_RASCUNHO_SHOPEE,
  TITULO_PUBLICAR_RASCUNHO_SHOPEE,
  TEXTO_ACAO_SUGERIDA,
  TEXTO_AVISO_KIT,
  TEXTO_MOTIVO_KIT,
  TITULO_SEGUNDO_ANUNCIO_SHOPEE,
  FRASE_LIMITE_NA_CRIACAO_DE_KIT,
  chaveIncerto,
  formatarInstanteShopee,
  fraseDaRespostaIlegivelDoRascunhoShopee,
  fraseDaRespostaIncertaDoRascunhoShopee,
  fraseDoConflitoDeConcorrenciaShopee,
  fraseDoConflitoIlegivelShopee,
  fraseDaPublicacaoExpiradaShopee,
  fraseDaPublicacaoInterrompidaShopee,
  fraseDosAtributosNaoLidosShopee,
  fraseDoRascunhoEmAndamentoShopee,
  fraseDosRascunhosIrmaosIncertosShopee,
  textoDaConfirmacaoDePublicacaoShopee,
  textoDoSegundoAnuncioNaPublicacaoShopee,
  textoDoSegundoAnuncioShopee,
  rotuloDaPublicacaoQueAdotaShopee,
} from '@/lib/shopee/anuncioProduto';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee } from '@/lib/shopee/erros';
import {
  marcaDaLinhaParaRascunhoShopee,
  saidasDoProblemaShopee,
  type ExistentesNaContaShopee,
  type SaidaDoProblemaShopee,
} from '@/lib/shopee/rascunho';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type AnuncioStatusShopee,
  type KitPublicadoShopee,
  type ProblemaShopee,
  type RespostaAtributosShopee,
  type RespostaLimitesDoItemShopee,
  type RespostaPublicarShopee,
  type RespostaReverificarShopee,
} from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';
import type { RascunhoShopeeProps } from './RascunhoShopee';
import type { ConflitoRascunhoShopeeModalProps } from './ConflitoRascunhoShopeeModal';
import type { DesfechoAcaoShopeeProps } from './DesfechoAcaoShopee';
import type { AcoesShopee } from './AcoesAnuncioShopee';

/**
 * T5 (a)–(c) (reconcile §4, PR 6) and the read-only block: the Shopee tab over
 * EXISTING links. Every read is doubled at its I/O edge — the snapshot hooks,
 * the one-shot `getDocs` of the models — and told apart by WHAT IT WAS BUILT ON
 * (the `MercadoLivreEditor` harness's tagging, never call order). Every rule
 * the tab displays by is the REAL `@delfrance/schemas` function.
 *
 * PR 7 adds the actions (T5 (c) button half, (d), (e), (h), (k), (n)): the
 * client is `shopeeClientFalso` holding only the methods a test expects, so a
 * call to any other route rejects naming itself; the error classes stay REAL
 * (the module is mocked with `importOriginal` spread) for the `instanceof`s.
 *
 * PR 8 adds the native kit (T5 (f), (g), (h) Recriar, (i), (j), (l), (m)): the
 * kit badge, the recipe preview over the children's `paiId ==` shape and the
 * component names by id, the open aviso by its deterministic id, the create
 * arms under the ONE lock, and the uncertain create with its stored wait — the
 * REAL `sessionStorage` of jsdom, cleared before every test.
 */

interface Linha {
  id: string;
  data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  contas: [] as Linha[],
  links: [] as Linha[],
  filhos: [] as Linha[],
  /** `variashopee` rows per child produto id. */
  varLinks: new Map<string, Linha[]>(),
  /**
   * EVERY `integracao` document by id — what a by-id read finds. `contas` is
   * only the page the bounded live query returned.
   */
  contasPorId: new Map<string, Record<string, unknown>>(),
  produto: { nome: 'Camiseta', paiId: null } as Record<string, unknown> | null,
  tabMedi: null as Record<string, unknown> | null,
  /** The snapshot hooks' `loading` — a re-listen keeps `data` (R1). */
  carregando: false,
  permitidos: new Set<bigint>(),
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  /** Every collection a live query was opened on — what the tab chose to READ. */
  consultas: new Set<string>(),
  /** What `useShopeeClient` hands the editor (`null` = no signed-in user yet). */
  client: null as ShopeeClient | null,
  notify: vi.fn(),
  /** The `shopeeKitReceitaDivergente` aviso doc, by its deterministic id (`null` = none). */
  aviso: null as Record<string, unknown> | null,
  /** Every aviso doc id the tab subscribed to. */
  avisosLidos: new Set<string>(),
  /** Component produto id → `nome`, for the recipe's one-shot name read. */
  nomes: new Map<string, string>(),
  getDocsByIds: vi.fn(),
  /** Every `tabMedi` doc id the tab built a ref to — WHICH tabela it chose to read. */
  tabMediIds: [] as string[],
  /**
   * The snapshot hooks' `fromCache` (#1911 P10's server-truth gate): `false` =
   * the emission came from the server; `true` = a cache-served one (the first
   * emission of a re-listen, an Activity re-show).
   */
  fromCache: false as boolean | undefined,
  /** The produto's `extraData/singleton` document (`null` = none). */
  extraData: null as Record<string, unknown> | null,
  /** The `extraData/singleton` LISTENER failed (`null` = it answers `extraData`). */
  extraDataErro: null as Error | null,
  /** The LAST props each draft form received, by link doc id (the `RascunhoShopee` double). */
  rascunhos: new Map<string, RascunhoShopeeProps>(),
  /** The LAST props the conflict modal received (the `ConflitoRascunhoShopeeModal` double). */
  conflito: null as ConflitoRascunhoShopeeModalProps | null,
  /** The LAST props each outcome panel received, by link doc id (the REAL panel, wrapped — #1911 P11). */
  desfechos: new Map<string, DesfechoAcaoShopeeProps>(),
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.client };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

vi.mock('@delfrance/data', () => ({
  // ⚠️ KEEPS THE BASE'S TAGS so a query is told apart by what it was built on —
  // and carries its `limit`, which the `getDocs` double honours.
  buildQuery: (base: object, constraints: readonly { __limit?: number }[] = []) => {
    const n = constraints.find((c) => c.__limit !== undefined)?.__limit;
    return n === undefined ? base : { ...base, __limit: n };
  },
  limit: (n: number) => ({ __limit: n }),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: (q: { __col?: string } | null) => {
    if (q === null) return { data: undefined, loading: false, error: undefined };
    h.consultas.add(q.__col ?? '?');
    const data =
      q.__col === 'integracao' ? h.contas : q.__col === 'prodshopee' ? h.links : h.filhos;
    // The real hook's metadata (`useSnapshot.ts`): the server-truth gate reads it.
    return {
      data,
      loading: h.carregando,
      error: undefined,
      fromCache: h.fromCache,
      hasPendingWrites: false,
    };
  },
  useDocSnapshot: (ref: { __doc?: string; id?: string } | null) => {
    if (ref === null) return { data: undefined, loading: false, error: undefined };
    if (ref.__doc === 'aviso') h.avisosLidos.add(ref.id ?? '?');
    // A failed listener, as the real hook reports it: no data, the error.
    if (ref.__doc === 'extraData' && h.extraDataErro !== null) {
      return { data: undefined, loading: false, error: h.extraDataErro };
    }
    const data =
      ref.__doc === 'produto'
        ? h.produto
        : ref.__doc === 'aviso'
          ? h.aviso
          : ref.__doc === 'extraData'
            ? h.extraData
            : h.tabMedi;
    return {
      data: data === null ? null : { id: ref.__doc ?? '?', data },
      loading: false,
      error: undefined,
      fromCache: h.fromCache,
      hasPendingWrites: false,
    };
  },
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDocs: h.getDocs,
  getDoc: h.getDoc,
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: h.permitidos.has(bit), loading: false }),
}));
vi.mock('@/lib/data/integracaoCollection', () => ({
  integracaoCollection: {
    ref: () => ({ __col: 'integracao' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __doc: 'integracao', id }),
  },
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ __col: 'produtos' }),
    docRef: () => ({ __doc: 'produto' }),
  },
}));
vi.mock('@/lib/data/produtoShopeeLinkCollection', () => ({
  produtoShopeeLinkCollection: { ref: () => ({ __col: 'prodshopee' }) },
}));
vi.mock('@/lib/data/variacaoShopeeLinkCollection', () => ({
  variacaoShopeeLinkCollection: {
    ref: (_db: unknown, ctx: { produtoId: string }) => ({
      __col: 'variashopee',
      produtoId: ctx.produtoId,
    }),
  },
}));
vi.mock('@/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => {
      h.tabMediIds.push(id);
      return { __doc: 'tabMedi' };
    },
  },
}));
vi.mock('@/lib/data/avisoCollection', () => ({
  avisoCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __doc: 'aviso', id }),
  },
}));
vi.mock('@/lib/data/getDocsByIds', () => ({ getDocsByIds: h.getDocsByIds }));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: { docRef: () => ({ __doc: 'extraData' }) },
}));

/*
 * #1911 P10 — the draft form and the conflict modal are PRESENTATIONAL (their
 * own suites render them for real); here they are doubles that record the
 * props the EDITOR hands them and expose its handlers, so what this suite pins
 * is the editor's wiring: which decision each block gets, what each handler
 * sends. The double keeps the frozen contract's names — the root test id and
 * the four buttons, rendered only with `podeEditar` («Descartar» alone with
 * `somenteDescartar` — never «Publicar»), each enabled by the block's own
 * decision — and (#1911 P11, the pin split's `/Publicar/` half INVERTED on
 * purpose, K2-3) «Publicar», enabled by `decisaoDePublicar`, plus the
 * controlled confirmation it opens: the editor's state, painted with the D15
 * warning when `segundoAnuncio` is set, the attestation when one opened it,
 * «Criar pausado», and a confirm that acts only while the gate says yes.
 */
vi.mock('./RascunhoShopee', async () => {
  const { useState } = await import('react');
  const copia = await import('@/lib/shopee/anuncioProduto');
  function ConfirmacaoDupla({ p }: { p: RascunhoShopeeProps }) {
    const c = p.confirmacaoDePublicacao;
    const [pausado, setPausado] = useState(c?.pausado ?? false);
    if (c === null) return null;
    return (
      <div
        role="dialog"
        aria-label={copia.TITULO_PUBLICAR_RASCUNHO_SHOPEE}
        data-testid={`shopee-rascunho-publicar-${p.linkDocId}`}
      >
        {c.segundoAnuncio !== null && (
          <p data-testid="aviso-segundo-anuncio">
            {copia.textoDoSegundoAnuncioNaPublicacaoShopee(c.segundoAnuncio, {
              publicacao: p.bloco.publicacao,
              atestacao: c.atestacao,
            })}
          </p>
        )}
        {c.atestacao !== null && <p data-testid="atestacao">{c.atestacao.rotulo}</p>}
        <label>
          <input type="checkbox" checked={pausado} onChange={(e) => setPausado(e.target.checked)} />
          {copia.ROTULO_CRIAR_PAUSADO_SHOPEE}
        </label>
        <button type="button" onClick={p.onCancelarPublicacao}>
          Cancelar
        </button>
        <button
          type="button"
          disabled={!p.decisaoDePublicar.podePublicar}
          onClick={() => p.onConfirmarPublicacao(pausado)}
        >
          Confirmar publicação
        </button>
      </div>
    );
  }
  return {
    RascunhoShopee: (p: RascunhoShopeeProps) => {
      h.rascunhos.set(p.linkDocId, p);
      return (
        <div data-testid={`shopee-rascunho-${p.linkDocId}`}>
          {p.bloco.avisos.map((a) => (
            <p key={a}>{a}</p>
          ))}
          {p.resultado !== null && (
            <p data-testid={`resultado-${p.linkDocId}`}>{p.resultado.mensagem}</p>
          )}
          <input
            aria-label="Título do anúncio"
            value={p.bloco.valores.item_name ?? ''}
            readOnly={!p.bloco.camposEditaveis}
            onChange={(e) => p.onCampo('item_name', e.target.value)}
          />
          {p.podeEditar && (
            <>
              <button type="button" disabled={!p.bloco.podeSalvar} onClick={p.onSalvar}>
                Salvar rascunho
              </button>
              <button type="button" disabled={!p.bloco.podeDesfazer} onClick={p.onDesfazer}>
                Desfazer alterações
              </button>
              <button
                type="button"
                disabled={!p.bloco.podeDescartar}
                onClick={() => p.onDescartar(p.bloco.descarte)}
              >
                Descartar
              </button>
              <button
                type="button"
                disabled={!p.decisaoDePublicar.podePublicar}
                onClick={p.onPublicar}
              >
                {copia.ROTULO_PUBLICAR_RASCUNHO_SHOPEE}
              </button>
            </>
          )}
          {!p.podeEditar && p.somenteDescartar && (
            <button
              type="button"
              disabled={!p.bloco.podeDescartar}
              onClick={() => p.onDescartar(p.bloco.descarte)}
            >
              Descartar
            </button>
          )}
          {p.confirmacaoDePublicacao !== null && <ConfirmacaoDupla p={p} />}
        </div>
      );
    },
  };
});
/*
 * The outcome panel is the REAL one (T2's suite pins its copy) — wrapped only
 * to record the props the editor's block hands it, so this suite pins the
 * wiring (#1911 P11: the draft's reading and clock, its gate, its exits, the
 * surfaces' destinations) without re-asserting the panel's sentences.
 */
vi.mock('./DesfechoAcaoShopee', async (importOriginal) => {
  const real = await importOriginal<typeof import('./DesfechoAcaoShopee')>();
  return {
    ...real,
    DesfechoAcaoShopee: (p: DesfechoAcaoShopeeProps) => {
      h.desfechos.set(p.linkDocId, p);
      return <real.DesfechoAcaoShopee {...p} />;
    },
  };
});
vi.mock('./ConflitoRascunhoShopeeModal', () => ({
  ConflitoRascunhoShopeeModal: (p: ConflitoRascunhoShopeeModalProps) => {
    h.conflito = p;
    if (p.conflito === null) return null;
    return (
      <div role="dialog" aria-label="Rascunho alterado" data-testid="shopee-rascunho-conflito">
        <button type="button" onClick={p.onCancelar}>
          Cancelar
        </button>
        <button type="button" disabled={!p.servidorCarregado} onClick={p.onUsarOQueEstaSalvo}>
          Usar o que está salvo
        </button>
        <button
          type="button"
          disabled={!p.servidorCarregado || p.salvando}
          onClick={p.onSalvarMesmoAssim}
        >
          Salvar mesmo assim
        </button>
      </div>
    );
  },
}));

const {
  FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE,
  FRASE_DESCRICAO_DO_PRODUTO_NAO_LIDA_SHOPEE,
  FRASE_SESSAO_NAO_RENOVADA_SHOPEE,
  FRASE_SESSAO_SEM_CONEXAO_SHOPEE,
  ShopeeEditor,
  fraseDaSessaoShopee,
  fraseDosLimitesNaoLidosShopee,
} = await import('./ShopeeEditor');
const { TITULO_PUBLICACAO_BLOQUEADA_SHOPEE, TITULO_PUBLICACAO_RECUSADA_SHOPEE } =
  await import('./DesfechoAcaoShopee');
const { ROTULO_PUBLICACAO_EM_ANDAMENTO_SHOPEE, ROTULO_PUBLICACAO_INCERTA_SHOPEE } =
  await import('./StatusAnuncioShopee');
const { AcoesAnuncioShopee } = await import('./AcoesAnuncioShopee');
const { MAX_MODELOS_POR_FILHO } = await import('./ModelosAnuncioShopee');
const { convertivel } = await import('./KitAnuncioShopee');
const { startTransition } = await import('react');

const conta = (id: string, nome: string, extra: Record<string, unknown> = {}): Linha => ({
  id,
  data: { nome, tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: 987654, ...extra },
});

const link = (id: string, extra: Record<string, unknown> = {}): Linha => ({
  id,
  data: {
    contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
    item_name: `Anúncio ${id}`,
    item_id: 1000001,
    category_id: 100087,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    ...extra,
  },
});

function renderEditor(
  props: {
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    produtoSujoForaDoFormulario?: boolean;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  return render(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} {...props} />, {
    wrapper,
  });
}

const bloco = (linkDocId: string) => screen.getByTestId(`shopee-anuncio-${linkDocId}`);
const painel = (contaId: string) => screen.getByTestId(`shopee-conta-${contaId}`);
/** The link doc ids of the blocks a panel lists, in DOM order. */
const blocosDe = (contaId: string) =>
  within(painel(contaId))
    .queryAllByTestId(/^shopee-anuncio-/)
    .map((el) => el.getAttribute('data-testid')!.slice('shopee-anuncio-'.length));

beforeEach(() => {
  h.contas = [conta('int-1', 'Loja A')];
  h.links = [];
  h.filhos = [];
  h.varLinks = new Map();
  h.contasPorId = new Map();
  h.produto = { nome: 'Camiseta', paiId: null };
  h.tabMedi = null;
  h.carregando = false;
  h.consultas = new Set();
  h.tabMediIds = [];
  h.permitidos = new Set([PERM.integracao.read]);
  h.client = shopeeClientFalso();
  h.notify.mockReset();
  h.getDocs.mockReset();
  h.getDocs.mockImplementation(async (q: { produtoId: string; __limit?: number }) => ({
    docs: (h.varLinks.get(q.produtoId) ?? [])
      .slice(0, q.__limit ?? Number.POSITIVE_INFINITY)
      .map((v) => ({ id: v.id, data: () => v.data })),
  }));
  h.getDoc.mockReset();
  h.getDoc.mockImplementation(async (ref: { id: string }) => ({
    id: ref.id,
    data: () => h.contasPorId.get(ref.id),
  }));
  h.aviso = null;
  h.avisosLidos = new Set();
  h.fromCache = false;
  h.extraData = null;
  h.extraDataErro = null;
  h.rascunhos = new Map();
  h.conflito = null;
  h.desfechos = new Map();
  h.nomes = new Map();
  h.getDocsByIds.mockReset();
  h.getDocsByIds.mockImplementation(
    async (_db: unknown, _handle: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => h.nomes.has(id)).map((id) => [id, { nome: h.nomes.get(id) }])),
  );
  window.sessionStorage.clear();
});

describe('ShopeeEditor — which conta a link belongs to', () => {
  it('(a) folds both stored encodings of one conta ref into ONE tab, never showing conta int-12’s link under int-1', () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-12', 'Loja B')];
    h.links = [
      link('L1', { contaProdutoShopeeOuterRef: 'documents/integracao/int-1' }),
      link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-1' }),
      // NEAR-MISS: `int-12` contains `int-1` — a substring or prefix fold
      // would hand this listing to Loja A.
      link('L3', { contaProdutoShopeeOuterRef: 'documents/integracao/int-12' }),
    ];
    renderEditor();

    expect(blocosDe('int-1').sort()).toEqual(['L1', 'L2']);
    expect(screen.getByRole('tab', { name: /Loja A/ }).textContent).toContain('2 anúncio(s)');

    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    expect(blocosDe('int-12')).toEqual(['L3']);
    // No orphan tab was invented for the bare encoding.
    expect(screen.queryByRole('tab', { name: /não encontrada/ })).toBeNull();
  });

  it('(b) gives a conta with no document a tab of its own — the link is shown, never dropped', async () => {
    h.links = [link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();

    const orfa = await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    // Called missing only after its by-id read said so.
    expect(h.getDoc).toHaveBeenCalledWith(expect.objectContaining({ id: 'int-9' }));
    // It holds the only listing, so it opens first.
    expect(orfa.getAttribute('aria-selected')).toBe('true');
    expect(blocosDe('int-9')).toEqual(['L9']);
    expect(within(painel('int-9')).getByText(/não está cadastrada/)).toBeDefined();
    // The registered conta keeps its tab, honestly empty.
    fireEvent.click(screen.getByRole('tab', { name: /Loja A/ }));
    expect(
      within(painel('int-1')).getByText('Este produto não tem anúncio nesta conta.'),
    ).toBeDefined();
  });

  it('puts the links whose conta ref names no id in a LAST tab of their own', async () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = { nome: 'Camisetas adulto', tabelasMedidasShopee: {} };
    h.links = [
      // A raw (unparsed) document with an empty ref — listed FIRST on purpose.
      link('L-sem', { contaProdutoShopeeOuterRef: '' }),
      link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' }),
    ];
    renderEditor();
    await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Loja ASem anúncio',
      'Conta int-9 (não encontrada)1 anúncio(s)',
      'Sem conta legível1 anúncio(s)',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: /Sem conta legível/ }));
    expect(blocosDe('__sem_conta__')).toEqual(['L-sem']);
    expect(within(bloco('L-sem')).getByText(/sem conta legível, nenhum modelo/)).toBeDefined();
  });

  it('reads a conta past the bounded query BY ID and shows its link under it — never "não encontrada" — while a conta with no document still is', async () => {
    // `int-77` exists but sits past the query's page (`h.contas` is the page).
    h.contasPorId.set('int-1', conta('int-1', 'Loja A').data);
    h.contasPorId.set('int-77', conta('int-77', 'Loja Z', { shop_id: 555 }).data);
    h.links = [
      link('L1'),
      link('L77', { contaProdutoShopeeOuterRef: 'integracao/int-77', item_id: 1000077 }),
      // NEAR-MISS: no document at all — the one honest "não encontrada".
      link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9', item_id: 1000009 }),
    ];
    renderEditor();

    await screen.findByRole('tab', { name: /Loja Z/ });
    await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Loja A1 anúncio(s)',
      'Loja Z1 anúncio(s)',
      'Conta int-9 (não encontrada)1 anúncio(s)',
    ]);
    expect(screen.queryByRole('tab', { name: /int-77/ })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Loja Z/ }));
    expect(blocosDe('int-77')).toEqual(['L77']);
    // Its real shop_id: the storefront link is built, and nothing says it is missing.
    expect(
      within(bloco('L77')).getByRole('link', { name: 'Ver na Shopee' }).getAttribute('href'),
    ).toBe('https://shopee.com.br/product/555/1000077');
    expect(within(painel('int-77')).queryByText(/não está cadastrada/)).toBeNull();

    // By id, and only the ids the page lacks — never `int-1`, never a query.
    expect(h.getDoc.mock.calls.map(([ref]) => (ref as { id: string }).id).sort()).toEqual([
      'int-77',
      'int-9',
    ]);
    expect([...h.consultas].sort()).toEqual(['integracao', 'prodshopee']);
  });

  it('NEAR-MISS: a by-id document of ANOTHER channel is no Shopee conta — "não encontrada", as the query would say', async () => {
    // The query filters `tipo == shopee`; the by-id read must not count what it would not.
    h.contasPorId.set(
      'int-ml',
      conta('int-ml', 'Conta do Mercado Livre', { tipo: INTEGRACAO_TIPO.mercadoLivre }).data,
    );
    h.links = [link('L-ml', { contaProdutoShopeeOuterRef: 'integracao/int-ml' })];
    renderEditor();

    await screen.findByRole('tab', { name: /Conta int-ml \(não encontrada\)/ });
    expect(h.getDoc).toHaveBeenCalledWith(expect.objectContaining({ id: 'int-ml' }));
    expect(screen.queryByRole('tab', { name: /Mercado Livre/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /int-ml/ }));
    expect(within(bloco('L-ml')).queryByRole('link', { name: 'Ver na Shopee' })).toBeNull();
  });

  it('reads no id no document can carry, and calls it "não encontrada" without a read', async () => {
    h.links = [
      link('L-rel', { contaProdutoShopeeOuterRef: 'documents/integracao/..' }),
      link('L-res', { item_id: 1000002, contaProdutoShopeeOuterRef: 'integracao/__x__' }),
    ];
    renderEditor();
    expect(screen.getByRole('tab', { name: /Conta \.\. \(não encontrada\)/ })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Conta __x__ \(não encontrada\)/ })).toBeDefined();
    expect(h.getDoc).not.toHaveBeenCalled();
  });

  it('keeps the selected conta while a newly named off-page conta is read, and says "carregando", never "não encontrada"', async () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.contasPorId.set('int-77', conta('int-77', 'Loja Z').data);
    h.links = [
      link('L1'),
      link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' }),
      link('L77', { item_id: 1000077, contaProdutoShopeeOuterRef: 'integracao/int-77' }),
    ];
    const { rerender } = renderEditor();
    await screen.findByRole('tab', { name: /Loja Z/ });
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));

    // A listing on a SECOND conta past the page lands while the tab is open; the
    // re-read of the id set hangs.
    const pendentes = new Map<string, (dados: Record<string, unknown>) => void>();
    h.getDoc.mockImplementation(
      (ref: { id: string }) =>
        new Promise((resolve) => {
          pendentes.set(ref.id, (dados) => resolve({ id: ref.id, data: () => dados }));
        }),
    );
    h.links = [
      ...h.links,
      link('L88', { item_id: 1000088, contaProdutoShopeeOuterRef: 'integracao/int-88' }),
    ];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);

    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Conta int-88 \(carregando…\)/ })).toBeDefined();
    // The conta already read keeps its name while the new set is read.
    expect(screen.getByRole('tab', { name: /Loja Z/ })).toBeDefined();
    expect(screen.queryByRole('tab', { name: /não encontrada/ })).toBeNull();

    await waitFor(() => expect([...pendentes.keys()].sort()).toEqual(['int-77', 'int-88']));
    pendentes.get('int-77')!(conta('int-77', 'Loja Z').data);
    pendentes.get('int-88')!(conta('int-88', 'Loja C').data);
    await screen.findByRole('tab', { name: /Loja C/ });
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: /carregando/ })).toBeNull();
  });

  it('badges a conta with no listing "Sem anúncio"', () => {
    renderEditor();
    expect(screen.getByRole('tab', { name: /Loja A/ }).textContent).toContain('Sem anúncio');
  });

  it('points to Canais when there is no Shopee conta and no listing at all', () => {
    h.contas = [];
    renderEditor();
    expect(screen.getByText(/Nenhuma conta Shopee cadastrada/)).toBeDefined();
  });
});

describe('ShopeeEditor — the listing state', () => {
  it('(c) reads estadoAnuncio null as "Não verificado" and lists it as LIVE; removido reads "Removido" and sorts last', () => {
    h.links = [
      // Published LATER, but removed: it must still sort after the live one.
      link('L-removido', {
        item_id: 1000002,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
        publicadoEm: 2_000,
      }),
      // Never folded (an imported link): not evidence of anything.
      link('L-nulo', { item_id: 1000001, estadoAnuncio: null, publicadoEm: 1_000 }),
    ];
    renderEditor();

    expect(blocosDe('int-1')).toEqual(['L-nulo', 'L-removido']);
    expect(within(bloco('L-nulo')).getByText('Não verificado')).toBeDefined();
    expect(within(bloco('L-nulo')).queryByText('Removido')).toBeNull();
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
  });

  it('says who paused a listing, and that it is deboosted', () => {
    h.links = [
      link('L-erp', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado, pausadoPeloErp: true }),
      link('L-shopee', {
        item_id: 1000002,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
        pausadoPeloErp: null,
        deboost: true,
      }),
    ];
    renderEditor();
    expect(within(bloco('L-erp')).getByText('Pausado pelo ERP')).toBeDefined();
    expect(within(bloco('L-shopee')).getByText('Pausado na Shopee')).toBeDefined();
    expect(within(bloco('L-shopee')).getByText('Rebaixado na busca')).toBeDefined();
    expect(within(bloco('L-erp')).queryByText('Rebaixado na busca')).toBeNull();
  });

  it('links a published listing to its storefront page, and a draft to nothing', () => {
    h.links = [
      link('L-pub', { item_id: 1000001 }),
      link('L-rascunho', { item_id: null, estadoAnuncio: null, category_id: null }),
    ];
    renderEditor();

    const ver = within(bloco('L-pub')).getByRole('link', { name: 'Ver na Shopee' });
    expect(ver.getAttribute('href')).toBe('https://shopee.com.br/product/987654/1000001');
    expect(ver.getAttribute('rel')).toContain('noopener');
    expect(within(bloco('L-rascunho')).getByText('Não publicado')).toBeDefined();
    expect(within(bloco('L-rascunho')).queryByRole('link', { name: 'Ver na Shopee' })).toBeNull();
  });

  it('names the link that superseded a listing, and lists it after the live one', () => {
    h.links = [
      link('L-velho', { substituidoPorLinkDocId: 'L-kit', substituidoEm: Date.UTC(2026, 9, 1, 3) }),
      link('L-kit', { item_id: 1000002 }),
    ];
    renderEditor();
    expect(blocosDe('int-1')).toEqual(['L-kit', 'L-velho']);
    expect(
      within(bloco('L-velho')).getByText(/Substituído pelo vínculo L-kit em 01\/10\/2026, 00:00/),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — refusals and violations, through the shared readers', () => {
  it('shows a price refusal while no clean send is newer — a tie shows it — and hides a stale one', () => {
    h.links = [
      link('L-atual', {
        precoRecusaEm: 2_000,
        precoEnviadoEm: 1_000,
        precoRecusaMensagem: 'Preço abaixo do mínimo da categoria.',
        precoRecusaCodigo: 'erp:preco-minimo',
      }),
      link('L-empate', {
        item_id: 1000002,
        precoRecusaEm: 1_500,
        precoEnviadoEm: 1_500,
        precoRecusaMensagem: 'Empate.',
      }),
      link('L-velha', {
        item_id: 1000003,
        precoRecusaEm: 1_000,
        precoEnviadoEm: 2_000,
        precoRecusaMensagem: 'Recusa já superada.',
      }),
    ];
    renderEditor();
    expect(
      within(bloco('L-atual')).getByText(
        /Preço abaixo do mínimo da categoria\. \(código erp:preco-minimo\)/,
      ),
    ).toBeDefined();
    expect(within(bloco('L-empate')).getByText(/Empate\./)).toBeDefined();
    expect(within(bloco('L-velha')).queryByText(/Recusa já superada/)).toBeNull();
    expect(within(bloco('L-velha')).queryByText('Preço recusado')).toBeNull();
  });

  it('keeps a hidden stock refusal on screen while the stock gate’s skip set is armed', () => {
    h.links = [
      // A clean send's stamp is NEWER (the sentence alone would hide), but the
      // fingerprint still matches the listing's reading: the gate skips it.
      link('L-armado', {
        estoqueRecusaEm: 1_000,
        estoqueEnviadoEm: 2_000,
        estoqueRecusaMensagem: 'A Shopee recusou o estoque deste anúncio.',
        estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
        estoqueRecusaItemStatus: 'NORMAL',
        item_status: 'NORMAL',
      }),
      // NEAR-MISS: the same stale stamps, but the reading MOVED — nothing shows.
      link('L-movido', {
        item_id: 1000002,
        estoqueRecusaEm: 1_000,
        estoqueEnviadoEm: 2_000,
        estoqueRecusaMensagem: 'Recusa de outro estado.',
        estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.pausado,
        estoqueRecusaItemStatus: 'UNLIST',
        item_status: 'NORMAL',
      }),
    ];
    renderEditor();
    expect(within(bloco('L-armado')).getByText(/A Shopee recusou o estoque/)).toBeDefined();
    expect(
      within(bloco('L-armado')).getByText(/envio automático de estoque está suspenso/),
    ).toBeDefined();
    expect(within(bloco('L-movido')).queryByText('Estoque recusado')).toBeNull();
  });

  describe('the stock suspension, worded by WHICH half of the skip set is armed', () => {
    // `agoraMs` is captured when the editor mounts, so the clock is frozen
    // BEFORE the render; only `Date` is faked (no timer is involved).
    const AGORA = Date.UTC(2026, 9, 15, 15);
    const PRAZO = AGORA + 60_000;
    /** A clean send NEWER than the refusal: the sentence alone would hide it. */
    const superada = { estoqueRecusaEm: AGORA - 120_000, estoqueEnviadoEm: AGORA - 60_000 };
    const impressao = {
      estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
      estoqueRecusaItemStatus: 'NORMAL',
      item_status: 'NORMAL',
    };

    beforeEach(() => {
      vi.useFakeTimers({ now: AGORA, toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('TIME only: suspended until the deadline, never "it comes back when the listing changes"', () => {
      h.links = [
        link('L-tempo', { ...superada, estoqueRecusaAte: PRAZO }),
        // NEAR-MISS: a deadline one millisecond ago no longer holds anything.
        link('L-vencido', { ...superada, item_id: 1000002, estoqueRecusaAte: AGORA - 1 }),
        // NEAR-MISS: the exact instant already releases (strict `<`).
        link('L-exato', { ...superada, item_id: 1000003, estoqueRecusaAte: AGORA }),
      ];
      renderEditor();
      const b = within(bloco('L-tempo'));
      expect(b.getByText('Estoque recusado')).toBeDefined();
      expect(
        b.getByText(
          `O envio automático de estoque está suspenso para este anúncio até ${formatarInstanteShopee(PRAZO)!}.`,
        ),
      ).toBeDefined();
      expect(b.queryByText(/neste mesmo estado/)).toBeNull();
      expect(b.queryByText(/quando o anúncio mudar/)).toBeNull();
      for (const id of ['L-vencido', 'L-exato']) {
        expect(within(bloco(id)).queryByText('Estoque recusado')).toBeNull();
        expect(within(bloco(id)).queryByText(/suspenso/)).toBeNull();
      }
    });

    it('both halves: until the deadline, and after it until the listing changes', () => {
      h.links = [link('L-ambos', { ...superada, ...impressao, estoqueRecusaAte: PRAZO })];
      renderEditor();
      expect(
        within(bloco('L-ambos')).getByText(
          `O envio automático de estoque está suspenso para este anúncio até ${formatarInstanteShopee(PRAZO)!}; depois disso, como a Shopee já o recusou neste mesmo estado, só volta quando o anúncio mudar.`,
        ),
      ).toBeDefined();
    });

    it('STATE only: a deadline already past is not printed as what holds it', () => {
      h.links = [link('L-estado', { ...superada, ...impressao, estoqueRecusaAte: AGORA - 1 })];
      renderEditor();
      const b = within(bloco('L-estado'));
      expect(
        b.getByText(
          'O envio automático de estoque está suspenso para este anúncio: a Shopee já o recusou neste mesmo estado. Ele volta quando o anúncio mudar.',
        ),
      ).toBeDefined();
      expect(b.queryByText(/Prazo registrado|até /)).toBeNull();
    });
  });

  it('lists the violations, a legacy row as a duration and never a date', () => {
    h.links = [
      link('L1', {
        violacoesLidasEm: Date.UTC(2026, 9, 2, 3),
        violations: [
          {
            kind: 'deboost',
            violation_type: 'Imagem de baixa qualidade',
            violation_reason: 'A foto principal está desfocada.',
            suggestion: 'Envie uma foto nítida.',
            fix_deadline_time: Date.UTC(2026, 9, 10, 3),
            suggested_category: [{ category_id: 100088, category_name: 'Regatas' }],
            days_to_fix: null,
          },
          { violation_type: 'Registro antigo', days_to_fix: 3 },
        ],
      }),
    ];
    renderEditor();
    const b = within(bloco('L1'));
    expect(b.getByText('Rebaixamento')).toBeDefined();
    expect(b.getByText('A foto principal está desfocada.')).toBeDefined();
    expect(b.getByText('Categorias sugeridas: Regatas')).toBeDefined();
    expect(b.getByText('Corrigir até 10/10/2026, 00:00')).toBeDefined();
    expect(b.getByText('prazo: 3 dias (registro antigo)')).toBeDefined();
    expect(b.getByText('Desde 02/10/2026, 00:00')).toBeDefined();
  });

  it('says when a scheduled publish failed, without inventing a reason', () => {
    h.links = [link('L1', { agendamentoFalhouEm: Date.UTC(2026, 9, 3, 15) })];
    renderEditor();
    expect(
      within(bloco('L1')).getByText(
        'Uma publicação agendada falhou em 03/10/2026, 12:00 — a Shopee não informa o motivo.',
      ),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — the size chart a listing resolves to', () => {
  it('names the template entry of the listing’s conta and category, and says why there is none', () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = {
      nome: 'Camisetas adulto',
      tabelasMedidasShopee: {
        'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
      },
    };
    h.links = [
      link('L-com', { category_id: 100087 }),
      link('L-sem', { item_id: 1000002, category_id: 100088 }),
    ];
    renderEditor();
    expect(
      within(bloco('L-com')).getByText(/modelo #700024639 \(categoria «Camisetas»\)/),
    ).toBeDefined();
    expect(within(bloco('L-sem')).getByText(/não tem modelo para a categoria/)).toBeDefined();
    expect(
      within(bloco('L-com'))
        .getByRole('link', { name: /Abrir tabela/ })
        .getAttribute('href'),
    ).toBe('/medidas/tm-1');
    expect(h.tabMediIds).toEqual(['tm-1']);
  });

  it.each([
    ['another collection', 'documents/produtos/tm-1'],
    ['another collection, bare form', 'categorias/tm-1'],
    ['a bare id (no collection)', 'tm-1'],
    ['a subcollection below a tabela', 'documents/tabMedi/tm-1/fotos/f-1'],
    ['a relative-path id', 'documents/tabMedi/..'],
  ])(
    'reads NO tabela for a ref publish would not resolve (%s) — the shared rule, not the last segment',
    (_rotulo, ref) => {
      h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: ref };
      // Present on purpose: reading `tabMedi/<last segment>` would find it.
      h.tabMedi = {
        nome: 'Camisetas adulto',
        tabelasMedidasShopee: {
          'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
        },
      };
      h.links = [link('L1', { category_id: 100087 })];
      renderEditor();
      expect(h.tabMediIds).toEqual([]);
      expect(
        within(bloco('L1')).getByText(
          `Tabela de medidas: o produto aponta para algo que não é uma tabela de medidas (${ref}).`,
        ),
      ).toBeDefined();
      expect(within(bloco('L1')).queryByText(/modelo #/)).toBeNull();
    },
  );

  it('NEAR-MISS: the bare `tabMedi/<id>` form resolves to the same tabela as the canonical one', () => {
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'tabMedi/tm-1' };
    h.tabMedi = {
      nome: 'Camisetas adulto',
      tabelasMedidasShopee: {
        'int-1': [{ categoryId: 100087, size_chart_id: 700024639, name: 'Camisetas' }],
      },
    };
    h.links = [link('L1', { category_id: 100087 })];
    renderEditor();
    expect(h.tabMediIds).toEqual(['tm-1']);
    expect(within(bloco('L1')).getByText(/modelo #700024639/)).toBeDefined();
  });

  it('says the produto has no tabela when it names none', () => {
    h.links = [link('L1')];
    renderEditor();
    expect(within(bloco('L1')).getByText(/o produto não tem tabela de medidas/)).toBeDefined();
  });
});

describe('ShopeeEditor — the models, read only on demand', () => {
  it('reads nothing until "Ver variações", then lists only THIS listing’s models', async () => {
    h.links = [link('L1', { precoEnviadoEm: 1_000 }), link('L2', { item_id: 1000002 })];
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [
      {
        id: 'v-l1',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L1',
          model_id: 2000001,
          model_status: SHOPEE_MODEL_STATUS.normal,
          precoEnviado: 49.9,
          precoRecusaEm: 2_000,
          precoRecusaCodigo: 'error_price_too_low',
        },
      },
      {
        // The SAME child's model on the OTHER listing — never under L1.
        id: 'v-l2',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L2',
          model_id: 2000002,
        },
      },
    ]);
    renderEditor();
    expect(h.getDocs).not.toHaveBeenCalled();

    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    const tabela = await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    const t = within(tabela);
    expect(t.getByText('Camiseta P')).toBeDefined();
    expect(t.getByText('2000001')).toBeDefined();
    expect(t.queryByText('2000002')).toBeNull();
    expect(t.getByText('Disponível')).toBeDefined();
    // The model's refusal is newer than both success stamps: it shows.
    expect(t.getByText('Recusado (error_price_too_low)')).toBeDefined();
    // Each child read by its own path, never a collection-group query.
    expect(h.getDocs).toHaveBeenCalledWith(expect.objectContaining({ produtoId: 'f1' }));
  });

  it('bounds each model refusal by the stamps the shared readers name — its own AND the listing’s', async () => {
    h.links = [link('L1', { precoEnviadoEm: 1_000, estoqueEnviadoEm: 1_000 })];
    const L1 = 'documents/produtos/prod-1/prodshopee/L1';
    h.filhos = [
      { id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } },
      { id: 'f2', data: { nome: 'Camiseta M', paiId: 'prod-1' } },
      { id: 'f3', data: { nome: 'Camiseta G', paiId: 'prod-1' } },
    ];
    // f1 — both refusals NEWER than every stamp: both cells show "Recusado".
    h.varLinks.set('f1', [
      {
        id: 'v-f1',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000001,
          precoRecusaEm: 2_000,
          precoRecusaCodigo: 'error_price_too_low',
          estoqueRecusaEm: 1_500,
          estoqueRecusaCodigo: 'error_estoque',
        },
      },
    ]);
    // f2 — NEAR-MISS on the LISTING's stamps: each refusal 1 ms older than the
    // listing's clean send, no stamp of its own. Both hide.
    h.varLinks.set('f2', [
      {
        id: 'v-f2',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000003,
          precoEnviado: 39.9,
          precoRecusaEm: 999,
          precoRecusaCodigo: 'error_anchor_item',
          estoqueRecusaEm: 999,
          estoqueRecusaCodigo: 'error_estoque_velho',
        },
      },
    ]);
    // f3 — NEAR-MISS on the model's OWN price stamp (newer than the listing's,
    // so only its own hides it); its stock refusal TIES the listing's send,
    // and a tie shows.
    h.varLinks.set('f3', [
      {
        id: 'v-f3',
        data: {
          produtoShopeeOuterRef: L1,
          model_id: 2000004,
          precoEnviado: 29.9,
          precoRecusaEm: 2_000,
          precoEnviadoEm: 2_001,
          precoRecusaCodigo: 'error_anchor_modelo',
          estoqueRecusaEm: 1_000,
          estoqueRecusaCodigo: 'error_estoque_empate',
        },
      },
    ]);
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    const tabela = await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    /** [Variação, Modelo, Situação, Estoque, Preço] of one child's row. */
    const celulas = (nome: string) =>
      within(within(tabela).getByText(nome).closest('tr')!)
        .getAllByRole('cell')
        .map((c) => c.textContent);

    expect(celulas('Camiseta P').slice(3)).toEqual([
      'Recusado (error_estoque)',
      'Recusado (error_price_too_low)',
    ]);
    expect(celulas('Camiseta M').slice(3)).toEqual(['—', formatReais(39.9)]);
    expect(celulas('Camiseta G').slice(3)).toEqual([
      'Recusado (error_estoque_empate)',
      formatReais(29.9),
    ]);
  });
});

describe('ShopeeEditor — the models read never answers from a truncated page', () => {
  const L1 = 'documents/produtos/prod-1/prodshopee/L1';
  /** `n` rows of OTHER listings, ids sorting before `v-zz` (the key order a real read returns). */
  const deOutros = (n: number): Linha[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `v-${String(i).padStart(4, '0')}`,
      data: {
        produtoShopeeOuterRef: `documents/produtos/prod-1/prodshopee/L-outro-${String(i)}`,
        model_id: 3000000 + i,
      },
    }));
  const doL1 = (modelId: number): Linha => ({
    id: 'v-zz',
    data: { produtoShopeeOuterRef: L1, model_id: modelId },
  });

  async function abrirModelosDeL1() {
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    return within(await waitFor(() => screen.getByTestId('shopee-modelos-L1')));
  }

  beforeEach(() => {
    h.links = [link('L1')];
  });

  it('shows THIS listing’s model even when other listings’ rows fill the first 50 — the old bound', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [...deOutros(60), doL1(2000001)]);
    const t = await abrirModelosDeL1();
    expect(t.getByText('2000001')).toBeDefined();
    expect(screen.queryByTestId('shopee-modelos-truncado-L1')).toBeNull();
    // One read per child, by its path — not one per page.
    expect(h.getDocs).toHaveBeenCalledTimes(1);
  });

  it('says a child’s read stopped at the bound — beside the rows it did find', async () => {
    h.filhos = [
      { id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } },
      { id: 'f2', data: { nome: 'Camiseta M', paiId: 'prod-1' } },
    ];
    // f1: past the bound, this listing's row beyond what is read.
    h.varLinks.set('f1', [...deOutros(MAX_MODELOS_POR_FILHO + 1), doL1(2000001)]);
    h.varLinks.set('f2', [doL1(2000002)]);
    const t = await abrirModelosDeL1();
    expect(t.getByText('2000002')).toBeDefined();
    const aviso = screen.getByTestId('shopee-modelos-truncado-L1');
    expect(aviso.textContent).toContain(`mais de ${String(MAX_MODELOS_POR_FILHO)} registros`);
    expect(aviso.textContent).toContain('Camiseta P');
    expect(aviso.textContent).not.toContain('Camiseta M');
  });

  it('never answers "no linked variation" from a read that stopped at the bound', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [...deOutros(MAX_MODELOS_POR_FILHO + 1), doL1(2000001)]);
    const t = await abrirModelosDeL1();
    expect(screen.getByTestId('shopee-modelos-truncado-L1')).toBeDefined();
    expect(t.queryByText(/Nenhuma variação deste produto está vinculada/)).toBeNull();
    expect(t.getByText('Nenhuma das variações lidas está vinculada a este anúncio.')).toBeDefined();
  });

  it('NEAR-MISS: exactly the bound is a COMPLETE read — no notice, and "none linked" is the truth', async () => {
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', deOutros(MAX_MODELOS_POR_FILHO));
    const t = await abrirModelosDeL1();
    expect(screen.queryByTestId('shopee-modelos-truncado-L1')).toBeNull();
    expect(
      t.getByText('Nenhuma variação deste produto está vinculada a este anúncio.'),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — what it does not read', () => {
  it('sends a variation child to its parent and reads no listing', () => {
    h.produto = { nome: 'Camiseta P', paiId: 'pai-1' };
    h.links = [link('L1')];
    renderEditor();
    expect(screen.getByText(/Os anúncios da Shopee ficam no produto pai/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Abrir o produto pai' }).getAttribute('href')).toBe(
      '/produtos/pai-1/editar',
    );
    expect(screen.queryByTestId('shopee-anuncio-L1')).toBeNull();
    // Not merely hidden: the child's listing subcollection is never queried.
    expect(h.consultas.has('prodshopee')).toBe(false);
  });

  it('calls a produto a child by the publish dispatcher’s rule: a blank paiId is a child, an empty one a root', () => {
    // `' '` — the dispatcher refuses its Republicar as `produto-e-filho`, so the
    // tab must not offer it as a root (a trim would).
    h.produto = { nome: 'Camiseta P', paiId: ' ' };
    h.links = [link('L1')];
    const { unmount } = renderEditor();
    expect(screen.getByTestId('shopee-variacao-filha')).toBeDefined();
    expect(h.consultas.has('prodshopee')).toBe(false);
    unmount();

    // NEAR-MISS: `''` is a root for every server rule — the links are read.
    h.produto = { nome: 'Camiseta', paiId: '' };
    h.consultas = new Set();
    renderEditor();
    expect(screen.queryByTestId('shopee-variacao-filha')).toBeNull();
    expect(h.consultas.has('prodshopee')).toBe(true);
    expect(bloco('L1')).toBeDefined();
  });

  it('asks for the integrações read permission instead of hitting a permission-denied', () => {
    h.permitidos = new Set();
    h.links = [link('L1')];
    renderEditor();
    expect(screen.getByText(/Requer permissão de leitura em integrações/)).toBeDefined();
    expect(screen.queryByTestId('shopee-anuncio-L1')).toBeNull();
  });
});

describe('ShopeeEditor — a non-persistent section (rule R1)', () => {
  it('keeps the selected conta while a re-listen is loading — the spinner gates on data, not on loading', () => {
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.links = [link('L1'), link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' })];
    const { rerender } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');

    // What `<Activity>` re-showing the section looks like: the listeners
    // re-subscribe and report `{ data: prev, loading: true }`.
    h.carregando = true;
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(painel('int-2')).getByTestId('shopee-anuncio-L2')).toBeDefined();
  });

  it('(k) keeps the selected conta AND a refused publish’s rows while a re-listen is loading (R1 + R2)', async () => {
    comEscrita();
    h.contas = [conta('int-1', 'Loja A'), conta('int-2', 'Loja B')];
    h.links = [link('L1'), link('L2', { contaProdutoShopeeOuterRef: 'integracao/int-2' })];
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          recusa422([
            {
              campo: null,
              motivo: 'categoria-invalida',
              mensagem: 'A categoria 100087 não aceita este atributo.',
              acao: null,
            },
          ]),
        ),
    });
    const { rerender } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    fireEvent.click(botao('L2', 'Republicar'));
    await waitFor(() =>
      expect(
        within(bloco('L2')).getByText('A categoria 100087 não aceita este atributo.'),
      ).toBeDefined(),
    );

    h.carregando = true;
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(screen.getByRole('tab', { name: /Loja B/ }).getAttribute('aria-selected')).toBe('true');
    expect(
      within(bloco('L2')).getByText('A categoria 100087 não aceita este atributo.'),
    ).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                    PR 7 — the actions on an existing link                   */
/* -------------------------------------------------------------------------- */

const TIPO = TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE;

/** The operator holds `integracao.write` — every action route's bit. */
function comEscrita() {
  h.permitidos = new Set([PERM.integracao.read, PERM.integracao.write]);
}

const botao = (linkDocId: string, nome: string) =>
  within(bloco(linkDocId)).getByRole('button', { name: nome });
const semBotao = (linkDocId: string, nome: string | RegExp) =>
  within(bloco(linkDocId)).queryByRole('button', { name: nome });

/**
 * The operator holds BOTH bits a draft needs (D6): `integracao.write` (the
 * route's) and `produto.write` (the draft is produto content).
 */
function comAutoria() {
  h.permitidos = new Set([PERM.integracao.read, PERM.integracao.write, PERM.produto.write]);
}

/** A category's item bands — `limitesDoItem`'s whole envelope. */
function limitesDoItem(categoryId: number | null): RespostaLimitesDoItemShopee {
  const faixa = (min: number, max: number) => ({ min, max });
  return {
    scope: categoryId === null ? 'shop' : 'category',
    categoryId,
    limites: {
      priceLimit: null,
      wholesalePriceThresholdPercentage: null,
      stockLimit: null,
      // Per category, so a test can tell WHICH category's bands a form got.
      itemNameLengthLimit: faixa(20, categoryId === null ? 120 : 100 + (categoryId % 50)),
      itemImageCountLimit: null,
      itemDescriptionLengthLimit: faixa(100, 5000),
      tierVariationNameLengthLimit: null,
      tierVariationOptionLengthLimit: null,
      itemCountLimit: null,
      extendedDescriptionLimit: null,
      dtsLimit: null,
      weightLimit: null,
      dimensionLimit: null,
      sizeChartLimit: null,
    },
    gtinLimit: null,
    supportsPreOrder: false,
  };
}

/**
 * A category's attribute tree — `client.atributos`' whole answer (#1911 P13):
 * a leaf, healthy, complete, holding `atributos` (none by default).
 */
function respostaAtributos(
  categoryId: number,
  atributos: AtributoDto[] = [],
  extra: Partial<RespostaAtributosShopee> = {},
): RespostaAtributosShopee {
  return { leaf: true, categoryId, warning: null, truncated: false, atributos, ...extra };
}

/** Every button a block's action row can hold — what a never-folded live link shows. */
const BOTOES_DO_BLOCO = ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio'];
/**
 * The sentence a draft link showed before #1911 P10 (the constant is gone) —
 * spelled here only so the tripwire can say it never comes back.
 */
const FRASE_PRIMEIRA_PUBLICACAO_ANTIGA =
  'Primeira publicação: chega na etapa de autoria do anúncio.';
const FRASE_ITEM_ID_INVALIDO =
  'O código do anúncio guardado neste vínculo é inválido — nenhuma ação disponível.';

/** The pause/reactivate run's 200, for ONE listing — shaped like `anuncio-status/route.ts`'s. */
function respostaStatus(
  linkDocId: string,
  mensagem: string,
  extra: Partial<AnuncioStatusShopee> = {},
): AnuncioStatusShopee {
  return {
    canal: 'shopee',
    integracaoId: 'int-1',
    acao: ACAO_STATUS_ANUNCIO.pausar,
    listings: [
      {
        produtoId: 'prod-1',
        produtoNome: 'Camiseta',
        anuncioId: '1000002',
        linkDocId,
        outcome: 'enviado',
        motivo: null,
        mensagem,
        statusFinal: 'UNLIST',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      },
    ],
    produtosSemAnuncio: [],
    pausadoAte: null,
    ...extra,
  };
}

/** An ordinary listing's republish 200. */
const ITEM_REPUBLICADO: RespostaPublicarShopee = {
  tipo: 'item',
  itemId: 1000001,
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
  itemStatus: 'NORMAL',
  modelos: { total: 0, criados: 0, atualizados: 0, semFilho: 0 },
  fotos: { reutilizadas: 3, enviadas: 1, falhas: 0 },
  avisoShopee: null,
  taxInfoOmitido: null,
  tabelaDeMedidas: {
    sizeChartId: 700024639,
    fonte: 'modelo',
    motivo: null,
    fotoOmitida: null,
    avisoObrigatoria: false,
  },
};

function reverificado(extra: Partial<RespostaReverificarShopee> = {}): RespostaReverificarShopee {
  return {
    acao: 'atualizado',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    deboost: false,
    violacoes: [],
    violacoesLidas: true,
    modelos: null,
    avisoResolvido: false,
    avisoReceitaKit: null,
    ...extra,
  };
}

/** A publish 422 the client built from the body (its `detalhes.problemas`). */
function recusa422(
  problemas: ProblemaShopee[],
  code: string = CODIGO_FALHA_SHOPEE.publicacaoBloqueada,
): ShopeeClientHttpError {
  return new ShopeeClientHttpError(
    `Publicação bloqueada no produto prod-1: ${String(problemas.length)} problema(s)`,
    422,
    code,
    null,
    null,
    { ...DETALHES_ERRO_SHOPEE_VAZIOS, problemas },
  );
}

/** CLI copy — a flag, a script name or the word — must never reach the page (lens 8). */
const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;

/**
 * A failed ID-token refresh as the SDK REALLY builds it — English and
 * developer-shaped (`@firebase/util`'s `${service}: ${message} (${code}).`) —
 * never a pt-BR fixture message a test could assert back (#1911 review G1).
 */
const SESSAO_SEM_REDE = new FirebaseError(
  'auth/network-request-failed',
  'Firebase: Error (auth/network-request-failed).',
);
const SESSAO_EXPIRADA = new FirebaseError(
  'auth/user-token-expired',
  'Firebase: Error (auth/user-token-expired).',
);

describe('ShopeeEditor — pause and reactivate (podeMoverAnuncioShopee)', () => {
  it('(c) offers Pausar on a never-folded listing (estadoAnuncio null) and no status control on a removed one', () => {
    comEscrita();
    h.links = [
      link('L-nulo', { estadoAnuncio: null }),
      link('L-removido', { item_id: 1000002, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ];
    renderEditor();
    // A missing reading is not evidence of anything: movable BOTH ways.
    expect(botao('L-nulo', 'Pausar anúncio')).toBeDefined();
    expect(botao('L-nulo', 'Reativar anúncio')).toBeDefined();
    // Positive first: the removed block rendered.
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
    expect(semBotao('L-removido', 'Pausar anúncio')).toBeNull();
    expect(semBotao('L-removido', 'Reativar anúncio')).toBeNull();
  });

  it('(d) confirms a pause, then sends it for THAT listing, named by its link id', async () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(async () =>
      respostaStatus('L2', 'Anúncio pausado na Shopee.'),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1'), link('L2', { item_id: 1000002 })];
    renderEditor();

    fireEvent.click(botao('L2', 'Pausar anúncio'));
    const dialogo = screen.getByRole('dialog', { name: 'Pausar anúncio' });
    // A pause stops a live sale: nothing is sent before the confirmation.
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Pausar' }));

    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Anúncio pausado na Shopee.')).toBeDefined(),
    );
    expect(definirStatusAnuncios).toHaveBeenCalledTimes(1);
    expect(definirStatusAnuncios.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: ACAO_STATUS_ANUNCIO.pausar,
      linkDocId: 'L2',
    });
    expect(within(bloco('L1')).queryByText('Anúncio pausado na Shopee.')).toBeNull();
  });

  it('a failed ID-token refresh ends a confirmed pause WITH an outcome, never in silence', async () => {
    comEscrita();
    // `getAuthToken()` runs outside the client's try: the rejection is the raw
    // Firebase Auth error, none of the client's classes — and nothing was sent.
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(() =>
      Promise.reject(SESSAO_SEM_REDE),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    renderEditor();

    fireEvent.click(botao('L1', 'Pausar anúncio'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Pausar',
      }),
    );

    const desfecho = await waitFor(() => screen.getByTestId('shopee-desfecho-L1'));
    // pt-BR by its code (`fraseDaSessaoShopee`, the draft writes' sentence) —
    // never the SDK's English `err.message` (#1911 review R8-copy#14 / G1).
    expect(within(desfecho).getByText(FRASE_SESSAO_SEM_CONEXAO_SHOPEE)).toBeDefined();
    expect(desfecho.textContent).not.toMatch(/Firebase/);
    expect(definirStatusAnuncios).toHaveBeenCalledTimes(1);
    // The lock is released: the operator can try again.
    expect(botao('L1', 'Pausar anúncio').hasAttribute('disabled')).toBe(false);
  });

  it('NEAR-MISS: any OTHER auth code on a re-verify asks for a new sign-in — never the «sem conexão» retry, never the SDK’s English', async () => {
    comEscrita();
    h.client = shopeeClientFalso({ reverificarAnuncio: () => Promise.reject(SESSAO_EXPIRADA) });
    h.links = [link('L1')];
    renderEditor();
    fireEvent.click(botao('L1', 'Reverificar'));
    const desfecho = await waitFor(() => screen.getByTestId('shopee-desfecho-L1'));
    expect(within(desfecho).getByText(FRASE_SESSAO_NAO_RENOVADA_SHOPEE)).toBeDefined();
    expect(within(desfecho).queryByText(FRASE_SESSAO_SEM_CONEXAO_SHOPEE)).toBeNull();
    expect(desfecho.textContent).not.toMatch(/Firebase|user-token-expired/);
  });

  it('a pause confirmation cannot send once its link was rewritten with an id no listing has', () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>();
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    const { rerender } = renderEditor();
    fireEvent.click(botao('L1', 'Pausar anúncio'));
    const confirmar = () =>
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Pausar',
      });
    // NEAR-MISS first: as opened, on an addressable link, the confirmation can send.
    expect(confirmar().hasAttribute('disabled')).toBe(false);

    // The live snapshot repaints while the dialog is open.
    h.links = [link('L1', { item_id: 1.5 })];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(confirmar().hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmar());
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
  });

  it('sends nothing when the pause is cancelled', () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>();
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [link('L1')];
    renderEditor();
    fireEvent.click(botao('L1', 'Pausar anúncio'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Pausar anúncio' })).getByRole('button', {
        name: 'Cancelar',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Pausar anúncio' })).toBeNull();
    expect(definirStatusAnuncios).not.toHaveBeenCalled();
  });

  it('reactivates a paused listing at once, and says until when the daily quota stopped the run', async () => {
    comEscrita();
    const definirStatusAnuncios = vi.fn<ShopeeClient['definirStatusAnuncios']>(async () =>
      respostaStatus('L-pausado', 'A Shopee ainda não reativou o anúncio.', {
        acao: ACAO_STATUS_ANUNCIO.reativar,
        // 03:00Z is São Paulo's midnight.
        pausadoAte: '2026-10-15T03:00:00.000Z',
      }),
    );
    h.client = shopeeClientFalso({ definirStatusAnuncios });
    h.links = [
      link('L-pausado', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado, pausadoPeloErp: true }),
    ];
    renderEditor();
    expect(semBotao('L-pausado', 'Pausar anúncio')).toBeNull();
    fireEvent.click(botao('L-pausado', 'Reativar anúncio'));

    await waitFor(() =>
      expect(
        within(bloco('L-pausado')).getByText(
          'Cota diária da Shopee esgotada até 15/10/2026, 00:00.',
        ),
      ).toBeDefined(),
    );
    expect(
      within(bloco('L-pausado')).getByText('A Shopee ainda não reativou o anúncio.'),
    ).toBeDefined();
    expect(definirStatusAnuncios.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: ACAO_STATUS_ANUNCIO.reativar,
      linkDocId: 'L-pausado',
    });
  });
});

describe('ShopeeEditor — republish an existing link, never a first publish', () => {
  it('(e) republishes a live listing by its link with no kit option, and offers none on a superseded or removed one', async () => {
    comEscrita();
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L-vivo'),
      link('L-subst', { item_id: 1000002, substituidoPorLinkDocId: 'L-vivo' }),
      link('L-removido', { item_id: 1000003, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ];
    renderEditor();

    // Positive first, then the absence: each block rendered its state.
    expect(within(bloco('L-subst')).getByText(/Substituído pelo vínculo L-vivo/)).toBeDefined();
    expect(semBotao('L-subst', 'Republicar')).toBeNull();
    // A superseded kit whose delete did not take is still worth re-reading.
    expect(botao('L-subst', 'Reverificar')).toBeDefined();
    expect(within(bloco('L-removido')).getByText('Removido')).toBeDefined();
    expect(semBotao('L-removido', 'Republicar')).toBeNull();

    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() =>
      expect(within(bloco('L-vivo')).getByText('Anúncio republicado na Shopee')).toBeDefined(),
    );
    // EXACTLY the three keys: no `recriar`, no `converterEmKit`, no `principal`
    // (the T5 (f) half this PR owns — the kit arms are not on this button).
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-vivo',
    });
    expect(
      within(bloco('L-vivo')).getByText('Tabela de medidas: modelo #700024639.'),
    ).toBeDefined();
  });

  it('(n) a draft link — with or without a category — gets its OWN buttons (Salvar rascunho / Descartar / Publicar), never the old sentence; a published sibling keeps Republicar and no Publicar', () => {
    comAutoria();
    h.client = shopeeClientFalso({ limitesDoItem: async () => limitesDoItem(100087) });
    h.links = [
      link('L-rasc', { item_id: null, estadoAnuncio: null, category_id: null }),
      link('L-rasc-cat', { item_id: null, estadoAnuncio: null, category_id: 100087 }),
      link('L-pub', { item_id: 1000003 }),
    ];
    renderEditor();
    for (const id of ['L-rasc', 'L-rasc-cat']) {
      // The sentence half INVERTED (#1911 P10): the draft has its editor.
      expect(within(bloco(id)).getByTestId(`shopee-rascunho-${id}`)).toBeDefined();
      expect(botao(id, 'Salvar rascunho')).toBeDefined();
      expect(botao(id, 'Descartar')).toBeDefined();
      expect(within(bloco(id)).queryByText(FRASE_PRIMEIRA_PUBLICACAO_ANTIGA)).toBeNull();
      // The `/Publicar/` half INVERTED on purpose (#1911 P11, K2-3): a draft
      // block offers ITS «Publicar» — never the live row's Republicar.
      expect(botao(id, ROTULO_PUBLICAR_RASCUNHO_SHOPEE)).toBeDefined();
      expect(semBotao(id, 'Republicar')).toBeNull();
      expect(semBotao(id, 'Pausar anúncio')).toBeNull();
      expect(semBotao(id, 'Reverificar')).toBeNull();
    }
    expect(botao('L-pub', 'Republicar')).toBeDefined();
    expect(within(bloco('L-pub')).queryByTestId('shopee-rascunho-L-pub')).toBeNull();
    expect(semBotao('L-pub', 'Salvar rascunho')).toBeNull();
    // Case-sensitive: "Republicar" does not match; a draft's button would.
    expect(semBotao('L-pub', /Publicar/)).toBeNull();
  });

  it('NEAR-MISS: a native-kit link with NO item_id is not a draft — "código inválido", no editor, no button', () => {
    comAutoria();
    h.links = [
      link('L-kit-sem-id', { item_id: null, kitNativo: true, estadoAnuncio: null }),
      // Its pair: the same link without `kitNativo` IS a draft.
      link('L-rasc', { item_id: null, estadoAnuncio: null, category_id: null }),
    ];
    renderEditor();
    expect(within(bloco('L-kit-sem-id')).getByText(FRASE_ITEM_ID_INVALIDO)).toBeDefined();
    expect(within(bloco('L-kit-sem-id')).queryByTestId('shopee-rascunho-L-kit-sem-id')).toBeNull();
    for (const nome of [...BOTOES_DO_BLOCO, 'Salvar rascunho', 'Descartar']) {
      expect(semBotao('L-kit-sem-id', nome), nome).toBeNull();
    }
    expect(within(bloco('L-rasc')).getByTestId('shopee-rascunho-L-rasc')).toBeDefined();
    expect(within(bloco('L-rasc')).queryByText(FRASE_ITEM_ID_INVALIDO)).toBeNull();
  });

  it('the action row ITSELF asks `ehRascunhoShopee`: a draft renders nothing there ⟷ NEAR-MISS a native-kit link with no item_id says "código inválido"', () => {
    // Rendered directly: inside the tab the editor's one gate never hands a
    // draft to this row, so only here can its own draft branch be seen.
    const acoesComTudo: AcoesShopee = {
      permitidas: true,
      bloqueadas: false,
      emVoo: null,
      desfechoDe: () => null,
      enderecavel: () => true,
      pedirPausa: vi.fn(),
      reativar: vi.fn(),
      reverificar: vi.fn(),
      republicar: vi.fn(),
      abrirKit: vi.fn(),
      incertoDe: () => null,
      repetirKit: vi.fn(),
      kitAberto: () => false,
      alternarKit: vi.fn(),
    };
    const linha = (id: string, extra: Record<string, unknown>) =>
      link(id, { estadoAnuncio: null, ...extra }).data as ProdutoShopeeLink;
    const linhaDeAcoes = (l: ProdutoShopeeLink) =>
      render(
        <MantineTestProvider>
          <div data-testid="linha-de-acoes">
            <AcoesAnuncioShopee contaId="int-1" linkDocId="L-x" link={l} acoes={acoesComTudo} />
          </div>
        </MantineTestProvider>,
      );

    const { unmount } = linhaDeAcoes(linha('L-rasc', { item_id: null }));
    expect(screen.getByTestId('linha-de-acoes').textContent).toBe('');
    unmount();

    linhaDeAcoes(linha('L-kit-sem-id', { item_id: null, kitNativo: true }));
    expect(
      within(screen.getByTestId('linha-de-acoes')).getByText(FRASE_ITEM_ID_INVALIDO),
    ).toBeDefined();
    expect(within(screen.getByTestId('linha-de-acoes')).queryAllByRole('button')).toEqual([]);
  });

  it('NEAR-MISS: an item id that is present but addresses no listing (0, a quoted number) gets no button at all', () => {
    comEscrita();
    // A parsed link can carry 0 (`z.number().int()`), and a soft-read hands the
    // raw document over, so a stringified id reaches the block as it is.
    h.links = [
      link('L-zero', { item_id: 0, estadoAnuncio: null }),
      link('L-texto', { item_id: '1000001', estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-zero', 'L-texto']) {
      // Positive first: the block rendered, as an unpublished listing.
      expect(within(bloco(id)).getByText('Não publicado')).toBeDefined();
      expect(within(bloco(id)).getByText(FRASE_ITEM_ID_INVALIDO)).toBeDefined();
      expect(semBotao(id, 'Reverificar'), id).toBeNull();
      expect(semBotao(id, /Publicar/), id).toBeNull();
      expect(semBotao(id, 'Pausar anúncio'), id).toBeNull();
      expect(semBotao(id, 'Reativar anúncio'), id).toBeNull();
    }
  });

  it('offers NO button on an id the schemas predicates pass but no listing has (a fraction, 2^53, a negative), and says so — never as a draft', () => {
    // Both bits: a draft editor wrongly shown here WOULD render its buttons.
    comAutoria();
    // Never folded and not superseded: `podeMoverAnuncioShopee` (both ways) and
    // `anuncioShopeeVivo` test `isFinite` only, so for the first two ids every
    // one of them says yes — the block's own gate is what refuses.
    h.links = [
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
      link('L-2e53', { item_id: 2 ** 53, estadoAnuncio: null }),
      link('L-negativo', { item_id: -1000001, estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-fracao', 'L-2e53', 'L-negativo']) {
      // Positive first: the block rendered, and says why it offers nothing.
      expect(within(bloco(id)).getByText('Não publicado')).toBeDefined();
      expect(within(bloco(id)).getByText(FRASE_ITEM_ID_INVALIDO)).toBeDefined();
      // It is not a draft: no draft editor, none of its buttons (re-anchored
      // from the old sentence, which no longer exists — #1911 P10).
      expect(within(bloco(id)).queryByTestId(`shopee-rascunho-${id}`)).toBeNull();
      expect(semBotao(id, 'Salvar rascunho'), id).toBeNull();
      expect(semBotao(id, 'Descartar'), id).toBeNull();
      for (const nome of BOTOES_DO_BLOCO) expect(semBotao(id, nome), `${id} ${nome}`).toBeNull();
    }
  });

  it('NEAR-MISS: the ids that DO address a listing — up to Number.MAX_SAFE_INTEGER — get every button', () => {
    comEscrita();
    h.links = [
      link('L-comum', { item_id: 1000001, estadoAnuncio: null }),
      link('L-maximo', { item_id: Number.MAX_SAFE_INTEGER, estadoAnuncio: null }),
    ];
    renderEditor();
    for (const id of ['L-comum', 'L-maximo']) {
      for (const nome of BOTOES_DO_BLOCO) expect(botao(id, nome), `${id} ${nome}`).toBeDefined();
      expect(within(bloco(id)).queryByText(FRASE_ITEM_ID_INVALIDO)).toBeNull();
    }
  });

  it('(h) renders a refused publish by its acao — the button acts on the link the acao names — and never a terminal sentence', async () => {
    comEscrita();
    const problemas: ProblemaShopee[] = [
      {
        campo: 'linkDocId',
        motivo: 'vinculo-substituido',
        mensagem:
          'vínculo L1 (item 1000001): este anúncio foi substituído pelo kit nativo L2 e não é ' +
          'mais publicado pelo ERP — publique sem --link (ou com --link L2)',
        acao: { tipo: TIPO.republicar, linkDocId: 'L2' },
      },
      {
        campo: 'sku',
        motivo: 'kit-ja-existe-na-shopee',
        mensagem:
          'já existe na Shopee um kit com o SKU deste produto (item 1000009) — importe-o ' +
          '(importar:anuncio) em vez de criar outro',
        acao: { tipo: TIPO.importar, itemIds: [1000009] },
      },
      {
        // No `acao`, but written for the CLI: the tab's own motivo copy
        // replaces it (PR 8, `TEXTO_MOTIVO_KIT`; the terminal backstop stands behind).
        campo: null,
        motivo: 'instabilidade-shopee',
        mensagem:
          "a Shopee respondeu com instabilidade ('Too many connections'); a operação pode ter " +
          'sido feita — rode exatamente o mesmo comando de novo daqui a 4 minutos',
        acao: null,
      },
      {
        // A mechanism sentence with no next step: shown as it is.
        campo: 'category_id',
        motivo: 'categoria-invalida',
        mensagem: 'A categoria 100087 não aceita este atributo.',
        acao: null,
      },
    ];
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422(problemas))
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    h.client = shopeeClientFalso({ publicar });
    h.links = [link('L1'), link('L2', { item_id: 1000002, kitNativo: true })];
    renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const desfecho = await waitFor(() => screen.getByTestId('shopee-desfecho-L1'));
    const d = within(desfecho);
    // OUR 422 on a LIVE listing's Republicar — an UPDATE, whose model leg may
    // refuse after `update_item`: the title says who refused, never «nada foi
    // enviado» (review R7-roundtrip#0; the REJECTED near-miss is the it.each
    // below, «A Shopee recusou a publicação»).
    expect(d.getByText(TITULO_PUBLICACAO_BLOQUEADA_SHOPEE)).toBeDefined();
    expect(desfecho.textContent).not.toMatch(/nada foi enviado/i);
    // The motivo's own copy (PR 8), then the id the `acao` names.
    expect(
      d.getByText(`${TEXTO_MOTIVO_KIT['vinculo-substituido'] ?? '?'} Vínculo: L2.`),
    ).toBeDefined();
    expect(d.getByText(/Anúncio\(s\) na Shopee: 1000009\.$/)).toBeDefined();
    expect(d.getByText(TEXTO_MOTIVO_KIT['instabilidade-shopee'] ?? '?')).toBeDefined();
    expect(d.getByText('A categoria 100087 não aceita este atributo.')).toBeDefined();
    // The server's CLI sentences never reach the page — not as a row, not anywhere.
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);
    // `importar` points elsewhere: text, no button.
    expect(d.queryByRole('button', { name: /importa/i })).toBeNull();

    // The `republicar` button names the SUCCESSOR, never the block it sits in.
    fireEvent.click(d.getByRole('button', { name: 'Republicar o vínculo L2' }));
    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Anúncio republicado na Shopee')).toBeDefined(),
    );
    expect(publicar).toHaveBeenCalledTimes(2);
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L2',
    });
  });

  it('offers a refusal row’s button only on a LOADED link whose id addresses a listing — the row still names the rest', async () => {
    comEscrita();
    const sucessor = (linkDocId: string): ProblemaShopee => ({
      campo: 'linkDocId',
      motivo: 'vinculo-substituido',
      mensagem: `substituído pelo kit nativo ${linkDocId}`,
      acao: { tipo: TIPO.republicar, linkDocId },
    });
    const problemas: ProblemaShopee[] = [
      // A loaded link whose stored id is a fraction: `anuncioShopeeVivo` passes it.
      sucessor('L-fracao'),
      // A link this tab never loaded: its outcome would land in no block on screen.
      sucessor('L-fora'),
      // NEAR-MISS: a loaded, addressable successor keeps its button.
      sucessor('L2'),
      {
        campo: 'principal',
        motivo: 'opcao-de-kit-em-anuncio-comum',
        mensagem: 'só valem para kit nativo',
        acao: { tipo: TIPO.semOpcoesDeKit },
      },
    ];
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422(problemas));
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L1'),
      link('L2', { item_id: 1000002 }),
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
    ];
    const { rerender } = renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const d = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    // Positive first: every row is there, naming its link.
    expect(d.getByText(/Vínculo: L-fracao\.$/)).toBeDefined();
    expect(d.getByText(/Vínculo: L-fora\.$/)).toBeDefined();
    expect(d.getByRole('button', { name: 'Republicar o vínculo L2' })).toBeDefined();
    expect(d.getByRole('button', { name: 'Republicar sem as opções de kit' })).toBeDefined();
    expect(d.queryByRole('button', { name: 'Republicar o vínculo L-fracao' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Republicar o vínculo L-fora' })).toBeNull();

    // The block's OWN link rewritten with an id no listing has: the outcome
    // stays, its "republish this link" button goes — the other link's stays.
    h.links = [
      link('L1', { item_id: 1.5 }),
      link('L2', { item_id: 1000002 }),
      link('L-fracao', { item_id: 1.5, estadoAnuncio: null }),
    ];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    const depois = within(screen.getByTestId('shopee-desfecho-L1'));
    expect(depois.getByRole('button', { name: 'Republicar o vínculo L2' })).toBeDefined();
    expect(depois.queryByRole('button', { name: 'Republicar sem as opções de kit' })).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['init_tier_variation', 'criação das variações'],
    ['add_kit_item', 'criação do kit — a Shopee não criou o kit'],
    // NEAR-MISS: a step this build does not know is never printed as its code.
    ['etapa_nova_do_servidor', 'uma etapa que esta tela ainda não descreve'],
  ])(
    'says WHERE a mid-publish refusal landed (%s), never the raw step code as a channel state',
    async (etapa, rotulo) => {
      comEscrita();
      const recusa = recusa422(
        [
          {
            campo: 'model_list',
            motivo: 'modelo-recusado',
            mensagem: 'Modelo recusado.',
            acao: null,
          },
        ],
        CODIGO_FALHA_SHOPEE.publicacaoRecusada,
      );
      const comEtapa = new ShopeeClientHttpError(recusa.message, 422, recusa.code, null, null, {
        ...recusa.detalhes,
        etapa,
      });
      h.client = shopeeClientFalso({ publicar: () => Promise.reject(comEtapa) });
      h.links = [link('L1')];
      renderEditor();
      fireEvent.click(botao('L1', 'Republicar'));
      await waitFor(() =>
        expect(within(bloco('L1')).getByText(TITULO_PUBLICACAO_RECUSADA_SHOPEE)).toBeDefined(),
      );
      expect(TITULO_PUBLICACAO_RECUSADA_SHOPEE).toBe('A Shopee recusou a publicação');
      expect(
        within(bloco('L1')).getByText(
          `Recusada na etapa: ${rotulo}. Escritas anteriores podem já ter chegado à Shopee — use "Reverificar" antes de repetir.`,
        ),
      ).toBeDefined();
      expect(within(bloco('L1')).queryByText(new RegExp(etapa))).toBeNull();
      expect(within(bloco('L1')).queryByText(/Na Shopee agora/)).toBeNull();
    },
  );
});

describe('ShopeeEditor — re-verify, and one write at a time', () => {
  it('disables every write button while one write is in flight, and says what the re-verify found', async () => {
    comEscrita();
    let soltar: (r: RespostaReverificarShopee) => void = () => undefined;
    const reverificarAnuncio = vi.fn<ShopeeClient['reverificarAnuncio']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ reverificarAnuncio });
    // L2 never folded (`estadoAnuncio: null`): it shows BOTH status buttons, so
    // Reativar is held to the one-write rule too.
    h.links = [link('L1'), link('L2', { item_id: 1000002, estadoAnuncio: null })];
    renderEditor();

    fireEvent.click(botao('L1', 'Reverificar'));
    const escrita = {
      L1: ['Republicar', 'Reverificar', 'Pausar anúncio'],
      L2: ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio'],
    };
    for (const [id, nomes] of Object.entries(escrita)) {
      for (const nome of nomes) expect(botao(id, nome).hasAttribute('disabled'), nome).toBe(true);
    }
    // The spinner sits on the ONE button in flight — that listing, that action.
    expect(botao('L1', 'Reverificar').hasAttribute('data-loading')).toBe(true);
    expect(botao('L2', 'Reverificar').hasAttribute('data-loading')).toBe(false);
    expect(botao('L1', 'Pausar anúncio').hasAttribute('data-loading')).toBe(false);
    expect(reverificarAnuncio.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L1',
    });

    await act(async () => {
      soltar(reverificado({ deboost: true }));
      await Promise.resolve();
    });
    for (const [id, nomes] of Object.entries(escrita)) {
      for (const nome of nomes) expect(botao(id, nome).hasAttribute('disabled'), nome).toBe(false);
    }
    expect(h.notify).toHaveBeenCalledWith({
      color: 'green',
      title: 'Anúncio reverificado — Ativo',
      message:
        'O ERP atualizou o anúncio com o que a Shopee informa agora. Ele está rebaixado na busca.',
    });
  });

  it('re-reads the open models after a re-verify, and toasts a removal', async () => {
    comEscrita();
    h.links = [link('L1')];
    h.filhos = [{ id: 'f1', data: { nome: 'Camiseta P', paiId: 'prod-1' } }];
    h.varLinks.set('f1', [
      {
        id: 'v-l1',
        data: {
          produtoShopeeOuterRef: 'documents/produtos/prod-1/prodshopee/L1',
          model_id: 2000001,
        },
      },
    ]);
    h.client = shopeeClientFalso({
      reverificarAnuncio: async () =>
        reverificado({ acao: 'removido', estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    });
    renderEditor();
    fireEvent.click(within(bloco('L1')).getByRole('button', { name: 'Ver variações' }));
    await waitFor(() => screen.getByTestId('shopee-modelos-L1'));
    expect(h.getDocs).toHaveBeenCalledTimes(1);

    fireEvent.click(botao('L1', 'Reverificar'));
    await waitFor(() => expect(h.getDocs).toHaveBeenCalledTimes(2));
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'orange', title: 'Anúncio reverificado — Removido' }),
    );
  });

  it('says the shopee service is unreachable in the block, and a link the conta no longer holds', async () => {
    comEscrita();
    h.client = shopeeClientFalso({
      reverificarAnuncio: () =>
        Promise.reject(new ShopeeClientNetworkError('Failed to fetch', new TypeError('x'))),
      publicar: () =>
        Promise.reject(
          new ShopeeClientHttpError(
            'Nenhum anúncio desta conta.',
            404,
            CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado,
          ),
        ),
    });
    h.links = [link('L1'), link('L2', { item_id: 1000002 })];
    renderEditor();

    fireEvent.click(botao('L1', 'Reverificar'));
    await waitFor(() =>
      expect(
        within(bloco('L1')).getByText('Não foi possível contatar a integração com a Shopee.'),
      ).toBeDefined(),
    );
    expect(h.notify).not.toHaveBeenCalled();

    fireEvent.click(botao('L2', 'Republicar'));
    await waitFor(() =>
      expect(
        within(bloco('L2')).getByText(
          'Este vínculo não pertence mais a esta conta — a lista foi atualizada.',
        ),
      ).toBeDefined(),
    );
  });
});

describe('ShopeeEditor — who may act', () => {
  it('renders no action without integracao.write', () => {
    h.links = [link('L1')];
    renderEditor();
    expect(within(bloco('L1')).getByText('Ativo')).toBeDefined();
    for (const nome of ['Republicar', 'Reverificar', 'Pausar anúncio', 'Reativar anúncio']) {
      expect(semBotao('L1', nome)).toBeNull();
    }
  });

  it('disables every action on a read-only form, and while there is no client', () => {
    comEscrita();
    h.links = [link('L1'), link('L-nulo', { item_id: 1000002, estadoAnuncio: null })];
    const { unmount } = renderEditor({ disabled: true });
    expect(botao('L1', 'Republicar').hasAttribute('disabled')).toBe(true);
    expect(botao('L1', 'Pausar anúncio').hasAttribute('disabled')).toBe(true);
    // A click on an enabled Reativar here WOULD send: `executar` does not read `disabled`.
    expect(botao('L-nulo', 'Reativar anúncio').hasAttribute('disabled')).toBe(true);
    unmount();

    h.client = null;
    renderEditor();
    expect(botao('L1', 'Reverificar').hasAttribute('disabled')).toBe(true);
  });

  it('offers no action on a conta the query did not return', () => {
    comEscrita();
    h.links = [link('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();
    expect(within(bloco('L9')).getByText('Ativo')).toBeDefined();
    expect(semBotao('L9', 'Republicar')).toBeNull();
    expect(semBotao('L9', 'Pausar anúncio')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                         PR 8 — the native kit                               */
/* -------------------------------------------------------------------------- */

/** A kit produto (`ehKit`) with two sellable units — f2's lone component of quantity 1 is a warning. */
function comKit() {
  h.produto = { nome: 'Kit Camiseta', paiId: null, ehKit: true };
  h.filhos = [
    {
      id: 'f2',
      data: {
        nome: 'Kit G',
        paiId: 'prod-1',
        ordem: 1,
        componentesKit: { c2: { quantidade: 1 } },
      },
    },
    {
      id: 'f1',
      data: {
        nome: 'Kit P',
        paiId: 'prod-1',
        ordem: 0,
        componentesKit: { c1: { quantidade: 2 }, c2: { quantidade: 1 } },
      },
    },
  ];
  h.nomes = new Map([
    ['c1', 'Camiseta'],
    ['c2', 'Boné'],
  ]);
}

const linkKit = (id = 'L-kit', extra: Record<string, unknown> = {}) =>
  link(id, { item_id: 1000002, kitNativo: true, ...extra });

/** A native-kit run's 200 — shaped like `publicar/route.ts`'s kit body. */
function kitPublicado(extra: Partial<KitPublicadoShopee> = {}): RespostaPublicarShopee {
  return {
    tipo: 'kit',
    arma: 'kit-recriar',
    desfecho: 'criado',
    itemId: 1000005,
    linkDocId: 'L-kit-novo',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    itemStatus: 'NORMAL',
    kitNativo: true,
    modelos: { vinculados: 2, anexados: 2, semFilho: 0 },
    antecessor: { itemId: 1000002, linkDocId: 'L-kit', excluido: true, substituido: true },
    avisos: [],
    avisosResolvidos: 0,
    recusa: null,
    ...extra,
  };
}

/** The 202: the server could not tell whether `add_kit_item` ran. */
function kitIncerto(extra: Partial<KitPublicadoShopee> = {}): RespostaPublicarShopee {
  return kitPublicado({
    desfecho: 'incerto',
    itemId: null,
    linkDocId: null,
    estadoAnuncio: null,
    itemStatus: null,
    kitNativo: null,
    antecessor: null,
    recusa: { codigo: 'error_server', fraseShopee: 'System busy.', motivo: null },
    ...extra,
  });
}

const kitDe = (linkDocId: string) => within(screen.getByTestId(`shopee-kit-${linkDocId}`));
const incertoDaConta = () => screen.getByTestId('shopee-kit-incerto-int-1');

/** Opens the kit confirmation from the block's button and confirms it. */
function confirmarKit(linkDocId: string, botaoDoBloco: string, titulo: string) {
  fireEvent.click(kitDe(linkDocId).getByRole('button', { name: botaoDoBloco }));
  const dialogo = screen.getByRole('dialog', { name: titulo });
  fireEvent.click(within(dialogo).getByRole('button', { name: botaoDoBloco }));
}

/** Lets the client's promise and every state update it causes land (fake timers: no waitFor). */
async function assentar() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const AGORA = Date.UTC(2026, 9, 15, 15, 0, 0);

describe('ShopeeEditor — the native kit: badge, recipe and aviso', () => {
  it('badges a live native kit "Kit nativo" and a removed one "Kit nativo (inativo)" — and an ordinary listing of an ordinary produto has no kit section', () => {
    h.links = [
      linkKit('L-kit'),
      linkKit('L-kit-rem', { item_id: 1000003, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
      link('L-comum', { item_id: 1000004 }),
    ];
    renderEditor();
    expect(within(bloco('L-kit')).getByText('Kit nativo')).toBeDefined();
    expect(within(bloco('L-kit-rem')).getByText('Kit nativo (inativo)')).toBeDefined();
    expect(within(bloco('L-kit-rem')).queryByText('Kit nativo')).toBeNull();
    expect(within(bloco('L-comum')).getByText('Ativo')).toBeDefined();
    expect(within(bloco('L-comum')).queryByText(/Kit nativo/)).toBeNull();
    expect(screen.queryByTestId('shopee-kit-L-comum')).toBeNull();
  });

  it('reads the recipe only once "Ver composição" opens: each unit’s components by name, and structure warnings that disable nothing', async () => {
    comEscrita();
    comKit();
    h.links = [linkKit('L-kit')];
    renderEditor();
    // Collapsed: neither the children nor the names are read.
    expect(kitDe('L-kit').getByRole('button', { name: 'Ver composição' })).toBeDefined();
    expect(h.consultas.has('produtos')).toBe(false);
    expect(h.getDocsByIds).not.toHaveBeenCalled();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Ver composição' }));
    const receita = within(screen.getByTestId('shopee-receita-kit'));
    expect(h.consultas.has('produtos')).toBe(true);
    // Units in `ordem` order, each component by its name once the one-shot read lands.
    await waitFor(() =>
      expect(receita.getByText('2 × Camiseta (c1); 1 × Boné (c2)')).toBeDefined(),
    );
    expect(receita.getAllByRole('row').map((r) => r.textContent)).toEqual([
      'VariaçãoComponentes',
      'Kit P2 × Camiseta (c1); 1 × Boné (c2)',
      'Kit G1 × Boné (c2)',
    ]);
    // ONE name read for the distinct components, by id.
    expect(h.getDocsByIds).toHaveBeenCalledTimes(1);
    expect(h.getDocsByIds.mock.calls[0]?.[2]).toEqual(['c1', 'c2']);
    // The schemas adapter's warning, worded for the operator…
    expect(
      within(screen.getByTestId('shopee-receita-kit-avisos')).getByText(
        /A variação Kit G tem um único componente com quantidade 1/,
      ),
    ).toBeDefined();
    // …and never a reason to disable a button.
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('warns that a kit with NO variation cannot be published yet — the saved children, never the form', async () => {
    comEscrita();
    comKit();
    h.filhos = [];
    h.links = [linkKit('L-kit')];
    renderEditor();
    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Ver composição' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('shopee-receita-kit-avisos')).getByText(
          /O kit não tem variação vendável/,
        ),
      ).toBeDefined(),
    );
    // The ERP refuses it before any Shopee write — never "a Shopee deve recusar".
    const avisosDaReceita = within(screen.getByTestId('shopee-receita-kit-avisos'));
    expect(avisosDaReceita.getByText('O ERP não publica esta composição')).toBeDefined();
    expect(avisosDaReceita.queryByText(/A Shopee deve recusar/)).toBeNull();
    expect(h.getDocsByIds).not.toHaveBeenCalled();
  });

  it('shows the conta’s OPEN kit-recipe aviso, read by its deterministic id, in the inbox’s own words', () => {
    h.permitidos = new Set([PERM.integracao.read, PERM.aviso.read]);
    h.links = [linkKit('L-kit')];
    const aberto = {
      tipo: TIPO_AVISO.shopeeKitReceitaDivergente,
      params: { kit: 'prod-1', anuncio: '1000002', vinculo: 'L-kit', variacoes: 'f1' },
      resolvidoEm: null,
    };
    h.aviso = aberto;
    const { unmount } = renderEditor();
    expect(h.avisosLidos).toEqual(new Set([chaveAvisoReceitaKitShopee('int-1', 'prod-1')]));
    const aviso = within(screen.getByTestId('shopee-aviso-receita-int-1'));
    expect(aviso.getByText(/use "Recriar kit" no anúncio do vínculo L-kit/)).toBeDefined();
    expect(aviso.getByText(/na aba Shopee do produto/)).toBeDefined();
    unmount();

    // A resolved one is history: not shown.
    h.aviso = { ...aberto, resolvidoEm: 1_790_000_000_000_000 };
    const { unmount: desmontar } = renderEditor();
    expect(screen.queryByTestId('shopee-aviso-receita-int-1')).toBeNull();
    desmontar();

    // A conta with no native-kit link reads no aviso at all.
    h.avisosLidos = new Set();
    h.links = [link('L-comum')];
    renderEditor();
    expect(within(bloco('L-comum')).getByText('Ativo')).toBeDefined();
    expect(h.avisosLidos.size).toBe(0);
  });
});

describe('ShopeeEditor — recriar / converter em kit nativo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(f) Recriar sends {recriar, linkDocId, principal} after a confirmation; Converter sends {converterEmKit} — never both', async () => {
    comEscrita();
    comKit();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockResolvedValueOnce(kitPublicado())
      .mockResolvedValueOnce(
        kitPublicado({
          arma: 'kit-converter',
          linkDocId: 'L-kit-2',
          antecessor: { itemId: 1000001, linkDocId: 'L-comum', excluido: false, substituido: true },
        }),
      );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    renderEditor();
    // Each arm only where it applies: a native kit recreates, an ordinary listing of a kit converts.
    expect(kitDe('L-kit').queryByRole('button', { name: 'Converter em kit nativo' })).toBeNull();
    expect(kitDe('L-comum').queryByRole('button', { name: 'Recriar kit' })).toBeNull();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    // A create makes a NEW kit on Shopee: nothing is sent before the confirmation.
    expect(publicar).not.toHaveBeenCalled();
    expect(
      dialogo.getByText(/só é excluído na Shopee depois que o novo estiver ativo/),
    ).toBeDefined();
    fireEvent.click(dialogo.getByRole('combobox', { name: 'Componente principal' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Boné (c2)' }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));

    await waitFor(() =>
      expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
      principal: 'c2',
    });
    expect(
      within(bloco('L-kit')).getByText('Kit novo: vínculo L-kit-novo (anúncio 1000005 na Shopee).'),
    ).toBeDefined();
    expect(
      within(bloco('L-kit')).getByText(
        'O anúncio anterior (vínculo L-kit) foi excluído na Shopee.',
      ),
    ).toBeDefined();

    // No principal picked for this link: the ERP chooses, and no key is sent.
    confirmarKit('L-comum', 'Converter em kit nativo', 'Converter em kit nativo');
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-comum',
      converterEmKit: true,
    });
    for (const [corpo] of publicar.mock.calls) {
      expect(corpo.recriar === true && corpo.converterEmKit === true).toBe(false);
    }
  });

  it('offers no Converter on a produto that is not a kit — the server’s own pre-filter', () => {
    comEscrita();
    h.links = [link('L-comum')];
    renderEditor();
    expect(within(bloco('L-comum')).getByRole('button', { name: 'Republicar' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Converter em kit nativo' })).toBeNull();
  });

  it('(g) two clicks that land before a re-render send ONE kit create, and every write button waits for it', async () => {
    comEscrita();
    comKit();
    let soltar: (r: RespostaPublicarShopee) => void = () => undefined;
    const publicar = vi.fn<ShopeeClient['publicar']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    renderEditor();

    fireEvent.click(kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }));
    const confirmar = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' })).getByRole(
      'button',
      { name: 'Recriar kit' },
    );
    // Both handlers run against the SAME render — a state-only lock reads `emVoo === null` twice.
    act(() => {
      confirmar.click();
      confirmar.click();
    });
    expect(publicar).toHaveBeenCalledTimes(1);
    for (const nome of ['Republicar', 'Reverificar', 'Pausar anúncio']) {
      expect(botao('L-comum', nome).hasAttribute('disabled')).toBe(true);
    }
    expect(
      kitDe('L-comum')
        .getByRole('button', { name: 'Converter em kit nativo' })
        .hasAttribute('disabled'),
    ).toBe(true);

    act(() => soltar(kitPublicado()));
    await waitFor(() =>
      expect(botao('L-comum', 'Republicar').hasAttribute('disabled')).toBe(false),
    );
    expect(publicar).toHaveBeenCalledTimes(1);
    expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined();
  });

  it('(h) a 422 whose acao is recriar opens the Recriar confirmation on the link it NAMES — and no terminal text renders', async () => {
    comEscrita();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(
        recusa422([
          {
            campo: 'linkDocId',
            motivo: 'listagem-removida',
            mensagem:
              'o kit 1000002 foi removido na Shopee — publique com --link L2 --recriar para criar ' +
              'um kit novo (publicar:anuncio)',
            acao: { tipo: TIPO.recriar, linkDocId: 'L2' },
          },
        ]),
      )
      .mockResolvedValueOnce(kitPublicado({ antecessor: null, linkDocId: 'L-kit-novo' }));
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      link('L1'),
      linkKit('L2', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido, item_id: 1000002 }),
    ];
    renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    expect(desfecho.getByText(`${TEXTO_ACAO_SUGERIDA[TIPO.recriar]} Vínculo: L2.`)).toBeDefined();
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);

    fireEvent.click(desfecho.getByRole('button', { name: 'Recriar o kit do vínculo L2' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    // The modal speaks of L2 — the removed kit the acao named, not the block the row sits in.
    expect(
      dialogo.getByText(/O kit antigo \(vínculo L2\) já foi excluído na Shopee/),
    ).toBeDefined();
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L2',
      recriar: true,
    });
    await waitFor(() =>
      expect(within(bloco('L2')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
  });

  it('an informar-principal refusal of a recriar re-opens the SAME arm on the same link with the pick — NEAR-MISS: after a plain republish it offers none', async () => {
    comEscrita();
    comKit();
    const principalObrigatorio: ProblemaShopee = {
      campo: 'principal',
      motivo: 'principal-obrigatorio',
      mensagem: 'o kit tem componentes de mais de um anúncio da Shopee — informe (--principal)',
      acao: { tipo: TIPO.informarPrincipal },
    };
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([principalObrigatorio]))
      .mockResolvedValueOnce(kitPublicado())
      .mockRejectedValueOnce(recusa422([principalObrigatorio]));
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    expect(desfecho.getByText(TEXTO_MOTIVO_KIT['principal-obrigatorio'] ?? '?')).toBeDefined();
    fireEvent.click(desfecho.getByRole('button', { name: 'Escolher o componente principal' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    fireEvent.click(dialogo.getByRole('combobox', { name: 'Componente principal' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Camiseta (c1)' }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
      principal: 'c1',
    });

    // The same refusal answering a plain republish: there is no kit arm to re-open.
    await waitFor(() =>
      expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined(),
    );
    fireEvent.click(botao('L-kit', 'Republicar'));
    const outra = within(await waitFor(() => screen.getByTestId('shopee-problema-L-kit-0')));
    expect(outra.getByText(TEXTO_MOTIVO_KIT['principal-obrigatorio'] ?? '?')).toBeDefined();
    expect(outra.queryByRole('button')).toBeNull();
  });

  it('(i) a 202 is UNCERTAIN: Repetir waits aguardarMs, then re-sends the IDENTICAL body — never "falhou"', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockResolvedValueOnce(kitIncerto({ aguardarMs: 60_000 }))
      .mockResolvedValueOnce(kitPublicado());
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    const incerto = within(incertoDaConta());
    expect(incerto.getByText('A Shopee pode ter criado o kit')).toBeDefined();
    expect(incerto.getByText('A Shopee respondeu: System busy.')).toBeDefined();
    // What "Repetir" does, true for every uncertain ending — the resume included.
    expect(
      incerto.getByText(/se o kit já foi criado e vinculado, ele conclui o que faltou/),
    ).toBeDefined();
    // Not an outcome of the link and never a failure: the kit may exist.
    expect(screen.queryByTestId('shopee-desfecho-L-kit')).toBeNull();
    expect(document.body.textContent).not.toMatch(/falhou/i);
    const repetir = () => incerto.getByRole('button', { name: 'Repetir' });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    // A second create would be a second kit: the arm waits too.
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(true);
    // The wait and the body are kept for this browser tab.
    const guardado: unknown = JSON.parse(
      window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null',
    );
    expect(guardado).toStrictEqual({ ate: AGORA + 60_000, corpo: publicar.mock.calls[0]?.[0] });

    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(false);

    fireEvent.click(repetir());
    await assentar();
    expect(publicar).toHaveBeenCalledTimes(2);
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true,
    });
    // IDENTICAL: a plain publish here would reach a different arm.
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual(publicar.mock.calls[0]?.[0]);
    expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined();
    // Answered: the wait is over, here and in the store.
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
  });

  it('(l) a 202 WITHOUT aguardarMs waits the schemas’ AGUARDAR_KIT_INCERTO_SHOPEE_MS', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({ publicar: async () => kitIncerto() });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    const repetir = () => within(incertoDaConta()).getByRole('button', { name: 'Repetir' });
    act(() => {
      vi.advanceTimersByTime(AGUARDAR_KIT_INCERTO_SHOPEE_MS - 1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(repetir().hasAttribute('disabled')).toBe(false);
  });

  it('(j) a network error, a 503 or a 504 on a create is UNCERTAIN — never the failure copy', async () => {
    for (const falha of [
      new ShopeeClientNetworkError('Failed to fetch', new TypeError('x')),
      new ShopeeClientHttpError('indisponível', 503, 'SHOPEE_UNAVAILABLE'),
      new ShopeeClientHttpError('tempo esgotado', 504, null),
    ]) {
      window.sessionStorage.clear();
      comEscrita();
      comKit();
      h.client = shopeeClientFalso({ publicar: () => Promise.reject(falha) });
      h.links = [linkKit('L-kit')];
      const { unmount } = renderEditor();
      const antes = Date.now();
      confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
      await waitFor(() => expect(incertoDaConta()).toBeDefined());
      const depois = Date.now();
      expect(screen.queryByTestId('shopee-desfecho-L-kit')).toBeNull();
      expect(screen.queryByText('Não foi possível contatar a integração com a Shopee.')).toBeNull();
      const guardado = JSON.parse(
        window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null',
      ) as { ate: number } | null;
      // No body carried a wait: the schemas’ constant, from the moment it failed —
      // bracketed to the millisecond, so a wait that differs at all reds this.
      expect(guardado?.ate).toBeGreaterThanOrEqual(antes + AGUARDAR_KIT_INCERTO_SHOPEE_MS);
      expect(guardado?.ate).toBeLessThanOrEqual(depois + AGUARDAR_KIT_INCERTO_SHOPEE_MS);
      unmount();
    }
  });

  it('NEAR-MISS: a rate-limited 502 on a create is a DEFINITE refusal — the failure copy, no wait', async () => {
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          new ShopeeClientHttpError('limite', 502, 'SHOPEE_HTTP_ERROR', null, 'burst'),
        ),
    });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    // Definite — but the limited call may FOLLOW a successful add_kit_item: the
    // kit may exist, and the copy says so instead of "tente em alguns minutos".
    expect(desfecho.getByText(FRASE_LIMITE_NA_CRIACAO_DE_KIT)).toBeDefined();
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('NEAR-MISS: the same rate-limited 502 on a plain republish keeps the channel’s generic copy', async () => {
    comEscrita();
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          new ShopeeClientHttpError('limite', 502, 'SHOPEE_HTTP_ERROR', null, 'burst'),
        ),
    });
    h.links = [link('L1')];
    renderEditor();
    fireEvent.click(botao('L1', 'Republicar'));
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    expect(
      desfecho.getByText('A Shopee limitou as consultas — tente em alguns minutos.'),
    ).toBeDefined();
    expect(desfecho.queryByText(FRASE_LIMITE_NA_CRIACAO_DE_KIT)).toBeNull();
  });

  it('keeps an uncertain create across a reload of the tab, and a DEFINITE answer to its Repetir ends it', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    const corpo = {
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
      recriar: true as const,
      principal: 'c2',
    };
    window.sessionStorage.setItem(
      chaveIncerto('int-1', 'prod-1'),
      JSON.stringify({ ate: AGORA + 30_000, corpo }),
    );
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(
      recusa422([
        {
          campo: 'sku',
          motivo: 'kit-ja-existe-na-shopee',
          mensagem:
            'já existe na Shopee um kit com o SKU deste produto — importe-o (importar:anuncio)',
          acao: { tipo: TIPO.importar, itemIds: [1000005] },
        },
      ]),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();

    // A fresh page found it in the store: the wait holds, and so does the arm.
    const repetir = () => within(incertoDaConta()).getByRole('button', { name: 'Repetir' });
    expect(repetir().hasAttribute('disabled')).toBe(true);
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(true);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    fireEvent.click(repetir());
    await assentar();
    // The stored body, verbatim — the principal included.
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual(corpo);
    // The server read the shop and said "the kit exists": the uncertainty is over.
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(
      within(screen.getByTestId('shopee-desfecho-L-kit')).getByText(
        /Anúncio\(s\) na Shopee: 1000005/,
      ),
    ).toBeDefined();
  });

  it('ignores a stored value that is not a body it may re-send', () => {
    comEscrita();
    comKit();
    window.sessionStorage.setItem(chaveIncerto('int-1', 'prod-1'), '{corrompido');
    h.links = [linkKit('L-kit')];
    renderEditor();
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('writes the wait AHEAD: a remount while a create is in flight finds the conta waiting, never an enabled arm (R3-1)', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    // Never settles: the request is still running when the page goes away.
    const publicar = vi.fn<ShopeeClient['publicar']>(() => new Promise(() => undefined));
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    const { unmount } = renderEditor();
    confirmarKit('L-comum', 'Converter em kit nativo', 'Converter em kit nativo');
    await assentar();
    expect(publicar).toHaveBeenCalledTimes(1);
    // THIS page shows its spinner, not the uncertain alert…
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    // …while the store already holds the wait and the exact body.
    expect(
      JSON.parse(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null'),
    ).toStrictEqual({
      ate: AGORA + AGUARDAR_KIT_INCERTO_SHOPEE_MS,
      corpo: publicar.mock.calls[0]?.[0],
    });

    unmount();
    renderEditor();
    // A new instance: the lock is gone, the server is still running — the store holds the arms.
    expect(
      kitDe('L-comum')
        .getByRole('button', { name: 'Converter em kit nativo' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      within(incertoDaConta()).getByRole('button', { name: 'Repetir' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('the page left mid-flight and re-opened sees the OLD request’s answer when it lands — the store is read on every render (R3-1)', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    let soltar: (r: RespostaPublicarShopee) => void = () => undefined;
    const publicar = vi.fn<ShopeeClient['publicar']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit'), link('L-comum', { item_id: 1000001 })];
    const { unmount } = renderEditor();
    confirmarKit('L-comum', 'Converter em kit nativo', 'Converter em kit nativo');
    await assentar();
    unmount();
    renderEditor();
    // The OLD instance's request answers a 202 with a wait LONGER than the
    // provisional one: it writes the store, which the new instance must follow.
    soltar(kitIncerto({ arma: 'kit-converter', aguardarMs: 600_000 }));
    await assentar();
    const converter = () =>
      kitDe('L-comum').getByRole('button', { name: 'Converter em kit nativo' });
    act(() => {
      vi.advanceTimersByTime(AGUARDAR_KIT_INCERTO_SHOPEE_MS);
    });
    // Past the provisional wait, inside the answer's: still waiting.
    expect(converter().hasAttribute('disabled')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600_000 - AGUARDAR_KIT_INCERTO_SHOPEE_MS);
    });
    expect(converter().hasAttribute('disabled')).toBe(false);
  });

  it('NEAR-MISS: the answer replaces the provisional wait — a 200 leaves nothing stored', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    let soltar: (r: RespostaPublicarShopee) => void = () => undefined;
    const publicar = vi.fn<ShopeeClient['publicar']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).not.toBeNull();
    soltar(kitPublicado());
    await assentar();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(within(bloco('L-kit')).getByText('Kit nativo criado na Shopee')).toBeDefined();
  });

  it('a failed ID-token refresh on a kit create is DEFINITE: its outcome, no wait, the store as it was (R2-1)', async () => {
    comEscrita();
    comKit();
    const publicar = vi.fn<ShopeeClient['publicar']>(() => Promise.reject(SESSAO_SEM_REDE));
    h.client = shopeeClientFalso({ publicar });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    expect(desfecho.getByText(FRASE_SESSAO_SEM_CONEXAO_SHOPEE)).toBeDefined();
    expect(desfecho.queryByText(/Firebase/)).toBeNull();
    // Nothing was sent: no uncertain wait, no Repetir, nothing left in the store.
    expect(screen.queryByTestId('shopee-kit-incerto-int-1')).toBeNull();
    expect(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1'))).toBeNull();
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('NEAR-MISS: the same token failure on a Repetir keeps the EARLIER uncertainty — it is restored, never cleared', async () => {
    comEscrita();
    comKit();
    const anterior = {
      ate: Date.now() - 1,
      corpo: { integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'L-kit', recriar: true },
    };
    window.sessionStorage.setItem(chaveIncerto('int-1', 'prod-1'), JSON.stringify(anterior));
    h.client = shopeeClientFalso({ publicar: () => Promise.reject(SESSAO_SEM_REDE) });
    h.links = [linkKit('L-kit')];
    renderEditor();
    fireEvent.click(within(incertoDaConta()).getByRole('button', { name: 'Repetir' }));
    await waitFor(() => expect(screen.getByTestId('shopee-desfecho-L-kit')).toBeDefined());
    // The kit may still exist from the FIRST attempt: the wait and its body stay.
    expect(
      JSON.parse(window.sessionStorage.getItem(chaveIncerto('int-1', 'prod-1')) ?? 'null'),
    ).toStrictEqual(anterior);
    expect(incertoDaConta()).toBeDefined();
  });

  it('a wall clock stepped back during the wait still ends it: Repetir and the arm come back (R7-1)', async () => {
    vi.useFakeTimers({ now: AGORA });
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({ publicar: async () => kitIncerto({ aguardarMs: 60_000 }) });
    h.links = [linkKit('L-kit')];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await assentar();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // The wall clock steps back 1 ms; the pending timer keeps its remaining delay,
    // so it fires while `Date.now()` still reads 1 ms before the deadline.
    vi.setSystemTime(Date.now() - 1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(
      within(incertoDaConta()).getByRole('button', { name: 'Repetir' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(
      kitDe('L-kit').getByRole('button', { name: 'Recriar kit' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('a vinculo-substituido row about ANOTHER link names it and offers ITS recriar — never "este anúncio foi substituído" on the live kit (R5-01)', async () => {
    comEscrita();
    comKit();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(
        recusa422([
          {
            campo: 'linkDocId',
            motivo: 'vinculo-substituido',
            mensagem:
              'vínculo L-velho (item 1000003): este anúncio foi substituído pelo kit nativo ' +
              'L-kit e não é mais publicado pelo ERP — publique sem --link (ou com --link L-kit)',
            acao: { tipo: TIPO.republicar, linkDocId: 'L-kit', substituidoLinkDocId: 'L-velho' },
          },
        ]),
      )
      .mockResolvedValueOnce(
        kitPublicado({
          antecessor: { itemId: 1000003, linkDocId: 'L-velho', excluido: true, substituido: true },
        }),
      );
    h.client = shopeeClientFalso({ publicar });
    h.links = [
      linkKit('L-velho', { item_id: 1000003, substituidoPorLinkDocId: 'L-kit' }),
      linkKit('L-kit'),
    ];
    renderEditor();
    // The scan of a recriar on the LIVE kit L-kit found K's old kit L-velho still on Shopee.
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    expect(
      desfecho.getByText(
        'O kit nativo antigo do vínculo L-velho foi substituído pelo vínculo L-kit, mas ainda ' +
          'está na Shopee com o mesmo SKU e bloqueia esta ação — exclua-o no Seller Centre, ou ' +
          'use "Recriar kit" nele para tentar excluí-lo de novo.',
      ),
    ).toBeDefined();
    expect(desfecho.queryByText(/Este anúncio foi substituído/)).toBeNull();
    expect(desfecho.queryByRole('button', { name: /Republicar o vínculo/ })).toBeNull();

    fireEvent.click(desfecho.getByRole('button', { name: 'Recriar o kit do vínculo L-velho' }));
    const dialogo = within(screen.getByRole('dialog', { name: 'Recriar kit nativo' }));
    fireEvent.click(dialogo.getByRole('button', { name: 'Recriar kit' }));
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-velho',
      recriar: true,
    });
  });

  it('NEAR-MISS: a vinculo-substituido row about the block ITSELF keeps "este anúncio" and republishes the successor', async () => {
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({
      publicar: () =>
        Promise.reject(
          recusa422([
            {
              campo: 'linkDocId',
              motivo: 'vinculo-substituido',
              mensagem: 'vínculo L-velho: este anúncio foi substituído pelo kit nativo L-kit',
              acao: {
                tipo: TIPO.republicar,
                linkDocId: 'L-kit',
                substituidoLinkDocId: 'L-velho',
              },
            },
          ]),
        ),
    });
    h.links = [
      linkKit('L-velho', { item_id: 1000003, substituidoPorLinkDocId: 'L-kit' }),
      linkKit('L-kit'),
    ];
    renderEditor();
    confirmarKit('L-velho', 'Recriar kit', 'Recriar kit nativo');
    const desfecho = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-velho')));
    expect(
      desfecho.getByText(`${TEXTO_MOTIVO_KIT['vinculo-substituido']} Vínculo: L-kit.`),
    ).toBeDefined();
    expect(desfecho.getByRole('button', { name: 'Republicar o vínculo L-kit' })).toBeDefined();
    expect(desfecho.queryByRole('button', { name: /Recriar o kit do vínculo/ })).toBeNull();
  });

  it.each([
    [ESTADO_ANUNCIO_SHOPEE.banido, 'BANNED', false],
    [ESTADO_ANUNCIO_SHOPEE.emRevisao, 'REVIEWING', false],
    [ESTADO_ANUNCIO_SHOPEE.pausado, 'UNLIST', true],
  ])(
    'kit-novo-inativo with the new kit %s: Reativar only when the shared predicate allows it — the old kit’s recriar always (R5-03)',
    async (estadoAnuncio, itemStatus, reativavel) => {
      comEscrita();
      comKit();
      h.client = shopeeClientFalso({
        publicar: async () =>
          kitPublicado({
            estadoAnuncio,
            itemStatus,
            antecessor: {
              itemId: 1000002,
              linkDocId: 'L-kit',
              excluido: false,
              substituido: true,
            },
            avisos: [{ codigo: 'kit-novo-inativo', produtoId: null }],
          }),
      });
      h.links = [linkKit('L-kit'), linkKit('L-kit-novo', { item_id: 1000005 })];
      renderEditor();
      confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
      await waitFor(() => expect(screen.getByTestId('shopee-kit-avisos')).toBeDefined());
      const bloc = within(bloco('L-kit'));
      expect(
        bloc.queryByRole('button', { name: 'Reativar o kit novo (vínculo L-kit-novo)' }) !== null,
      ).toBe(reativavel);
      expect(bloc.getByRole('button', { name: 'Recriar o kit do vínculo L-kit' })).toBeDefined();
    },
  );

  it('(m) a kit 200 words each aviso by its code — an unknown one and "constructor" read the neutral line — with buttons on the links the BODY names', async () => {
    comEscrita();
    comKit();
    const reverificarAnuncio = vi.fn<ShopeeClient['reverificarAnuncio']>(async () =>
      reverificado(),
    );
    h.client = shopeeClientFalso({
      publicar: async () =>
        kitPublicado({
          antecessor: { itemId: 1000002, linkDocId: 'L-kit', excluido: false, substituido: true },
          avisos: [
            { codigo: 'kit-antigo-nao-excluido', produtoId: null },
            { codigo: 'kit-codigo-novo', produtoId: 'f1' },
            { codigo: 'constructor', produtoId: null },
          ],
        }),
      reverificarAnuncio,
    });
    h.links = [linkKit('L-kit'), linkKit('L-kit-novo', { item_id: 1000005 })];
    renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');

    const avisos = within(await waitFor(() => screen.getByTestId('shopee-kit-avisos')));
    expect(avisos.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      TEXTO_AVISO_KIT['kit-antigo-nao-excluido'],
      'Aviso da Shopee (kit-codigo-novo). (produto f1)',
      'Aviso da Shopee (constructor).',
    ]);
    expect(document.body.textContent).not.toMatch(TEXTO_DE_TERMINAL);
    expect(
      within(bloco('L-kit')).getByText(
        'O anúncio anterior (vínculo L-kit) foi marcado como substituído e ainda pode estar ' +
          'vendendo na Shopee.',
      ),
    ).toBeDefined();
    // The old kit's re-verify, on the link the body names.
    fireEvent.click(
      within(bloco('L-kit')).getByRole('button', { name: 'Reverificar o vínculo L-kit' }),
    );
    await waitFor(() => expect(reverificarAnuncio).toHaveBeenCalledTimes(1));
    expect(reverificarAnuncio.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-kit',
    });
  });
});

/*
 * #1952's finding, carried into the kit arms: `anuncioShopeeVivo` and
 * `podeMoverAnuncioShopee` test `isFinite` only, so a malformed row's `1.5` or
 * `2 ** 53` passes them. Every kit entry point that sends a link id asks
 * `itemIdDoAnuncioShopee` (a positive SAFE integer) — on the block, or through
 * `AcoesShopee.enderecavel` for a link named by id — except "Repetir".
 */
describe('ShopeeEditor — the kit arms address only a listing an id can name', () => {
  const comumDoKit = (item_id: unknown): ProdutoShopeeLink =>
    ({
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_id,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      kitNativo: false,
      substituidoPorLinkDocId: null,
    }) as unknown as ProdutoShopeeLink;

  it.each([
    [1.5, false],
    [2 ** 53, false],
    // NEAR-MISS: the ids that DO address a listing, up to the last safe integer.
    [1000001, true],
    [Number.MAX_SAFE_INTEGER, true],
  ])('convertivel on an otherwise convertible link with item_id %s → %s', (itemId, esperado) => {
    const l = comumDoKit(itemId);
    // "Otherwise convertible": the schemas predicate passes every one of them.
    expect(anuncioShopeeVivo(l as unknown as Record<string, unknown>)).toBe(true);
    expect(convertivel(l, true)).toBe(esperado);
  });

  it('offers "Converter em kit nativo" on no listing whose id the schemas pass but no listing has — every addressable one keeps it', () => {
    comEscrita();
    comKit();
    h.links = [
      link('L-fracao', { item_id: 1.5 }),
      link('L-2e53', { item_id: 2 ** 53 }),
      link('L-ok', { item_id: 1000001 }),
      link('L-max', { item_id: Number.MAX_SAFE_INTEGER }),
    ];
    renderEditor();
    // NEAR-MISS first: the addressable ones convert.
    for (const id of ['L-ok', 'L-max']) {
      expect(kitDe(id).getByRole('button', { name: 'Converter em kit nativo' })).toBeDefined();
    }
    for (const id of ['L-fracao', 'L-2e53']) {
      // The section still reads (a kit produto's listing), it just offers no arm.
      expect(kitDe(id).getByRole('button', { name: 'Ver composição' })).toBeDefined();
      expect(kitDe(id).queryByRole('button', { name: 'Converter em kit nativo' })).toBeNull();
    }
  });

  it.each([
    ['converter', 'L-comum', 'Converter em kit nativo', 'Converter em kit nativo'],
    ['recriar', 'L-kit', 'Recriar kit', 'Recriar kit nativo'],
  ])(
    'the %s confirmation cannot send once its link was rewritten with an id no listing has — nor once it is gone',
    (_arma, linkDocId, rotulo, titulo) => {
      comEscrita();
      comKit();
      const publicar = vi.fn<ShopeeClient['publicar']>();
      h.client = shopeeClientFalso({ publicar });
      const comId = (item_id: unknown) =>
        linkDocId === 'L-kit' ? linkKit('L-kit', { item_id }) : link('L-comum', { item_id });
      h.links = [comId(1000001)];
      const { rerender } = renderEditor();
      fireEvent.click(kitDe(linkDocId).getByRole('button', { name: rotulo }));
      const confirmar = () =>
        within(screen.getByRole('dialog', { name: titulo })).getByRole('button', { name: rotulo });
      // NEAR-MISS first: as opened, on an addressable link, the confirmation can send.
      expect(confirmar().hasAttribute('disabled')).toBe(false);

      // The live snapshot repaints while the dialog is open.
      h.links = [comId(1.5)];
      rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
      expect(confirmar().hasAttribute('disabled')).toBe(true);
      fireEvent.click(confirmar());

      // A link the tab no longer holds: its outcome would land in no block.
      h.links = [];
      rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
      expect(confirmar().hasAttribute('disabled')).toBe(true);
      fireEvent.click(confirmar());
      expect(publicar).not.toHaveBeenCalled();
    },
  );

  it('a recriar refusal row offers its button only on a LOADED kit whose id addresses a listing — the row still names the rest', async () => {
    comEscrita();
    const removido = (linkDocId: string): ProblemaShopee => ({
      campo: 'linkDocId',
      motivo: 'listagem-removida',
      mensagem: `o kit do vínculo ${linkDocId} foi removido na Shopee`,
      acao: { tipo: TIPO.recriar, linkDocId },
    });
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([removido('L2'), removido('L-fracao'), removido('L-fora')]));
    h.client = shopeeClientFalso({ publicar });
    const kitRemovido = (id: string, item_id: unknown) =>
      linkKit(id, { item_id, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    h.links = [link('L1'), kitRemovido('L2', 1000002), kitRemovido('L-fracao', 1.5)];
    const { rerender } = renderEditor();

    fireEvent.click(botao('L1', 'Republicar'));
    const d = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L1')));
    for (const id of ['L2', 'L-fracao', 'L-fora']) {
      expect(d.getByText(`${TEXTO_ACAO_SUGERIDA[TIPO.recriar]} Vínculo: ${id}.`)).toBeDefined();
    }
    // NEAR-MISS: the loaded, addressable kit keeps its button.
    expect(d.getByRole('button', { name: 'Recriar o kit do vínculo L2' })).toBeDefined();
    expect(d.queryByRole('button', { name: 'Recriar o kit do vínculo L-fracao' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Recriar o kit do vínculo L-fora' })).toBeNull();

    // The named kit rewritten after the 422: the outcome stays, its button goes.
    h.links = [link('L1'), kitRemovido('L2', 2 ** 53), kitRemovido('L-fracao', 1.5)];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    const depois = within(screen.getByTestId('shopee-desfecho-L1'));
    expect(depois.getByText(`${TEXTO_ACAO_SUGERIDA[TIPO.recriar]} Vínculo: L2.`)).toBeDefined();
    expect(depois.queryByRole('button', { name: /Recriar o kit do vínculo/ })).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it('a superseded-old-kit row (vinculo-substituido about ANOTHER link) offers ITS recriar only on a loaded, addressable old kit', async () => {
    comEscrita();
    comKit();
    const alheio = (antigo: string): ProblemaShopee => ({
      campo: 'linkDocId',
      motivo: 'vinculo-substituido',
      mensagem: `vínculo ${antigo}: este anúncio foi substituído pelo kit nativo L-kit`,
      acao: { tipo: TIPO.republicar, linkDocId: 'L-kit', substituidoLinkDocId: antigo },
    });
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(
        recusa422([alheio('L-velho'), alheio('L-velho-fracao'), alheio('L-velho-fora')]),
      );
    h.client = shopeeClientFalso({ publicar });
    const velho = (id: string, item_id: unknown) =>
      linkKit(id, { item_id, substituidoPorLinkDocId: 'L-kit' });
    h.links = [velho('L-velho', 1000003), velho('L-velho-fracao', 1.5), linkKit('L-kit')];
    const { rerender } = renderEditor();

    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    const d = within(await waitFor(() => screen.getByTestId('shopee-desfecho-L-kit')));
    for (const id of ['L-velho', 'L-velho-fracao', 'L-velho-fora']) {
      expect(d.getByText(new RegExp(`^O kit nativo antigo do vínculo ${id} foi`))).toBeDefined();
    }
    // NEAR-MISS: the loaded, addressable old kit keeps its button.
    expect(d.getByRole('button', { name: 'Recriar o kit do vínculo L-velho' })).toBeDefined();
    expect(d.queryByRole('button', { name: 'Recriar o kit do vínculo L-velho-fracao' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Recriar o kit do vínculo L-velho-fora' })).toBeNull();
    // The row is about the OLD kit: republishing the successor cannot clear it.
    expect(d.queryByRole('button', { name: /Republicar o vínculo/ })).toBeNull();

    h.links = [velho('L-velho', 1.5), velho('L-velho-fracao', 1.5), linkKit('L-kit')];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(
      within(screen.getByTestId('shopee-desfecho-L-kit')).queryByRole('button', {
        name: /Recriar o kit do vínculo/,
      }),
    ).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it('an informar-principal row re-opens its arm only while the refused link still addresses a listing', async () => {
    comEscrita();
    comKit();
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(
      recusa422([
        {
          campo: 'principal',
          motivo: 'principal-obrigatorio',
          mensagem: 'o kit tem componentes de mais de um anúncio da Shopee',
          acao: { tipo: TIPO.informarPrincipal },
        },
      ]),
    );
    h.client = shopeeClientFalso({ publicar });
    h.links = [link('L-comum', { item_id: 1000001 })];
    const { rerender } = renderEditor();

    confirmarKit('L-comum', 'Converter em kit nativo', 'Converter em kit nativo');
    const linha = () => within(screen.getByTestId('shopee-problema-L-comum-0'));
    // NEAR-MISS first: as refused, on an addressable link, the pick re-opens.
    expect(
      (await waitFor(() => linha())).getByRole('button', {
        name: 'Escolher o componente principal',
      }),
    ).toBeDefined();

    // The refused link rewritten with an id no listing has: the row stays, the button goes.
    h.links = [link('L-comum', { item_id: 1.5 })];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(linha().getByText(TEXTO_MOTIVO_KIT['principal-obrigatorio'] ?? '?')).toBeDefined();
    expect(linha().queryByRole('button')).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it('a kit 200’s aviso steps go only to LOADED links whose id addresses a listing — the new kit’s and the old one’s alike', async () => {
    comEscrita();
    comKit();
    h.client = shopeeClientFalso({
      publicar: async () =>
        kitPublicado({
          estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
          itemStatus: 'UNLIST',
          antecessor: { itemId: 1000002, linkDocId: 'L-kit', excluido: false, substituido: true },
          avisos: [
            { codigo: 'receita-divergente', produtoId: null },
            { codigo: 'kit-novo-inativo', produtoId: null },
            { codigo: 'kit-antigo-nao-excluido', produtoId: null },
          ],
        }),
    });
    const novo = (item_id: unknown) => linkKit('L-kit-novo', { item_id });
    const antigo = (item_id: unknown) => linkKit('L-kit', { item_id });
    h.links = [antigo(1000002), novo(1000005)];
    const { rerender } = renderEditor();
    confirmarKit('L-kit', 'Recriar kit', 'Recriar kit nativo');
    await waitFor(() => expect(screen.getByTestId('shopee-kit-avisos')).toBeDefined());

    const passos = () =>
      within(screen.getByTestId('shopee-desfecho-L-kit'))
        .queryAllByRole('button')
        .map((b) => b.textContent);
    const DO_NOVO = [
      'Recriar o kit do vínculo L-kit-novo',
      'Reativar o kit novo (vínculo L-kit-novo)',
    ];
    const DO_ANTIGO = ['Recriar o kit do vínculo L-kit', 'Reverificar o vínculo L-kit'];
    // NEAR-MISS first: both links loaded and addressable — every step.
    expect(passos()).toEqual([...DO_NOVO, ...DO_ANTIGO]);

    // The new kit rewritten with an id no listing has: its steps go, the old one's stay.
    h.links = [antigo(1000002), novo(1.5)];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(passos()).toEqual(DO_ANTIGO);

    // The new kit not (or no longer) loaded: its outcome would land in no block.
    h.links = [antigo(1000002)];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(passos()).toEqual(DO_ANTIGO);

    // The old kit rewritten too: no step at all — the avisos still read.
    h.links = [antigo(2 ** 53)];
    rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} />);
    expect(passos()).toEqual([]);
    expect(within(screen.getByTestId('shopee-kit-avisos')).getAllByRole('listitem')).toHaveLength(
      3,
    );
  });

  it.each([
    ['is no longer listed', [] as Linha[]],
    ['was rewritten with an id no listing has', [linkKit('L-kit', { item_id: 1.5 })]],
  ])(
    'NEAR-MISS: "Repetir" is NOT behind that gate — the stored body re-sends verbatim when its link %s',
    async (_caso, links) => {
      comEscrita();
      comKit();
      const corpo = {
        integracaoId: 'int-1',
        produtoId: 'prod-1',
        linkDocId: 'L-kit',
        recriar: true as const,
      };
      // The wait is already over.
      window.sessionStorage.setItem(
        chaveIncerto('int-1', 'prod-1'),
        JSON.stringify({ ate: Date.now() - 1, corpo }),
      );
      const publicar = vi.fn<ShopeeClient['publicar']>().mockResolvedValueOnce(kitPublicado());
      h.client = shopeeClientFalso({ publicar });
      h.links = links;
      renderEditor();

      const repetir = within(incertoDaConta()).getByRole('button', { name: 'Repetir' });
      expect(repetir.hasAttribute('disabled')).toBe(false);
      fireEvent.click(repetir);
      await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
      expect(publicar.mock.calls[0]?.[0]).toStrictEqual(corpo);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                #1911 P10 — the listing DRAFT, authored here                 */
/* -------------------------------------------------------------------------- */

/** A stored draft: no `item_id`, never folded. */
const rascunho = (id: string, extra: Record<string, unknown> = {}): Linha =>
  link(id, {
    item_id: null,
    estadoAnuncio: null,
    category_id: null,
    item_name: 'Camiseta azul',
    ...extra,
  });

/** The props the draft form `linkDocId` got on the LAST render. */
const formDe = (linkDocId: string): RascunhoShopeeProps => {
  const p = h.rascunhos.get(linkDocId);
  if (p === undefined) throw new Error(`no draft form rendered for ${linkDocId}`);
  return p;
};
const raizDoRascunho = (linkDocId: string) => screen.getByTestId(`shopee-rascunho-${linkDocId}`);
const botaoDoRascunho = (linkDocId: string, nome: string) =>
  within(raizDoRascunho(linkDocId)).getByRole('button', { name: nome }) as HTMLButtonElement;
const tituloDo = (linkDocId: string) =>
  within(raizDoRascunho(linkDocId)).getByLabelText('Título do anúncio') as HTMLInputElement;
const digitarTitulo = (linkDocId: string, valor: string) =>
  fireEvent.change(tituloDo(linkDocId), { target: { value: valor } });
/** The LOCAL drafts' ids — forms rendered for an id no stored link has. */
const idsLocais = () => [...h.rascunhos.keys()].filter((id) => !h.links.some((l) => l.id === id));
const novoAnuncio = (contaId = 'int-1') =>
  fireEvent.click(screen.getByTestId(`shopee-novo-anuncio-${contaId}`));
/** A draft-route refusal, as the client builds it. */
function recusaDoRascunho(
  status: number,
  code: string | null,
  detalhes: Partial<typeof DETALHES_ERRO_SHOPEE_VAZIOS> = {},
): ShopeeClientHttpError {
  return new ShopeeClientHttpError('Recusado.', status, code, null, null, {
    ...DETALHES_ERRO_SHOPEE_VAZIOS,
    ...detalhes,
  });
}
/**
 * The editor, re-rendered after the test moved the snapshot (`h.links`
 * reassigned = a NEW emission). Pass the SAME `onDirtyChange` the first render
 * got: a re-render without it drops the callback, and the guard's last report
 * would then be whatever came before.
 */
const rerenderEditor = (
  rerender: (ui: ReactNode) => void,
  props: {
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
    produtoSujoForaDoFormulario?: boolean;
  } = {},
) => rerender(<ShopeeEditor produtoId="prod-1" db={{} as Firestore} {...props} />);

type RespostaCriar = Awaited<ReturnType<ShopeeClient['criarRascunho']>>;
type RespostaAtualizar = Awaited<ReturnType<ShopeeClient['atualizarRascunho']>>;

describe('ShopeeEditor — «Novo anúncio» and the create (#1911 P10)', () => {
  it('sends NOTHING until «Salvar rascunho»; the create names every field, prefilled from the STORED produto; a retry after no answer re-sends the SAME id', async () => {
    comAutoria();
    let soltar: (r: RespostaCriar) => void = () => undefined;
    const criarRascunho = vi
      .fn<ShopeeClient['criarRascunho']>()
      .mockRejectedValueOnce(new ShopeeClientNetworkError('Failed to fetch', new TypeError('x')))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            soltar = resolve;
          }),
      );
    h.client = shopeeClientFalso({ criarRascunho });
    renderEditor();

    novoAnuncio();
    const [id] = idsLocais();
    expect(id).toMatch(PADRAO_ID_RASCUNHO_SHOPEE);
    expect(screen.getByTestId(`shopee-novo-rascunho-${id!}`)).toBeDefined();
    expect(within(raizDoRascunho(id!)).getByText(FRASE_RASCUNHO_NOVO_SHOPEE)).toBeDefined();
    expect(tituloDo(id!).value).toBe('Camiseta');
    expect(criarRascunho).not.toHaveBeenCalled();

    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    await waitFor(() =>
      expect(within(raizDoRascunho(id!)).getByTestId(`resultado-${id!}`).textContent).toBe(
        fraseDaRespostaIncertaDoRascunhoShopee('criar'),
      ),
    );
    const corpo = {
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: id,
      conteudo: {
        item_name: 'Camiseta',
        description: null,
        category_id: null,
        marca: null,
        attributes: null,
      },
    };
    expect(criarRascunho.mock.calls[0]?.[0]).toStrictEqual(corpo);
    // Never a success after no answer.
    expect(h.notify).not.toHaveBeenCalled();

    // The retry: the SAME id and body; a double click sends ONE request.
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    expect(criarRascunho).toHaveBeenCalledTimes(2);
    expect(criarRascunho.mock.calls[1]?.[0]).toStrictEqual(corpo);
    await act(async () => {
      soltar({ linkDocId: id!, criado: true });
      await Promise.resolve();
    });
    expect(h.notify).toHaveBeenCalledWith({
      color: 'green',
      message: FRASE_RASCUNHO_CRIADO_SHOPEE,
    });
    expect(idsLocais()).toEqual([id]);
  });

  it('after the 2xx the draft shows what was saved, read-only, until the snapshot moves — then the STORED draft repaints its block', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      criarRascunho: async (input) => ({ linkDocId: input.linkDocId, criado: true }),
    });
    const { rerender } = renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    digitarTitulo(id!, 'Camiseta nova');
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    await waitFor(() =>
      expect(
        within(raizDoRascunho(id!)).getByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
      ).toBeDefined(),
    );
    expect(tituloDo(id!).value).toBe('Camiseta nova');
    expect(tituloDo(id!).readOnly).toBe(true);
    // The SAME snapshot re-rendered keeps the bridge.
    rerenderEditor(rerender);
    expect(screen.getByTestId(`shopee-novo-rascunho-${id!}`)).toBeDefined();

    // The route's echo: a NEW snapshot holding the stored draft.
    h.links = [rascunho(id!, { item_name: 'Camiseta nova (servidor)' })];
    rerenderEditor(rerender);
    expect(screen.queryByTestId(`shopee-novo-rascunho-${id!}`)).toBeNull();
    expect(within(bloco(id!)).getByTestId(`shopee-rascunho-${id!}`)).toBeDefined();
    expect(tituloDo(id!).value).toBe('Camiseta nova (servidor)');
    expect(tituloDo(id!).readOnly).toBe(false);
  });

  /** A saved title, then the bridge — the R1-rule7#2 pair's shared opening. */
  async function salvarTituloDoRascunho(outros: Linha[]) {
    comAutoria();
    h.client = shopeeClientFalso({
      atualizarRascunho: async (input): Promise<RespostaAtualizar> => ({
        linkDocId: input.linkDocId,
        gravados: ['item_name'],
      }),
    });
    h.links = [rascunho('L-rasc', { ultimaModificacao: 1_000 }), ...outros];
    const render = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta nova');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(
        within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
      ).toBeDefined(),
    );
    return render;
  }

  it('R1-rule7#2: a just-saved draft waits for ITS OWN echo — another link’s write keeps it read-only ⟷ its own re-stamped document releases it', async () => {
    const { rerender } = await salvarTituloDoRascunho([link('L1', { ultimaModificacao: 5 })]);
    // Another link's write: a NEW snapshot, this draft's stamp unchanged.
    h.links = [
      rascunho('L-rasc', { ultimaModificacao: 1_000 }),
      link('L1', { ultimaModificacao: 6 }),
    ];
    rerenderEditor(rerender);
    expect(
      within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
    ).toBeDefined();
    expect(tituloDo('L-rasc').value).toBe('Camiseta nova');
    expect(tituloDo('L-rasc').readOnly).toBe(true);

    // ITS echo: the route re-stamped the document.
    h.links = [
      rascunho('L-rasc', { item_name: 'Camiseta nova', ultimaModificacao: 2_000 }),
      link('L1', { ultimaModificacao: 6 }),
    ];
    rerenderEditor(rerender);
    expect(
      within(raizDoRascunho('L-rasc')).queryByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
    ).toBeNull();
    expect(tituloDo('L-rasc').value).toBe('Camiseta nova');
    expect(tituloDo('L-rasc').readOnly).toBe(false);
  });

  it('R1-rule7#2: a FULL links query (MAX_LINKS) may never return the echo — the SAME kind of emission releases the bridge (never stuck read-only)', async () => {
    // 199 listings + the draft = the query's 200-row limit.
    const cheios = Array.from({ length: 199 }, (_, i) =>
      link(`L-${String(i)}`, { item_id: 2_000_000 + i, ultimaModificacao: 5 }),
    );
    const { rerender } = await salvarTituloDoRascunho(cheios);
    h.links = [
      rascunho('L-rasc', { ultimaModificacao: 1_000 }),
      ...cheios.slice(1),
      link('L-0', { item_id: 2_000_000, ultimaModificacao: 6 }),
    ];
    rerenderEditor(rerender);
    expect(
      within(raizDoRascunho('L-rasc')).queryByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
    ).toBeNull();
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    // 200 blocks rendered three times: ~2.6 s alone, over the 5 s default under the full suite.
  }, 30_000);

  it.each([
    ['only a DRAFT', [rascunho('L-rasc')]],
    ['a superseded listing still on Shopee', [link('L-subst', { substituidoPorLinkDocId: 'L-x' })]],
  ])(
    'asks before a SECOND listing when the conta holds %s — Cancel opens nothing; the confirmed create carries the flag',
    async (_caso, links) => {
      comAutoria();
      const criarRascunho = vi.fn<ShopeeClient['criarRascunho']>(async (input) => ({
        linkDocId: input.linkDocId,
        criado: true,
      }));
      h.client = shopeeClientFalso({ criarRascunho });
      h.links = links;
      renderEditor();

      novoAnuncio();
      const dialogo = screen.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE });
      expect(
        within(dialogo).getByText(
          textoDoSegundoAnuncioShopee({
            quantidade: 1,
            comRascunho: links[0]!.data.item_id === null,
          }),
        ),
      ).toBeDefined();
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
      expect(idsLocais()).toEqual([]);

      novoAnuncio();
      fireEvent.click(
        within(screen.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE })).getByRole(
          'button',
          { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE },
        ),
      );
      const [id] = idsLocais();
      expect(criarRascunho).not.toHaveBeenCalled();
      fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
      await waitFor(() => expect(criarRascunho).toHaveBeenCalledTimes(1));
      expect(criarRascunho.mock.calls[0]?.[0]).toMatchObject({
        linkDocId: id,
        confirmarSegundoAnuncio: true,
      });
    },
  );

  it.each([
    [
      'holds only a REMOVED link',
      [link('L-rem', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido })],
    ],
    ['holds nothing', []],
  ])(
    'NEAR-MISS: no confirmation when the conta %s — and the create carries no flag',
    async (_c, links) => {
      comAutoria();
      const criarRascunho = vi.fn<ShopeeClient['criarRascunho']>(async (input) => ({
        linkDocId: input.linkDocId,
        criado: true,
      }));
      h.client = shopeeClientFalso({ criarRascunho });
      h.links = links;
      renderEditor();
      novoAnuncio();
      expect(screen.queryByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE })).toBeNull();
      const [id] = idsLocais();
      fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
      await waitFor(() => expect(criarRascunho).toHaveBeenCalledTimes(1));
      expect(criarRascunho.mock.calls[0]?.[0]).not.toHaveProperty('confirmarSegundoAnuncio');
    },
  );

  it('a LOCAL new draft already counts: a second «Novo anúncio» on the same conta asks first', () => {
    comAutoria();
    renderEditor();
    novoAnuncio();
    expect(screen.queryByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE })).toBeNull();
    novoAnuncio();
    const dialogo = screen.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE });
    expect(
      within(dialogo).getByText(textoDoSegundoAnuncioShopee({ quantidade: 1, comRascunho: true })),
    ).toBeDefined();
    expect(idsLocais()).toHaveLength(1);
  });

  it('a 409 rascunhoContaJaTemAnuncio opens the SAME confirmation from detalhes.vinculos and re-sends the create with the flag', async () => {
    comAutoria();
    const criarRascunho = vi
      .fn<ShopeeClient['criarRascunho']>()
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio, {
          vinculos: [
            { linkDocId: 'L-a', itemId: 1000009, rascunho: false },
            { linkDocId: 'L-b', itemId: null, rascunho: true },
          ],
        }),
      )
      .mockImplementationOnce(async (input) => ({ linkDocId: input.linkDocId, criado: true }));
    h.client = shopeeClientFalso({ criarRascunho });
    renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));

    const dialogo = await screen.findByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE });
    expect(
      within(dialogo).getByText(textoDoSegundoAnuncioShopee({ quantidade: 2, comRascunho: true })),
    ).toBeDefined();
    fireEvent.click(
      within(dialogo).getByRole('button', { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE }),
    );
    await waitFor(() => expect(criarRascunho).toHaveBeenCalledTimes(2));
    expect(criarRascunho.mock.calls[0]?.[0]).not.toHaveProperty('confirmarSegundoAnuncio');
    expect(criarRascunho.mock.calls[1]?.[0]).toStrictEqual({
      ...criarRascunho.mock.calls[0]?.[0],
      confirmarSegundoAnuncio: true,
    });
  });

  it('a VIRTUAL-kit produto gets no «Novo anúncio», and a legacy draft of it says why — NEAR-MISS: a kit that is not virtual, and a plain produto, get the button', () => {
    comAutoria();
    h.produto = { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true };
    h.links = [rascunho('L-rasc')];
    const { unmount } = renderEditor();
    expect(screen.queryByTestId('shopee-novo-anuncio-int-1')).toBeNull();
    expect(
      within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE),
    ).toBeDefined();
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);
    expect(botaoDoRascunho('L-rasc', 'Descartar').disabled).toBe(false);
    unmount();

    for (const produto of [
      { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: false },
      // `ehKitVirtual` alone is no virtual kit (`ehKitVirtualEfetivo`).
      { nome: 'Camiseta', paiId: null, ehKitVirtual: true },
      { nome: 'Camiseta', paiId: null },
    ]) {
      h.produto = produto;
      const { unmount: desmontar } = renderEditor();
      expect(
        screen.getByTestId('shopee-novo-anuncio-int-1'),
        JSON.stringify(produto),
      ).toBeDefined();
      expect(
        within(raizDoRascunho('L-rasc')).queryByText(FRASE_RASCUNHO_EM_KIT_VIRTUAL_SHOPEE),
      ).toBeNull();
      desmontar();
    }
  });
});

describe('ShopeeEditor — editing a stored draft (#1911 P10)', () => {
  it('is read-only until the links snapshot came from the SERVER; an entry once made keeps editing through a cache-served re-listen', () => {
    comAutoria();
    h.links = [rascunho('L-rasc')];
    h.fromCache = true;
    const { rerender } = renderEditor();
    expect(
      within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_CARREGANDO_SHOPEE),
    ).toBeDefined();
    expect(tituloDo('L-rasc').readOnly).toBe(true);
    // A keystroke that reaches the handler anyway changes nothing.
    digitarTitulo('L-rasc', 'Do cache');
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul');
    expect(formDe('L-rasc').bloco.sujo).toBe(false);

    h.fromCache = false;
    rerenderEditor(rerender);
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    digitarTitulo('L-rasc', 'Do servidor');
    expect(tituloDo('L-rasc').value).toBe('Do servidor');

    // An Activity re-show re-emits `fromCache: true` first.
    h.fromCache = true;
    rerenderEditor(rerender);
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    expect(tituloDo('L-rasc').value).toBe('Do servidor');
  });

  it('saves ONLY the edited field against the base the operator LOADED — a snapshot that moved meanwhile changes neither the base nor the typed text', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['item_name'],
    }));
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    h.client = shopeeClientFalso({
      atualizarRascunho,
      limitesDoItem: async () => limitesDoItem(100087),
    });
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');

    // Another tab saved the title meanwhile.
    h.links = [rascunho('L-rasc', { category_id: 100087, item_name: 'Camiseta (outra aba)' })];
    rerenderEditor(rerender);
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
    // The stale check names it before the click.
    expect(formDe('L-rasc').divergencias).toEqual(['item_name']);

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      base: { item_name: 'Camiseta azul' },
      patch: { item_name: 'Camiseta azul marinho' },
    });
    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith({
        color: 'green',
        message: FRASE_RASCUNHO_SALVO_SHOPEE,
      }),
    );
  });

  it('`gravados: []` wrote nothing, so no echo will come: the entry is dropped at once and the block is editable again', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      atualizarRascunho: async (input): Promise<RespostaAtualizar> => ({
        linkDocId: input.linkDocId,
        gravados: [],
      }),
    });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    digitarTitulo('L-rasc', 'Igual ao de outra aba');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith({
        color: 'blue',
        message: FRASE_RASCUNHO_SEM_MUDANCA_SHOPEE,
      }),
    );
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul');
    expect(
      within(raizDoRascunho('L-rasc')).queryByText(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
    ).toBeNull();
  });

  it('`incerta`: the category is locked — a pick is ignored — while a title edit still goes, ALONE', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['item_name'],
    }));
    h.client = shopeeClientFalso({ atualizarRascunho });
    // No lock, an uncertain create on record: `incerta`.
    h.links = [rascunho('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    renderEditor();
    expect(within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeDefined();
    // The badge above agrees with the notice: never a definite «Não publicado».
    expect(within(bloco('L-rasc')).getByText(ROTULO_PUBLICACAO_INCERTA_SHOPEE)).toBeDefined();
    expect(within(bloco('L-rasc')).queryByText('Não publicado')).toBeNull();
    expect(formDe('L-rasc').bloco.categoriaEditavel).toBe(false);
    act(() => formDe('L-rasc').onCampo('category_id', 100087));
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    expect(formDe('L-rasc').bloco.valores.category_id).toBeNull();
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toMatchObject({
      base: { item_name: 'Camiseta azul' },
      patch: { item_name: 'Camiseta azul marinho' },
    });
    expect(atualizarRascunho.mock.calls[0]?.[0].patch).not.toHaveProperty('category_id');
  });

  it('R1-rule7#5: a category change picked while `livre` is stranded by `incerta` — putting the HELD category back is the one pick accepted, and the title then goes ALONE ⟷ NEAR-MISS: a THIRD category is still ignored', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['item_name'],
    }));
    h.client = shopeeClientFalso({
      atualizarRascunho,
      limitesDoItem: async (input) => limitesDoItem(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    const { rerender } = renderEditor();
    act(() => formDe('L-rasc').onCampo('category_id', 100088));
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100088);

    // The reading turns `incerta` (an uncertain create on record) while the entry holds both edits.
    h.links = [
      rascunho('L-rasc', { category_id: 100087, criacaoIncertaDesde: Date.now() - 600_000 }),
    ];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').bloco.impedimento).toBe('categoria-travada');
    expect(formDe('L-rasc').bloco.podeVoltarCategoria).toBe(true);
    expect(formDe('L-rasc').bloco.categoriaGravada).toBe(100087);
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);

    // NEAR-MISS: a third category is a CHANGE — still refused.
    act(() => formDe('L-rasc').onCampo('category_id', 100090));
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100088);

    // The put-back: the held category, the title kept.
    act(() => formDe('L-rasc').onCampo('category_id', formDe('L-rasc').bloco.categoriaGravada));
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100087);
    expect(formDe('L-rasc').bloco.podeVoltarCategoria).toBe(false);
    expect(formDe('L-rasc').bloco.impedimento).toBeNull();
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      base: { item_name: 'Camiseta azul' },
      patch: { item_name: 'Camiseta azul marinho' },
    });
  });

  it('NEAR-MISS: outside `incerta` a category change is sent WITH the attributes it clears in its base', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['category_id', 'attributes'],
    }));
    h.client = shopeeClientFalso({
      atualizarRascunho,
      limitesDoItem: async (input) => limitesDoItem(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    renderEditor();
    act(() => formDe('L-rasc').onCampo('category_id', 100088));
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toMatchObject({
      base: { category_id: 100087, attributes: null },
      patch: { category_id: 100088 },
    });
  });

  it('feeds the form the STORED produto texts and the EDITED category’s bands — NEAR-MISS: a draft with no category asks apps/shopee nothing', async () => {
    comAutoria();
    h.extraData = { descricao: 'Descrição da aba Descrição' };
    const limitesDoItemFn = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId),
    );
    h.client = shopeeClientFalso({ limitesDoItem: limitesDoItemFn });
    h.links = [rascunho('L-cat', { category_id: 100087 }), rascunho('L-sem', { item_id: null })];
    renderEditor();
    await waitFor(() => expect(formDe('L-cat').limites).not.toBeNull());
    expect(limitesDoItemFn.mock.calls.map(([i]) => i)).toStrictEqual([
      { integracaoId: 'int-1', categoryId: 100087 },
    ]);
    expect(formDe('L-cat').limites).toStrictEqual(limitesDoItem(100087).limites);
    expect(formDe('L-cat').textosDoProduto).toStrictEqual({
      nomeProduto: 'Camiseta',
      descricaoProduto: 'Descrição da aba Descrição',
    });
    expect(formDe('L-sem').limites).toBeNull();

    // The EDITED category's bands, never the stored one's.
    act(() => formDe('L-cat').onCampo('category_id', 100088));
    await waitFor(() =>
      expect(formDe('L-cat').limites).toStrictEqual(limitesDoItem(100088).limites),
    );
    expect(limitesDoItemFn.mock.calls.map(([i]) => i)).toContainEqual({
      integracaoId: 'int-1',
      categoryId: 100088,
    });
  });

  it('§H Q1: the form gets the HELD brand — a nameless re-pick of the SAME id keeps the stored name (never sent as null) ⟷ another id is the pair as picked; a named row carries its name', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['item_name'],
    }));
    h.client = shopeeClientFalso({ atualizarRascunho });
    const linha = (brandId: number, nome: string | null) => ({
      brandId,
      originalBrandName: nome,
      displayBrandName: null,
      rotulo: nome ?? `Marca ${String(brandId)}`,
      docIds: [String(brandId)],
    });
    const casos: [string, ReturnType<typeof linha>, unknown][] = [
      ['same id, nameless', linha(77, null), undefined],
      ['another id, nameless', linha(88, null), { brand_id: 88, original_brand_name: null }],
      [
        'same id, named',
        linha(77, 'Acme Novo'),
        { brand_id: 77, original_brand_name: 'Acme Novo' },
      ],
    ];
    for (const [caso, row, marcaNoPatch] of casos) {
      atualizarRascunho.mockClear();
      h.links = [rascunho('L-rasc', { brand_id: 77, original_brand_name: 'Acme' })];
      const { unmount } = renderEditor();
      expect(formDe('L-rasc').marcaGuardada, caso).toStrictEqual({
        brand_id: 77,
        original_brand_name: 'Acme',
      });
      digitarTitulo('L-rasc', 'Camiseta azul marinho');
      // The picker's contract: the row goes through `marcaDaLinhaParaRascunhoShopee`.
      act(() =>
        formDe('L-rasc').onCampo(
          'marca',
          marcaDaLinhaParaRascunhoShopee(row, formDe('L-rasc').marcaGuardada),
        ),
      );
      fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
      await waitFor(() => expect(atualizarRascunho, caso).toHaveBeenCalledTimes(1));
      const { patch } = atualizarRascunho.mock.calls[0]![0];
      if (marcaNoPatch === undefined) expect(patch, caso).not.toHaveProperty('marca');
      else expect(patch.marca, caso).toStrictEqual(marcaNoPatch);
      unmount();
    }
  });

  it('the size-chart line of a draft reads the category being EDITED — NEAR-MISS: a published listing keeps its stored one', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId),
    });
    h.produto = { nome: 'Camiseta', paiId: null, tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1' };
    h.tabMedi = {
      nome: 'Camisetas adulto',
      tabelasMedidasShopee: {
        'int-1': [{ categoryId: 100088, size_chart_id: 700024640, name: 'Camisetas' }],
      },
    };
    h.links = [rascunho('L-rasc', { category_id: 100087 }), link('L-pub', { item_id: 1000002 })];
    renderEditor();
    expect(within(bloco('L-rasc')).getByText(/não tem modelo para a categoria/)).toBeDefined();
    act(() => formDe('L-rasc').onCampo('category_id', 100088));
    expect(
      within(bloco('L-rasc')).getByText(/modelo #700024640 \(categoria «Camisetas»\)/),
    ).toBeDefined();
    expect(within(bloco('L-pub')).getByText(/não tem modelo para a categoria/)).toBeDefined();
  });

  it('a LOCAL draft holds no stored brand', () => {
    comAutoria();
    renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    expect(formDe(id!).marcaGuardada).toBeNull();
    expect(formDe(id!).divergencias).toEqual([]);
  });
});

describe('ShopeeEditor — a draft write that loses (#1911 P10, rule 7 tier 3)', () => {
  it('409 rascunhoConflito with fields opens the modal ⟷ `conflitos: []` is a sentence, no modal ⟷ `conflitos: null` says reload — never a success', async () => {
    comAutoria();
    const atualizarRascunho = vi
      .fn<ShopeeClient['atualizarRascunho']>()
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
          conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
        }),
      )
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, { conflitos: [] }),
      )
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, { conflitos: null }),
      );
    h.client = shopeeClientFalso({ atualizarRascunho });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    expect(h.conflito?.conflito).toStrictEqual({
      linkDocId: 'L-rasc',
      operacao: 'atualizar',
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
    });
    expect(h.conflito?.edicao?.atual.item_name).toBe('Camiseta azul marinho');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
    // Cancel keeps the entry as typed.
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        fraseDoConflitoDeConcorrenciaShopee('atualizar'),
      ),
    );
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        fraseDoConflitoIlegivelShopee('atualizar'),
      ),
    );
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
  });

  it('«Salvar mesmo assim» re-sends against the stored draft; a re-send that fails in ANOTHER way closes the modal and says why', async () => {
    comAutoria();
    const atualizarRascunho = vi
      .fn<ShopeeClient['atualizarRascunho']>()
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
          conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
        }),
      )
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, { conflitos: [] }),
      );
    h.client = shopeeClientFalso({ atualizarRascunho });
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (outra aba)' })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(2));
    // Rebased on the stored draft: its title is the base now.
    expect(atualizarRascunho.mock.calls[1]?.[0]).toMatchObject({
      base: { item_name: 'Camiseta (outra aba)' },
      patch: { item_name: 'Camiseta azul marinho' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        fraseDoConflitoDeConcorrenciaShopee('atualizar'),
      ),
    );
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
  });

  it('«Usar o que está salvo» takes the STORED values for the conflicting fields and sends nothing', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>().mockRejectedValueOnce(
      recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
      }),
    );
    h.client = shopeeClientFalso({ atualizarRascunho });
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (outra aba)' })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Usar o que está salvo' }));
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
    expect(tituloDo('L-rasc').value).toBe('Camiseta (outra aba)');
    expect(atualizarRascunho).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'only in category_id: the base carries the attributes that change clears',
      (id: string) => act(() => formDe(id).onCampo('category_id', 100088)),
      { category_id: 100087, item_name: 'Camiseta' },
      [{ campo: CAMPO_RASCUNHO_SHOPEE.categoryId, atual: 100087 }],
      {
        base: { category_id: 100087, attributes: null },
        patch: { category_id: 100088 },
      },
    ],
    [
      'only in item_name: the base is that field alone',
      (id: string) => digitarTitulo(id, 'Camiseta nova'),
      { category_id: null, item_name: 'Camiseta' },
      [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' }],
      { base: { item_name: 'Camiseta' }, patch: { item_name: 'Camiseta nova' } },
    ],
  ])(
    'a create retry’s «Salvar mesmo assim» differing %s — an UPDATE against the stored draft, never built from `conflitos`',
    async (_caso, editar, guardado, conflitos, esperado) => {
      comAutoria();
      const criarRascunho = vi
        .fn<ShopeeClient['criarRascunho']>()
        .mockRejectedValueOnce(
          recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, { conflitos }),
        );
      const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
        linkDocId: input.linkDocId,
        gravados: ['category_id'],
      }));
      h.client = shopeeClientFalso({
        criarRascunho,
        atualizarRascunho,
        limitesDoItem: async (input) => limitesDoItem(input.categoryId),
      });
      const { rerender } = renderEditor();
      novoAnuncio();
      const [id] = idsLocais();
      editar(id!);
      fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
      await screen.findByTestId('shopee-rascunho-conflito');
      // Until the snapshot holds the stored draft, nothing can be rebased on it.
      expect(h.conflito?.servidorCarregado).toBe(false);
      h.links = [rascunho(id!, guardado)];
      rerenderEditor(rerender);
      expect(h.conflito?.servidorCarregado).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
      await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
      expect(atualizarRascunho.mock.calls[0]?.[0]).toStrictEqual({
        integracaoId: 'int-1',
        produtoId: 'prod-1',
        linkDocId: id,
        ...esperado,
      });
      expect(criarRascunho).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull());
    },
  );

  it.each([
    [
      'rascunhoJaPublicado',
      CODIGO_FALHA_SHOPEE.rascunhoJaPublicado,
      409,
      FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
    ],
    [
      'rascunhoInexistente',
      CODIGO_FALHA_SHOPEE.rascunhoInexistente,
      404,
      FRASE_RASCUNHO_INEXISTENTE_SHOPEE,
    ],
  ])(
    'an edit refused %s drops the entry and says so on the block and in a toast',
    async (_c, code, status, frase) => {
      comAutoria();
      h.client = shopeeClientFalso({
        atualizarRascunho: () => Promise.reject(recusaDoRascunho(status, code)),
      });
      h.links = [rascunho('L-rasc')];
      renderEditor();
      digitarTitulo('L-rasc', 'Camiseta azul marinho');
      fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
      await waitFor(() =>
        expect(within(bloco('L-rasc')).getByTestId('shopee-desfecho-L-rasc')).toBeDefined(),
      );
      expect(within(bloco('L-rasc')).getByText(frase)).toBeDefined();
      expect(h.notify).toHaveBeenCalledWith({ color: 'orange', message: frase });
      expect(tituloDo('L-rasc').value).toBe('Camiseta azul');
    },
  );

  it('a 2xx it cannot read MAY have saved: never a success toast, the reload sentence, the entry kept', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      atualizarRascunho: () =>
        Promise.reject(
          new ShopeeClientRespostaInvalidaError('Resposta inválida.', 200, ['gravados.0']),
        ),
    });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        fraseDaRespostaIlegivelDoRascunhoShopee('atualizar'),
      ),
    );
    expect(h.notify).not.toHaveBeenCalled();
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
  });

  describe('R1-rule7#3 — an uncertain update that DID land', () => {
    const falhas: [string, () => Error][] = [
      [
        'a 2xx it cannot read',
        () => new ShopeeClientRespostaInvalidaError('Resposta inválida.', 200, ['gravados.0']),
      ],
      [
        'no answer (network)',
        () => new ShopeeClientNetworkError('Failed to fetch', new TypeError('x')),
      ],
    ];

    /** The uncertain save, then the echo storing `tituloGuardado` (cache-served when `ecoDoCache`). */
    async function salvarSemResposta(
      erro: () => Error,
      tituloGuardado: string,
      ecoDoCache = false,
    ) {
      comAutoria();
      const onDirtyChange = vi.fn();
      const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(() =>
        Promise.reject(erro()),
      );
      h.client = shopeeClientFalso({ atualizarRascunho });
      h.links = [rascunho('L-rasc')];
      const { rerender } = renderEditor({ onDirtyChange });
      digitarTitulo('L-rasc', 'Camiseta azul marinho');
      fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
      await waitFor(() => expect(screen.getByTestId('resultado-L-rasc')).toBeDefined());
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      h.fromCache = ecoDoCache;
      h.links = [rascunho('L-rasc', { item_name: tituloGuardado })];
      rerenderEditor(rerender, { onDirtyChange });
      return { onDirtyChange, atualizarRascunho, rerender };
    }

    /** ANOTHER operator saves the draft afterwards (a server-truth emission). */
    function outraAbaSalva(
      rerender: (ui: ReactNode) => void,
      onDirtyChange: (dirty: boolean) => void,
      campos: Record<string, unknown>,
    ) {
      h.fromCache = false;
      h.links = [rascunho('L-rasc', campos)];
      rerenderEditor(rerender, { onDirtyChange });
    }

    it.each(falhas)(
      '%s, then the echo holds the TYPED title ⇒ the entry drops silently: no divergence, the guard clean, the stored value shown, nothing left to send',
      async (_c, erro) => {
        const { onDirtyChange, atualizarRascunho } = await salvarSemResposta(
          erro,
          'Camiseta azul marinho',
        );
        expect(formDe('L-rasc').divergencias).toEqual([]);
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
        expect(formDe('L-rasc').bloco.sujo).toBe(false);
        expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);
        expect(atualizarRascunho).toHaveBeenCalledTimes(1);
      },
    );

    it.each(falhas)(
      'NEAR-MISS: %s, then ANOTHER tab’s title is stored ⇒ the entry is kept, the stale check names it, the guard stays armed',
      async (_c, erro) => {
        const { onDirtyChange } = await salvarSemResposta(erro, 'Título de outra aba');
        expect(formDe('L-rasc').divergencias).toEqual(['item_name']);
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
        expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
        expect(formDe('L-rasc').bloco.sujo).toBe(true);
      },
    );

    // Codex review of #2085, F1: the silent drop above used to be recomputed
    // on every render, so the NEXT write by anyone reconciled the same old
    // entry as `manter` and brought the already-saved text back, dirty.
    it.each(falhas)(
      'Codex F1: %s, the echo holds the TYPED title, then ANOTHER operator saves the draft ⇒ the dropped entry stays gone — their title shown, no divergence, the guard clean, nothing to send',
      async (_c, erro) => {
        const { onDirtyChange, atualizarRascunho, rerender } = await salvarSemResposta(
          erro,
          'Camiseta azul marinho',
        );
        // Positive first: the echo dropped it.
        expect(formDe('L-rasc').bloco.sujo).toBe(false);
        outraAbaSalva(rerender, onDirtyChange, { item_name: 'Título de outra aba' });
        expect(tituloDo('L-rasc').value).toBe('Título de outra aba');
        expect(formDe('L-rasc').divergencias).toEqual([]);
        expect(formDe('L-rasc').bloco.sujo).toBe(false);
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);
        expect(atualizarRascunho).toHaveBeenCalledTimes(1);
      },
    );

    it.each(falhas)(
      'NEAR-MISS (Codex F1): %s, an entry KEPT over another tab’s title is never removed — a further write still finds the operator’s text, dirty',
      async (_c, erro) => {
        const { onDirtyChange, rerender } = await salvarSemResposta(erro, 'Título de outra aba');
        outraAbaSalva(rerender, onDirtyChange, {
          item_name: 'Título de outra aba',
          description: 'Descrição de outra aba',
        });
        expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
        expect(formDe('L-rasc').bloco.sujo).toBe(true);
        expect(formDe('L-rasc').divergencias).toEqual(['item_name']);
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      },
    );

    it.each(falhas)(
      'NEAR-MISS (Codex F1): %s, a CACHE-served echo holding the typed title is no server truth — nothing typed is forgotten on its word: the server then holding another tab’s title shows the operator’s text WITH the divergence (tier 3), never a silent drop',
      async (_c, erro) => {
        const { onDirtyChange, rerender } = await salvarSemResposta(
          erro,
          'Camiseta azul marinho',
          true,
        );
        outraAbaSalva(rerender, onDirtyChange, { item_name: 'Título de outra aba' });
        expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
        expect(formDe('L-rasc').divergencias).toEqual(['item_name']);
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      },
    );

    // The drop is a RENDER-PHASE update: it acts on the state the dropping
    // render read. A removal applied after the commit instead (an effect, by
    // id) would land on whatever the id holds by then — here an edit queued at
    // a lower priority before the echo, rendered after it.
    it('NEAR-MISS (Codex F1): the final drop removes only what its render READ — an edit queued at a lower priority before the echo survives it, dirty', async () => {
      comAutoria();
      const onDirtyChange = vi.fn();
      h.client = shopeeClientFalso({
        atualizarRascunho: () =>
          Promise.reject(new ShopeeClientNetworkError('Failed to fetch', new TypeError('x'))),
      });
      h.links = [rascunho('L-rasc')];
      const { rerender } = renderEditor({ onDirtyChange });
      digitarTitulo('L-rasc', 'Camiseta azul marinho');
      fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
      await waitFor(() => expect(screen.getByTestId('resultado-L-rasc')).toBeDefined());
      const { onCampo } = formDe('L-rasc');
      const vistos: unknown[] = [];
      const registrar = h.rascunhos.set.bind(h.rascunhos);
      h.rascunhos.set = (k: string, v: RascunhoShopeeProps) => {
        vistos.push([v.bloco.valores.item_name, v.bloco.sujo]);
        return registrar(k, v);
      };
      // Queued OUTSIDE act (a transition): the echo's render below skips it.
      startTransition(() => onCampo('item_name', 'Camiseta verde'));
      h.links = [rascunho('L-rasc', { item_name: 'Camiseta azul marinho' })];
      rerenderEditor(rerender, { onDirtyChange });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // Positive first: the echo rendered BEFORE the edit — the entry dropped.
      expect(vistos[0]).toEqual(['Camiseta azul marinho', false]);
      expect(tituloDo('L-rasc').value).toBe('Camiseta verde');
      expect(formDe('L-rasc').bloco.sujo).toBe(true);
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });
  });

  it('NEAR-MISS (Codex F1): a drop WITH a notice is not forgotten by later writes — both notices outlive a further server snapshot until dismissed, and the guard stays clean', () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    h.links = [rascunho('L-a'), rascunho('L-b', { item_name: 'Outra' })];
    const { rerender } = renderEditor({ onDirtyChange });
    digitarTitulo('L-a', 'Editando A');
    digitarTitulo('L-b', 'Editando B');
    h.links = [link('L-a', { item_id: 1000005 })];
    rerenderEditor(rerender, { onDirtyChange });
    // A further write lands (the published listing renamed): a NEW emission.
    h.links = [link('L-a', { item_id: 1000005, item_name: 'Renomeado na Shopee' })];
    rerenderEditor(rerender, { onDirtyChange });
    expect(
      within(bloco('L-a')).getByText(FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE),
    ).toBeDefined();
    expect(
      within(screen.getByTestId('shopee-rascunho-aviso-L-b')).getByText(
        FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE,
      ),
    ).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(
      within(screen.getByTestId('shopee-rascunho-aviso-L-b')).getByRole('button', {
        name: 'Dispensar aviso',
      }),
    );
    expect(screen.queryByTestId('shopee-rascunho-aviso-L-b')).toBeNull();
    expect(
      within(bloco('L-a')).getByText(FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE),
    ).toBeDefined();
  });

  it('a dirty entry whose draft got PUBLISHED is dropped with a notice on its block; one DISCARDED elsewhere with a notice on the conta — a cache-served snapshot proves nothing gone', () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    const aba = () => screen.getByRole('tab', { name: /Loja A/ });
    h.links = [rascunho('L-a'), rascunho('L-b', { item_name: 'Outra' })];
    const { rerender } = renderEditor({ onDirtyChange });
    digitarTitulo('L-a', 'Editando A');
    digitarTitulo('L-b', 'Editando B');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // From the cache: L-b is absent, but nothing proves it is gone.
    h.fromCache = true;
    h.links = [link('L-a', { item_id: 1000005 })];
    rerenderEditor(rerender, { onDirtyChange });
    expect(
      within(bloco('L-a')).getByText(FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE),
    ).toBeDefined();
    expect(screen.queryByTestId('shopee-rascunho-aviso-L-b')).toBeNull();
    // NEAR-MISS: L-a is dropped, but L-b is KEPT (cache) and still dirty — armed.
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(aba().getAttribute('data-dirty')).toBe('true');

    h.fromCache = false;
    h.links = [link('L-a', { item_id: 1000005 })];
    rerenderEditor(rerender, { onDirtyChange });
    expect(
      within(screen.getByTestId('shopee-rascunho-aviso-L-b')).getByText(
        FRASE_RASCUNHO_DESCARTADO_DURANTE_EDICAO_SHOPEE,
      ),
    ).toBeDefined();
    // R3-tests#1: both entries are DROPPED (their notices still on screen, not
    // dismissed): the guard reads the RECONCILED entries, never the raw state —
    // a page save now must not be blocked by a draft that no longer exists.
    expect(
      within(bloco('L-a')).getByText(FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE),
    ).toBeDefined();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(aba().hasAttribute('data-dirty')).toBe(false);
    // Dismissed, it is forgotten.
    fireEvent.click(
      within(screen.getByTestId('shopee-rascunho-aviso-L-b')).getByRole('button', {
        name: 'Dispensar aviso',
      }),
    );
    expect(screen.queryByTestId('shopee-rascunho-aviso-L-b')).toBeNull();
    expect(
      within(bloco('L-a')).getByText(FRASE_RASCUNHO_PUBLICADO_DURANTE_EDICAO_SHOPEE),
    ).toBeDefined();
  });
});

describe('ShopeeEditor — discarding a draft (#1911 P10)', () => {
  it('a `livre` draft is confirmed, then discarded with ALL FIVE held fields VERBATIM as its base — never logistic_info', async () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: false,
    }));
    h.client = shopeeClientFalso({ descartarRascunho });
    // A P5-minted draft: `brand_id: 0`, no lock, no record ⇒ `livre`.
    h.links = [
      rascunho('L-rasc', {
        item_name: '',
        description: '  ',
        brand_id: 0,
        publicacaoEmCurso: null,
        logistic_info: [{ logistic_id: 1, enabled: true }],
      }),
    ];
    renderEditor();
    expect(formDe('L-rasc').bloco.publicacao).toStrictEqual({ tipo: 'livre' });
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
    expect(within(dialogo).getByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeDefined();
    expect(descartarRascunho).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Descartar rascunho' }));
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      base: {
        item_name: '',
        description: '  ',
        category_id: null,
        marca: { brand_id: 0, original_brand_name: null },
        attributes: null,
      },
    });
    await waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith({
        color: 'green',
        message: FRASE_RASCUNHO_DESCARTADO_SHOPEE,
      }),
    );
  });

  it('`incerta` opens the three-case dialog: (a) and (b) send the SAME attested body, (c) offers no discard', async () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: true,
    }));
    h.client = shopeeClientFalso({ descartarRascunho });
    const D = DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE;
    for (const rotulo of [D.naoExiste, D.existeVinculado]) {
      h.links = [rascunho('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
      const { unmount } = renderEditor();
      fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
      const dialogo = screen.getByRole('dialog', { name: D.titulo });
      // (c) is text only: the buttons are (a), (b) and Cancelar.
      expect(within(dialogo).getByText(D.existeSemVinculo)).toBeDefined();
      // (The modal's own close "X" has no text.)
      const rotulos = within(dialogo)
        .getAllByRole('button')
        .map((b) => b.textContent)
        .filter((t) => t !== '');
      expect(rotulos).toEqual([D.naoExiste, D.existeVinculado, 'Cancelar']);
      fireEvent.click(within(dialogo).getByRole('button', { name: rotulo }));
      await waitFor(() =>
        expect(h.notify).toHaveBeenCalledWith({
          color: 'green',
          message: FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE,
        }),
      );
      unmount();
      h.notify.mockClear();
    }
    expect(descartarRascunho).toHaveBeenCalledTimes(2);
    expect(descartarRascunho.mock.calls[0]?.[0]).toStrictEqual(
      descartarRascunho.mock.calls[1]?.[0],
    );
    expect(descartarRascunho.mock.calls[0]?.[0]).toMatchObject({ confirmarCriacaoIncerta: true });
  });

  it('a 409 rascunhoCriacaoIncerta on a plain discard opens the three-case dialog, which re-sends the SAME base attested', async () => {
    comAutoria();
    const descartarRascunho = vi
      .fn<ShopeeClient['descartarRascunho']>()
      .mockRejectedValueOnce(recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoCriacaoIncerta))
      .mockImplementationOnce(async (input) => ({
        linkDocId: input.linkDocId,
        descartado: true,
        criacaoIncerta: true,
      }));
    h.client = shopeeClientFalso({ descartarRascunho });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar rascunho' })).getByRole('button', {
        name: 'Descartar rascunho',
      }),
    );
    const D = DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE;
    const dialogo = await screen.findByRole('dialog', { name: D.titulo });
    fireEvent.click(within(dialogo).getByRole('button', { name: D.naoExiste }));
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(2));
    expect(descartarRascunho.mock.calls[0]?.[0]).not.toHaveProperty('confirmarCriacaoIncerta');
    expect(descartarRascunho.mock.calls[1]?.[0]).toStrictEqual({
      ...descartarRascunho.mock.calls[0]?.[0],
      confirmarCriacaoIncerta: true,
    });
  });

  it('a DIRTY draft is discarded against the base the operator LOADED, even after another tab saved it — the route then refuses (409), never deletes unseen', async () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>().mockRejectedValueOnce(
      recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
      }),
    );
    h.client = shopeeClientFalso({ descartarRascunho });
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (outra aba)' })];
    rerenderEditor(rerender);
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar rascunho' })).getByRole('button', {
        name: 'Descartar rascunho',
      }),
    );
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0].base.item_name).toBe('Camiseta azul');
    // A discard's conflict is a sentence, never the field modal.
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
      ),
    );
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
  });

  it('R1-rule7#4 / R8-copy#7 (verify): the exit the discard-conflict sentence names is ON SCREEN — a second Descartar re-sends the LOADED base (the safe loop) ⟷ after «Desfazer alterações» the block shows the current version and Descartar sends it', async () => {
    comAutoria();
    const conflito = () =>
      recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
      });
    const descartarRascunho = vi
      .fn<ShopeeClient['descartarRascunho']>()
      .mockRejectedValueOnce(conflito())
      .mockRejectedValueOnce(conflito())
      .mockResolvedValueOnce({ linkDocId: 'L-rasc', descartado: true, criacaoIncerta: false });
    h.client = shopeeClientFalso({ descartarRascunho });
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (outra aba)' })];
    rerenderEditor(rerender);
    const descartar = async (vezes: number) => {
      fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Descartar rascunho' })).getByRole('button', {
          name: 'Descartar rascunho',
        }),
      );
      await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(vezes));
    };

    await descartar(1);
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        FRASE_DESCARTE_EM_CONFLITO_SHOPEE,
      ),
    );
    // The sentence names «Desfazer alterações»: it is enabled on this block.
    await waitFor(() =>
      expect(botaoDoRascunho('L-rasc', 'Desfazer alterações').disabled).toBe(false),
    );
    // The loop is deliberate (K1-13): the block still shows the operator's text,
    // and a second discard sends the version they LOADED again — never the new one.
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
    await descartar(2);
    expect(descartarRascunho.mock.calls[1]?.[0].base.item_name).toBe('Camiseta azul');

    // The exit: the edits go, the current version shows, the sentence clears…
    await waitFor(() =>
      expect(botaoDoRascunho('L-rasc', 'Desfazer alterações').disabled).toBe(false),
    );
    fireEvent.click(botaoDoRascunho('L-rasc', 'Desfazer alterações'));
    expect(tituloDo('L-rasc').value).toBe('Camiseta (outra aba)');
    expect(screen.queryByTestId('resultado-L-rasc')).toBeNull();
    // …and the next discard sends the version now on screen.
    await descartar(3);
    expect(descartarRascunho.mock.calls[2]?.[0].base.item_name).toBe('Camiseta (outra aba)');
  });

  it('a LOCAL draft is discarded here, after a confirmation, with no request', () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
    h.client = shopeeClientFalso({ descartarRascunho });
    renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    fireEvent.click(botaoDoRascunho(id!, 'Descartar'));
    const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
    expect(within(dialogo).getByText(FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE)).toBeDefined();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Descartar rascunho' }));
    expect(screen.queryByTestId(`shopee-novo-rascunho-${id!}`)).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
  });
});

describe('ShopeeEditor — the draft’s publish reading moves with the clock (#1911 P10)', () => {
  const T0 = Date.UTC(2026, 9, 28, 15);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('em-andamento turns into incerta on its own, aguardarMs + 1 s later — never against a clock frozen at mount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    comAutoria();
    // STAMPED lock (it may have sent) beside an uncertain create on record:
    // expiry ⇒ `incerta`, no grace.
    const doc = rascunho('L-rasc', {
      publicacaoEmCurso: { desde: T0 - 299_000, expiraEm: T0 + 1_000, token: 't-1', sku: 'SKU-1' },
      criacaoIncertaDesde: T0 - 600_000,
    });
    h.links = [doc];
    renderEditor();
    const antes = estadoPublicacaoRascunhoShopee(doc.data, T0);
    if (antes.tipo !== 'em-andamento') throw new Error('fixture must read em-andamento');
    expect(
      within(raizDoRascunho('L-rasc')).getByText(fraseDoRascunhoEmAndamentoShopee(antes, T0)),
    ).toBeDefined();
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);
    expect(botaoDoRascunho('L-rasc', 'Descartar').disabled).toBe(true);
    expect(tituloDo('L-rasc').readOnly).toBe(true);
    // The badge reads the SAME block decision (R2-drafts#0).
    expect(within(bloco('L-rasc')).getByText(ROTULO_PUBLICACAO_EM_ANDAMENTO_SHOPEE)).toBeDefined();
    expect(within(bloco('L-rasc')).queryByText('Não publicado')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(within(raizDoRascunho('L-rasc')).queryByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(within(raizDoRascunho('L-rasc')).getByText(FRASE_RASCUNHO_INCERTO_SHOPEE)).toBeDefined();
    expect(formDe('L-rasc').bloco.descarte).toBe('atestar');
    expect(botaoDoRascunho('L-rasc', 'Descartar').disabled).toBe(false);
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    expect(within(bloco('L-rasc')).getByText(ROTULO_PUBLICACAO_INCERTA_SHOPEE)).toBeDefined();
    expect(within(bloco('L-rasc')).queryByText(ROTULO_PUBLICACAO_EM_ANDAMENTO_SHOPEE)).toBeNull();
    expect(within(bloco('L-rasc')).queryByText('Não publicado')).toBeNull();
  });

  it('a wall clock stepped back MORE than the 1 s re-read margin during a lock’s wait still ends it — the timer is clamped to the instant it was armed for (R3-tests#0)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    comAutoria();
    // UNSTAMPED, no record: at expiry it reads `livre` at once (§H Q3).
    h.links = [
      rascunho('L-rasc', {
        publicacaoEmCurso: { desde: T0 - 240_000, expiraEm: T0 + 60_000, token: 't-1' },
      }),
    ];
    renderEditor();
    expect(formDe('L-rasc').bloco.publicacao.tipo).toBe('em-andamento');
    expect(tituloDo('L-rasc').readOnly).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // ⚠️ MORE than `MARGEM_DA_RELEITURA_DO_ESTADO_SHOPEE_MS` (1 s): a step back
    // inside the margin reads the same with or without the `Math.max` clamp
    // (the kit test's `- 1` would not tell them apart here). The timer still
    // fires on schedule; the wall clock then reads 1.5 s BEFORE the lock ends.
    vi.setSystemTime(Date.now() - 1_500);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(formDe('L-rasc').bloco.publicacao).toStrictEqual({ tipo: 'livre' });
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    expect(botaoDoRascunho('L-rasc', 'Descartar').disabled).toBe(false);
  });

  it('the ONE timer fires at the EARLIEST draft’s change — the later lock listed FIRST still reads in progress (R3-tests#4)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    comAutoria();
    h.links = [
      // Listed first on purpose: an "always the first draft's instant" reducer
      // would wait for THIS one.
      rascunho('L-b', {
        publicacaoEmCurso: { desde: T0, expiraEm: T0 + 300_000, token: 't-b', sku: 'SKU-B' },
      }),
      rascunho('L-a', {
        publicacaoEmCurso: {
          desde: T0 - 270_000,
          expiraEm: T0 + 30_000,
          token: 't-a',
          sku: 'SKU-A',
        },
        criacaoIncertaDesde: T0 - 600_000,
      }),
    ];
    renderEditor();
    expect(formDe('L-a').bloco.publicacao.tipo).toBe('em-andamento');
    expect(formDe('L-b').bloco.publicacao.tipo).toBe('em-andamento');
    expect(tituloDo('L-a').readOnly).toBe(true);

    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(formDe('L-a').bloco.publicacao.tipo).toBe('incerta');
    expect(tituloDo('L-a').readOnly).toBe(false);
    expect(botaoDoRascunho('L-a', 'Descartar').disabled).toBe(false);
    expect(within(bloco('L-a')).getByText(ROTULO_PUBLICACAO_INCERTA_SHOPEE)).toBeDefined();
    // NEAR-MISS: the later lock is untouched by the earlier one's timer.
    expect(formDe('L-b').bloco.publicacao.tipo).toBe('em-andamento');
    expect(tituloDo('L-b').readOnly).toBe(true);
    expect(within(bloco('L-b')).getByText(ROTULO_PUBLICACAO_EM_ANDAMENTO_SHOPEE)).toBeDefined();
  });

  it('the earliest lock listed FIRST still releases first — an «always the LAST draft’s instant» reducer would wait for the later one (R3-tests#4, mirrored order)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    comAutoria();
    h.links = [
      rascunho('L-a', {
        publicacaoEmCurso: {
          desde: T0 - 270_000,
          expiraEm: T0 + 30_000,
          token: 't-a',
          sku: 'SKU-A',
        },
        criacaoIncertaDesde: T0 - 600_000,
      }),
      rascunho('L-b', {
        publicacaoEmCurso: { desde: T0, expiraEm: T0 + 300_000, token: 't-b', sku: 'SKU-B' },
      }),
    ];
    renderEditor();
    expect(formDe('L-a').bloco.publicacao.tipo).toBe('em-andamento');
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(formDe('L-a').bloco.publicacao.tipo).toBe('incerta');
    expect(tituloDo('L-a').readOnly).toBe(false);
    expect(formDe('L-b').bloco.publicacao.tipo).toBe('em-andamento');
  });

  it('§H Q3: an EXPIRED lock never stamped (no record) reads `livre` at once ⟷ the same lock STAMPED is still in progress (the post-expiry grace)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);
    comAutoria();
    const trava = { desde: T0 - 400_000, expiraEm: T0 - 100_000, token: 't-1' };
    h.links = [
      rascunho('L-livre', { publicacaoEmCurso: trava }),
      rascunho('L-carimbado', { publicacaoEmCurso: { ...trava, sku: 'SKU-1' } }),
    ];
    renderEditor();
    expect(formDe('L-livre').bloco.publicacao).toStrictEqual({ tipo: 'livre' });
    expect(botaoDoRascunho('L-livre', 'Descartar').disabled).toBe(false);
    expect(formDe('L-carimbado').bloco.publicacao).toMatchObject({
      tipo: 'em-andamento',
      posExpiracao: true,
    });
    expect(botaoDoRascunho('L-carimbado', 'Descartar').disabled).toBe(true);
  });
});

describe('ShopeeEditor — unsaved drafts and the page’s leave-guard (#1911 P10)', () => {
  it('reports dirty after a keystroke and clean after the save; marks the conta’s tab', async () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    h.client = shopeeClientFalso({
      atualizarRascunho: async (input) => ({ linkDocId: input.linkDocId, gravados: ['item_name'] }),
    });
    h.links = [rascunho('L-rasc')];
    renderEditor({ onDirtyChange });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('tab', { name: /Loja A/ }).hasAttribute('data-dirty')).toBe(false);

    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('tab', { name: /Loja A/ }).getAttribute('data-dirty')).toBe('true');

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole('tab', { name: /Loja A/ }).hasAttribute('data-dirty')).toBe(false);
  });

  it('a LOCAL new draft is unsaved work; «Desfazer alterações» on a stored one is clean again', () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    h.links = [rascunho('L-rasc')];
    renderEditor({ onDirtyChange });
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(botaoDoRascunho('L-rasc', 'Desfazer alterações'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul');

    // The conta holds that draft: the confirmation first — nothing exists yet.
    novoAnuncio();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(
      within(screen.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE })).getByRole(
        'button',
        { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE },
      ),
    );
    expect(idsLocais()).toHaveLength(1);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('hidden by an Activity and shown again, it NEVER reports clean while the typed draft is still there', () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    h.links = [rascunho('L-rasc')];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tela = (mode: 'visible' | 'hidden') => (
      <MantineTestProvider>
        <QueryClientProvider client={qc}>
          <Activity mode={mode}>
            <ShopeeEditor produtoId="prod-1" db={{} as Firestore} onDirtyChange={onDirtyChange} />
          </Activity>
        </QueryClientProvider>
      </MantineTestProvider>
    );
    const { rerender } = render(tela('visible'));
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    const depoisDoSujo = onDirtyChange.mock.calls.length;

    rerender(tela('hidden'));
    rerender(tela('visible'));
    const depois = onDirtyChange.mock.calls.slice(depoisDoSujo).map(([v]) => v as boolean);
    expect(depois).not.toContain(false);
    // The re-show re-reported the truth.
    expect(depois).toContain(true);
  });
});

describe('ShopeeEditor — who may author a draft (#1911 P10, D6)', () => {
  it.each([
    [
      'integracao.write without produto.write',
      [PERM.integracao.read, PERM.integracao.write],
      false,
    ],
    ['produto.write without integracao.write', [PERM.integracao.read, PERM.produto.write], false],
    [
      'both, on a read-only produto form',
      [PERM.integracao.read, PERM.integracao.write, PERM.produto.write],
      true,
    ],
  ])('%s ⇒ read-only fields, no draft button and no «Novo anúncio»', (_c, bits, disabled) => {
    h.permitidos = new Set(bits);
    h.links = [rascunho('L-rasc')];
    renderEditor({ disabled });
    // Positive first: the draft rendered.
    expect(raizDoRascunho('L-rasc')).toBeDefined();
    expect(tituloDo('L-rasc').readOnly).toBe(true);
    for (const nome of ['Salvar rascunho', 'Desfazer alterações', 'Descartar']) {
      expect(
        within(raizDoRascunho('L-rasc')).queryByRole('button', { name: nome }),
        nome,
      ).toBeNull();
    }
    expect(screen.queryByTestId('shopee-novo-anuncio-int-1')).toBeNull();
  });

  it('NEAR-MISS: both bits on an editable form ⇒ editable, the buttons, «Novo anúncio»', () => {
    comAutoria();
    h.links = [rascunho('L-rasc')];
    renderEditor();
    expect(tituloDo('L-rasc').readOnly).toBe(false);
    expect(botaoDoRascunho('L-rasc', 'Descartar')).toBeDefined();
    expect(screen.getByTestId('shopee-novo-anuncio-int-1')).toBeDefined();
  });

  it('a draft whose conta document is GONE is read-only with «Descartar» ALONE — the discard needs no conta document — no «Novo anúncio», and NOTHING is read for that conta (R2-drafts#2, #6)', async () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: false,
    }));
    const limitesDoItemFn = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId),
    );
    h.client = shopeeClientFalso({ descartarRascunho, limitesDoItem: limitesDoItemFn });
    h.links = [
      rascunho('L9', {
        contaProdutoShopeeOuterRef: 'documents/integracao/int-9',
        category_id: 100087,
        brand_id: 77,
        original_brand_name: 'Acme',
      }),
    ];
    renderEditor();
    fireEvent.click(await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ }));
    expect(tituloDo('L9').readOnly).toBe(true);
    const botoes = within(raizDoRascunho('L9'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(botoes).toEqual(['Descartar']);
    expect(formDe('L9').podeEditar).toBe(false);
    expect(formDe('L9').somenteDescartar).toBe(true);
    // R2-drafts#6: no conta to read for — the pickers get none, no bands asked.
    expect(formDe('L9').contaId).toBeNull();
    expect(limitesDoItemFn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shopee-novo-anuncio-int-9')).toBeNull();

    fireEvent.click(botaoDoRascunho('L9', 'Descartar'));
    const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Descartar rascunho' }));
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-9',
      produtoId: 'prod-1',
      linkDocId: 'L9',
      base: {
        item_name: 'Camiseta azul',
        description: null,
        category_id: 100087,
        marca: { brand_id: 77, original_brand_name: 'Acme' },
        attributes: null,
      },
    });
  });

  it('an `incerta` draft of a deleted conta still asks for the Seller-Centre attestation', async () => {
    comAutoria();
    h.links = [
      rascunho('L9', {
        contaProdutoShopeeOuterRef: 'documents/integracao/int-9',
        criacaoIncertaDesde: Date.now() - 600_000,
      }),
    ];
    renderEditor();
    fireEvent.click(await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ }));
    fireEvent.click(botaoDoRascunho('L9', 'Descartar'));
    expect(
      screen.getByRole('dialog', { name: DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.titulo }),
    ).toBeDefined();
  });

  it.each([
    ['the unreadable-ref tab', '', /Sem conta legível/, false],
    ['a reserved id no document can carry', 'integracao/__x__', /Conta __x__/, false],
    [
      'a conta whose by-id read is still in flight',
      'documents/integracao/int-9',
      /carregando/,
      true,
    ],
  ])(
    'NEAR-MISS: %s offers NO button and reads nothing for its conta',
    async (_caso, ref, aba, pendente) => {
      comAutoria();
      const limitesDoItemFn = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
        limitesDoItem(input.categoryId),
      );
      h.client = shopeeClientFalso({ limitesDoItem: limitesDoItemFn });
      if (pendente) h.getDoc.mockImplementation(() => new Promise(() => undefined));
      h.links = [rascunho('L9', { contaProdutoShopeeOuterRef: ref, category_id: 100087 })];
      renderEditor();
      fireEvent.click(await screen.findByRole('tab', { name: aba }));
      // Positive first: the draft rendered, read-only.
      expect(tituloDo('L9').readOnly).toBe(true);
      expect(within(raizDoRascunho('L9')).queryAllByRole('button')).toEqual([]);
      expect(formDe('L9').somenteDescartar).toBe(false);
      expect(formDe('L9').contaId).toBeNull();
      expect(limitesDoItemFn).not.toHaveBeenCalled();
    },
  );

  it('NEAR-MISS: an operator without produto.write gets no «Descartar» on a deleted conta’s draft either', async () => {
    h.permitidos = new Set([PERM.integracao.read, PERM.integracao.write]);
    h.links = [rascunho('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();
    fireEvent.click(await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ }));
    expect(within(raizDoRascunho('L9')).queryAllByRole('button')).toEqual([]);
    // …and a call past the missing button opens nothing.
    act(() => formDe('L9').onDescartar('confirmar'));
    expect(screen.queryByRole('dialog', { name: 'Descartar rascunho' })).toBeNull();
  });
});

describe('ShopeeEditor — a LOCAL draft whose conta is deleted elsewhere (#1911 P10, Codex review of #2085, F2)', () => {
  const lojaA = () => conta('int-1', 'Loja A');
  const lojaB = () => conta('int-2', 'Loja B');

  /** A local draft opened on int-2 (no stored link names that conta), the tab selected first. */
  function rascunhoLocalNaLojaB(contas: Linha[]) {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
    const criarRascunho = vi.fn<ShopeeClient['criarRascunho']>();
    h.client = shopeeClientFalso({ descartarRascunho, criarRascunho });
    h.contas = contas;
    const onDirtyChange = vi.fn();
    const { rerender } = renderEditor({ onDirtyChange });
    fireEvent.click(screen.getByRole('tab', { name: /Loja B/ }));
    novoAnuncio('int-2');
    const [id] = idsLocais();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    return { id: id!, descartarRascunho, criarRascunho, onDirtyChange, rerender };
  }

  it.each([
    ['another conta remains', () => [lojaA(), lojaB()], () => [lojaA()]],
    ['it was the ONLY conta', () => [lojaB()], (): Linha[] => []],
  ])(
    '%s: the draft keeps a «não encontrada» tab, marked unsaved, with «Descartar» ALONE — a LOCAL drop, no request — and the guard clears',
    async (_caso, antes, depois) => {
      const { id, descartarRascunho, criarRascunho, onDirtyChange, rerender } =
        rascunhoLocalNaLojaB(antes());
      // Deleted in another tab: the live query drops it, and its by-id read finds nothing.
      h.contas = depois();
      rerenderEditor(rerender, { onDirtyChange });
      const aba = await screen.findByRole('tab', { name: /Conta int-2 \(não encontrada\)/ });
      expect(aba.getAttribute('data-dirty')).toBe('true');
      expect(h.getDoc).toHaveBeenCalledWith({ __doc: 'integracao', id: 'int-2' });
      fireEvent.click(aba);
      expect(screen.getByTestId(`shopee-novo-rascunho-${id}`)).toBeDefined();
      expect(tituloDo(id).readOnly).toBe(true);
      expect(
        within(raizDoRascunho(id))
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Descartar']);
      expect(formDe(id).podeEditar).toBe(false);
      expect(formDe(id).contaId).toBeNull();
      expect(screen.queryByTestId('shopee-novo-anuncio-int-2')).toBeNull();
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);

      fireEvent.click(botaoDoRascunho(id, 'Descartar'));
      const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
      expect(within(dialogo).getByText(FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE)).toBeDefined();
      fireEvent.click(within(dialogo).getByRole('button', { name: 'Descartar rascunho' }));
      expect(screen.queryByTestId(`shopee-novo-rascunho-${id}`)).toBeNull();
      expect(descartarRascunho).not.toHaveBeenCalled();
      expect(criarRascunho).not.toHaveBeenCalled();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      // Nothing holds that tab any more.
      expect(screen.queryByRole('tab', { name: /Conta int-2/ })).toBeNull();
    },
  );

  it('NEAR-MISS: a conta that still EXISTS, merely past the bounded query, is read by id — its real tab and every button, never «não encontrada»', async () => {
    const { id, onDirtyChange, rerender } = rascunhoLocalNaLojaB([lojaA(), lojaB()]);
    h.contasPorId.set('int-2', lojaB().data);
    h.contas = [lojaA()];
    rerenderEditor(rerender, { onDirtyChange });
    await waitFor(() => expect(formDe(id).podeEditar).toBe(true));
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      expect.stringContaining('Loja A'),
      expect.stringContaining('Loja B'),
    ]);
    expect(screen.queryByRole('tab', { name: /não encontrada|carregando/ })).toBeNull();
    expect(tituloDo(id).readOnly).toBe(false);
    expect(formDe(id).contaId).toBe('int-2');
    expect(botaoDoRascunho(id, 'Salvar rascunho').disabled).toBe(false);
    expect(screen.getByTestId('shopee-novo-anuncio-int-2')).toBeDefined();
  });

  it('NEAR-MISS: a conta still in the query keeps today’s ONE tab — never a second one for its local draft, and nothing read by id', () => {
    const { id, onDirtyChange, rerender } = rascunhoLocalNaLojaB([lojaA(), lojaB()]);
    h.contas = [lojaA(), lojaB()];
    rerenderEditor(rerender, { onDirtyChange });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(h.getDoc).not.toHaveBeenCalled();
    expect(formDe(id).podeEditar).toBe(true);
    expect(formDe(id).contaId).toBe('int-2');
  });
});

describe('ShopeeEditor — «Salvar mesmo assim» overwrites only what the modal showed (#1911 P10 review, R1-rule7#0)', () => {
  const recusaDoTitulo = (atual: string) =>
    recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual }],
    });
  const corpo = (base: Record<string, unknown>, patch: Record<string, unknown>) => ({
    integracaoId: 'int-1',
    produtoId: 'prod-1',
    linkDocId: 'L-rasc',
    base,
    patch,
  });

  function editor(primeiro: ShopeeClientHttpError) {
    const atualizarRascunho = vi
      .fn<ShopeeClient['atualizarRascunho']>()
      .mockRejectedValueOnce(primeiro)
      .mockImplementation(async (input) => ({
        linkDocId: input.linkDocId,
        gravados: ['item_name'],
      }));
    h.client = shopeeClientFalso({
      atualizarRascunho,
      limitesDoItem: async (input) => limitesDoItem(input.categoryId),
    });
    return atualizarRascunho;
  }

  it('a TITLE-only 409 re-sends the title ALONE — the description and category another tab saved are never reverted (whole body)', async () => {
    comAutoria();
    const atualizarRascunho = editor(recusaDoTitulo('C'));
    h.links = [rascunho('L-rasc', { item_name: 'A', description: 'X', category_id: 100087 })];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'B');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    expect(atualizarRascunho.mock.calls[0]?.[0]).toStrictEqual(
      corpo({ item_name: 'A' }, { item_name: 'B' }),
    );
    // Tab 2 saved title, description AND category; the 409 lists the title only.
    h.links = [rascunho('L-rasc', { item_name: 'C', description: 'Y', category_id: 100088 })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(2));
    expect(atualizarRascunho.mock.calls[1]?.[0]).toStrictEqual(
      corpo({ item_name: 'C' }, { item_name: 'B' }),
    );
    // The untouched fields now SHOW what is stored, never the old values.
    expect(formDe('L-rasc').bloco.valores.description).toBe('Y');
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100088);
  });

  it('NEAR-MISS: a field the operator DID change (unlisted, not moved since) keeps their value against the base they LOADED', async () => {
    comAutoria();
    const atualizarRascunho = editor(recusaDoTitulo('C'));
    h.links = [rascunho('L-rasc', { item_name: 'A', description: 'X', category_id: 100087 })];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'B');
    act(() => formDe('L-rasc').onCampo('description', 'Minha'));
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'C', description: 'X', category_id: 100088 })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(2));
    expect(atualizarRascunho.mock.calls[1]?.[0]).toStrictEqual(
      corpo({ item_name: 'C', description: 'X' }, { item_name: 'B', description: 'Minha' }),
    );
  });

  it('a writer that lands WHILE the modal is open is SHOWN, never overwritten: the rows refresh and nothing is sent — the next click sends against what was shown', async () => {
    comAutoria();
    const atualizarRascunho = editor(recusaDoTitulo('Camiseta (outra aba)'));
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Minha');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    // A THIRD writer: the stored title is no longer the one the modal shows.
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (terceira aba)' })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    expect(atualizarRascunho).toHaveBeenCalledTimes(1);
    expect(h.conflito?.conflito).toStrictEqual({
      linkDocId: 'L-rasc',
      operacao: 'atualizar',
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (terceira aba)' }],
      renovado: true,
    });
    expect(tituloDo('L-rasc').value).toBe('Minha');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(2));
    expect(atualizarRascunho.mock.calls[1]?.[0]).toStrictEqual(
      corpo({ item_name: 'Camiseta (terceira aba)' }, { item_name: 'Minha' }),
    );
  });

  it('a CHANGED field the 409 did not list that moves while the modal is open joins the rows — shown before it is overwritten', async () => {
    comAutoria();
    const atualizarRascunho = editor(recusaDoTitulo('C'));
    h.links = [rascunho('L-rasc', { item_name: 'A', description: 'X' })];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'B');
    act(() => formDe('L-rasc').onCampo('description', 'Minha'));
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'C', description: 'Z' })];
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    expect(atualizarRascunho).toHaveBeenCalledTimes(1);
    expect(h.conflito?.conflito?.conflitos).toStrictEqual([
      { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'C' },
      { campo: CAMPO_RASCUNHO_SHOPEE.description, atual: 'Z' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(2));
    expect(atualizarRascunho.mock.calls[1]?.[0]).toStrictEqual(
      corpo({ item_name: 'C', description: 'Z' }, { item_name: 'B', description: 'Minha' }),
    );
  });

  it('«Usar o que está salvo» leaves NOTHING to save when only the listed field was typed: Salvar disabled, the leave-guard clean, the untouched fields stored', async () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    const atualizarRascunho = editor(recusaDoTitulo('C'));
    h.links = [rascunho('L-rasc', { item_name: 'A', description: 'X', category_id: 100087 })];
    const { rerender } = renderEditor({ onDirtyChange });
    digitarTitulo('L-rasc', 'B');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'C', description: 'Y', category_id: 100088 })];
    rerenderEditor(rerender, { onDirtyChange });
    fireEvent.click(screen.getByRole('button', { name: 'Usar o que está salvo' }));
    expect(tituloDo('L-rasc').value).toBe('C');
    expect(formDe('L-rasc').bloco.valores.description).toBe('Y');
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100088);
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(atualizarRascunho).toHaveBeenCalledTimes(1);
  });

  it('NEAR-MISS: «Usar o que está salvo» keeps an UNLISTED field the operator changed — still dirty, Salvar enabled', async () => {
    comAutoria();
    const onDirtyChange = vi.fn();
    editor(recusaDoTitulo('C'));
    h.links = [rascunho('L-rasc', { item_name: 'A', description: 'X' })];
    const { rerender } = renderEditor({ onDirtyChange });
    digitarTitulo('L-rasc', 'B');
    act(() => formDe('L-rasc').onCampo('description', 'Minha'));
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'C', description: 'X' })];
    rerenderEditor(rerender, { onDirtyChange });
    fireEvent.click(screen.getByRole('button', { name: 'Usar o que está salvo' }));
    expect(tituloDo('L-rasc').value).toBe('C');
    expect(formDe('L-rasc').bloco.valores.description).toBe('Minha');
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});

describe('ShopeeEditor — the discard confirmation follows the draft (#1911 P10 review, R2-drafts#1)', () => {
  const dialogoDescarte = () => screen.queryByRole('dialog', { name: 'Descartar rascunho' });

  function abrirDescarte() {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: false,
    }));
    h.client = shopeeClientFalso({ descartarRascunho });
    h.links = [rascunho('L-rasc')];
    const r = renderEditor();
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    expect(within(dialogoDescarte()!).getByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeDefined();
    return { ...r, descartarRascunho };
  }

  it('a draft PUBLISHED while the dialog is open: it closes — «Nada foi publicado» is never left over a live listing', () => {
    const { rerender, descartarRascunho } = abrirDescarte();
    h.links = [link('L-rasc', { item_id: 2000002 })];
    rerenderEditor(rerender);
    expect(dialogoDescarte()).toBeNull();
    expect(screen.queryByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
  });

  it('a publish that TAKES the lock while it is open closes it — and a lock released later never re-opens it on its own', () => {
    const { rerender, descartarRascunho } = abrirDescarte();
    const agora = Date.now();
    h.links = [
      rascunho('L-rasc', {
        publicacaoEmCurso: {
          desde: agora - 1_000,
          expiraEm: agora + 200_000,
          token: 't-x',
          sku: 'SKU-1',
        },
      }),
    ];
    rerenderEditor(rerender);
    expect(dialogoDescarte()).toBeNull();
    h.links = [rascunho('L-rasc', { publicacaoEmCurso: null })];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').bloco.publicacao).toStrictEqual({ tipo: 'livre' });
    expect(dialogoDescarte()).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
  });

  it('a draft that turned `incerta` while it is open becomes the three-case dialog — the plain sentence is no longer true — and sends the base the operator SAW, attested', async () => {
    const { rerender, descartarRascunho } = abrirDescarte();
    h.links = [rascunho('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    rerenderEditor(rerender);
    expect(dialogoDescarte()).toBeNull();
    expect(screen.queryByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeNull();
    const D = DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE;
    const dialogo = screen.getByRole('dialog', { name: D.titulo });
    fireEvent.click(within(dialogo).getByRole('button', { name: D.naoExiste }));
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0]).toMatchObject({
      base: { item_name: 'Camiseta azul' },
      confirmarCriacaoIncerta: true,
    });
  });

  it('the THREE-CASE dialog follows the draft too: published, or a publish took the lock, it closes — whether the reading or the route’s 409 opened it', async () => {
    const D = DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE;
    const trava = () => ({
      desde: Date.now() - 1_000,
      expiraEm: Date.now() + 200_000,
      token: 't-x',
      sku: 'SKU-1',
    });
    const incerto = { criacaoIncertaDesde: Date.now() - 600_000 };
    // Opened by the READING (an incerta draft).
    for (const depois of [
      () => link('L-rasc', { item_id: 2000002 }),
      () => rascunho('L-rasc', { ...incerto, publicacaoEmCurso: trava() }),
    ]) {
      comAutoria();
      const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
      h.client = shopeeClientFalso({ descartarRascunho });
      h.links = [rascunho('L-rasc', incerto)];
      const { rerender, unmount } = renderEditor();
      fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
      expect(screen.getByRole('dialog', { name: D.titulo })).toBeDefined();
      h.links = [depois()];
      rerenderEditor(rerender);
      expect(screen.queryByRole('dialog', { name: D.titulo })).toBeNull();
      expect(descartarRascunho).not.toHaveBeenCalled();
      unmount();
    }
    // Opened by the ROUTE’s 409 criacaoIncerta on a draft that reads livre.
    for (const depois of [
      () => link('L-rasc', { item_id: 2000002 }),
      () => rascunho('L-rasc', { publicacaoEmCurso: trava() }),
    ]) {
      comAutoria();
      const descartarRascunho = vi
        .fn<ShopeeClient['descartarRascunho']>()
        .mockRejectedValueOnce(recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoCriacaoIncerta));
      h.client = shopeeClientFalso({ descartarRascunho });
      h.links = [rascunho('L-rasc')];
      const { rerender, unmount } = renderEditor();
      fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Descartar rascunho' })).getByRole('button', {
          name: 'Descartar rascunho',
        }),
      );
      await screen.findByRole('dialog', { name: D.titulo });
      h.links = [depois()];
      rerenderEditor(rerender);
      expect(screen.queryByRole('dialog', { name: D.titulo })).toBeNull();
      expect(descartarRascunho).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('NEAR-MISS: a concurrent title edit keeps it open and enabled, and the confirm sends the HELD base (the route’s 409 answers it)', async () => {
    const { rerender, descartarRascunho } = abrirDescarte();
    h.links = [rascunho('L-rasc', { item_name: 'Outro título' })];
    rerenderEditor(rerender);
    const dialogo = dialogoDescarte()!;
    const confirmar = within(dialogo).getByRole('button', {
      name: 'Descartar rascunho',
    }) as HTMLButtonElement;
    expect(confirmar.disabled).toBe(false);
    fireEvent.click(confirmar);
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0].base.item_name).toBe('Camiseta azul');
  });
});

describe('ShopeeEditor — every draft handler re-checks its own gate (#1911 P10 review, R3-tests#5)', () => {
  it('«Salvar rascunho» called past its disabled button sends nothing — a produto turned VIRTUAL KIT, or the bit gone — ⟷ NEAR-MISS the same call with the gate open sends', async () => {
    const casos: [string, () => void][] = [
      [
        'virtual kit',
        () => {
          h.produto = { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true };
        },
      ],
      [
        'no produto.write',
        () => {
          h.permitidos = new Set([PERM.integracao.read, PERM.integracao.write]);
        },
      ],
    ];
    for (const [caso, fechar] of casos) {
      comAutoria();
      h.produto = { nome: 'Camiseta', paiId: null };
      const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
        linkDocId: input.linkDocId,
        gravados: ['item_name'],
      }));
      h.client = shopeeClientFalso({ atualizarRascunho });
      h.links = [rascunho('L-rasc')];
      const { rerender, unmount } = renderEditor();
      digitarTitulo('L-rasc', 'Camiseta azul marinho');
      fechar();
      rerenderEditor(rerender);
      expect(formDe('L-rasc').bloco.podeSalvar, caso).toBe(false);
      act(() => formDe('L-rasc').onSalvar());
      expect(atualizarRascunho, caso).not.toHaveBeenCalled();
      unmount();
    }
    // NEAR-MISS: the gate open, the same direct call sends.
    comAutoria();
    h.produto = { nome: 'Camiseta', paiId: null };
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['item_name'],
    }));
    h.client = shopeeClientFalso({ atualizarRascunho });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    act(() => formDe('L-rasc').onSalvar());
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
  });

  it('«Desfazer» called on a LOCAL new draft (never offered there) keeps its typed text — ⟷ NEAR-MISS on a dirty stored draft it undoes', () => {
    comAutoria();
    h.links = [rascunho('L-rasc')];
    renderEditor();
    // Positive: offered on the dirty stored draft, it undoes.
    digitarTitulo('L-rasc', 'Editado');
    act(() => formDe('L-rasc').onDesfazer());
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul');

    // The conta holds that draft: confirm the second listing.
    novoAnuncio();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE })).getByRole(
        'button',
        { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE },
      ),
    );
    const [id] = idsLocais();
    digitarTitulo(id!, 'Rascunho novo');
    expect(formDe(id!).bloco.podeDesfazer).toBe(false);
    act(() => formDe(id!).onDesfazer());
    expect(screen.getByTestId(`shopee-novo-rascunho-${id!}`)).toBeDefined();
    expect(tituloDo(id!).value).toBe('Rascunho novo');
  });

  it('«Descartar» called while a publish holds the lock opens nothing and sends nothing', () => {
    comAutoria();
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
    h.client = shopeeClientFalso({ descartarRascunho });
    const agora = Date.now();
    h.links = [
      rascunho('L-rasc', {
        publicacaoEmCurso: { desde: agora - 10_000, expiraEm: agora + 60_000, token: 't-1' },
      }),
    ];
    renderEditor();
    expect(botaoDoRascunho('L-rasc', 'Descartar').disabled).toBe(true);
    act(() => formDe('L-rasc').onDescartar('confirmar'));
    expect(screen.queryByRole('dialog', { name: 'Descartar rascunho' })).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
  });

  it('«Salvar mesmo assim» re-checks too: a produto turned VIRTUAL KIT while the modal is open sends nothing and closes it', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>().mockRejectedValueOnce(
      recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoConflito, {
        conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta (outra aba)' }],
      }),
    );
    h.client = shopeeClientFalso({ atualizarRascunho });
    h.links = [rascunho('L-rasc')];
    const { rerender } = renderEditor();
    digitarTitulo('L-rasc', 'Minha');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    h.links = [rascunho('L-rasc', { item_name: 'Camiseta (outra aba)' })];
    h.produto = { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true };
    rerenderEditor(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
    expect(atualizarRascunho).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('shopee-rascunho-conflito')).toBeNull();
  });

  it('the second-listing re-send re-checks too: a produto turned VIRTUAL KIT meanwhile sends no second create', async () => {
    comAutoria();
    const criarRascunho = vi
      .fn<ShopeeClient['criarRascunho']>()
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio, {
          vinculos: [{ linkDocId: 'L-a', itemId: 1000009, rascunho: false }],
        }),
      )
      .mockImplementation(async (input) => ({ linkDocId: input.linkDocId, criado: true }));
    h.client = shopeeClientFalso({ criarRascunho });
    const { rerender } = renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    const dialogo = await screen.findByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO_SHOPEE });
    h.produto = { nome: 'Kit', paiId: null, ehKit: true, ehKitVirtual: true };
    rerenderEditor(rerender);
    fireEvent.click(
      within(dialogo).getByRole('button', { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE }),
    );
    expect(criarRascunho).toHaveBeenCalledTimes(1);
  });
});

describe('ShopeeEditor — a failed session refresh on a draft call is pt-BR, never the SDK’s English (#1911 P10 review, R8-copy#14)', () => {
  const REDE = new FirebaseError(
    'auth/network-request-failed',
    'Firebase: Error (auth/network-request-failed).',
  );
  const EXPIRADA = new FirebaseError(
    'auth/user-token-expired',
    'Firebase: Error (auth/user-token-expired).',
  );

  it('the create: «sem conexão», nothing sent, the draft kept and Salvar still offered — never «Firebase: Error»', async () => {
    comAutoria();
    h.client = shopeeClientFalso({ criarRascunho: () => Promise.reject(REDE) });
    renderEditor();
    novoAnuncio();
    const [id] = idsLocais();
    fireEvent.click(botaoDoRascunho(id!, 'Salvar rascunho'));
    await waitFor(() =>
      expect(formDe(id!).resultado).toStrictEqual({
        mensagem: FRASE_SESSAO_SEM_CONEXAO_SHOPEE,
        incerto: false,
      }),
    );
    expect(screen.queryByText(/Firebase/)).toBeNull();
    expect(botaoDoRascunho(id!, 'Salvar rascunho').disabled).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: an EXPIRED session on an edit asks for a new sign-in, never a retry — the typed text survives', async () => {
    comAutoria();
    h.client = shopeeClientFalso({ atualizarRascunho: () => Promise.reject(EXPIRADA) });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    digitarTitulo('L-rasc', 'Camiseta azul marinho');
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        FRASE_SESSAO_NAO_RENOVADA_SHOPEE,
      ),
    );
    expect(tituloDo('L-rasc').value).toBe('Camiseta azul marinho');
    expect(formDe('L-rasc').resultado?.incerto).toBe(false);
  });

  it('the discard too', async () => {
    comAutoria();
    h.client = shopeeClientFalso({ descartarRascunho: () => Promise.reject(REDE) });
    h.links = [rascunho('L-rasc')];
    renderEditor();
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar rascunho' })).getByRole('button', {
        name: 'Descartar rascunho',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('resultado-L-rasc').textContent).toBe(
        FRASE_SESSAO_SEM_CONEXAO_SHOPEE,
      ),
    );
  });

  it('the wording, by code: the network failure ⟷ every other code', () => {
    expect(fraseDaSessaoShopee(REDE)).toBe(FRASE_SESSAO_SEM_CONEXAO_SHOPEE);
    expect(fraseDaSessaoShopee(EXPIRADA)).toBe(FRASE_SESSAO_NAO_RENOVADA_SHOPEE);
    expect(fraseDaSessaoShopee(new FirebaseError('auth/user-disabled', 'x'))).toBe(
      FRASE_SESSAO_NAO_RENOVADA_SHOPEE,
    );
    for (const frase of [FRASE_SESSAO_SEM_CONEXAO_SHOPEE, FRASE_SESSAO_NAO_RENOVADA_SHOPEE]) {
      expect(frase).toContain('nada foi enviado');
    }
  });
});

describe('ShopeeEditor — a legacy category_id 0 asks apps/shopee nothing (#1911 P10 review, R7-roundtrip#2)', () => {
  it('a stored `0` never requests the bands ⟷ NEAR-MISS a positive id does', async () => {
    comAutoria();
    const limitesDoItemFn = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId),
    );
    h.client = shopeeClientFalso({ limitesDoItem: limitesDoItemFn });
    h.links = [rascunho('L-zero', { category_id: 0 }), rascunho('L-ok', { category_id: 100017 })];
    renderEditor();
    await waitFor(() => expect(formDe('L-ok').limites).not.toBeNull());
    expect(limitesDoItemFn.mock.calls.map(([i]) => i)).toStrictEqual([
      { integracaoId: 'int-1', categoryId: 100017 },
    ]);
    expect(formDe('L-zero').limites).toBeNull();
    expect(formDe('L-zero').bloco.valores.category_id).toBe(0);
  });
});

describe('ShopeeEditor — a draft’s badge reads its block decision (#1911 P10 review, R2-drafts#0)', () => {
  it('`livre` keeps «Não publicado» — the e2e’s deliberate reading', () => {
    comAutoria();
    h.links = [rascunho('L-rasc')];
    renderEditor();
    expect(formDe('L-rasc').bloco.publicacao).toStrictEqual({ tipo: 'livre' });
    expect(within(bloco('L-rasc')).getByText('Não publicado')).toBeDefined();
    expect(within(bloco('L-rasc')).queryByText(ROTULO_PUBLICACAO_INCERTA_SHOPEE)).toBeNull();
  });

  it('NEAR-MISS: a native-kit link with no item_id is no draft — «Não publicado», whatever its lock fields say', () => {
    h.links = [
      link('L-kit', {
        item_id: null,
        kitNativo: true,
        criacaoIncertaDesde: Date.now() - 600_000,
      }),
    ];
    renderEditor();
    expect(within(bloco('L-kit')).getByText('Não publicado')).toBeDefined();
    expect(within(bloco('L-kit')).queryByText(ROTULO_PUBLICACAO_INCERTA_SHOPEE)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                #1911 P11 — «Publicar» on a listing DRAFT                    */
/* -------------------------------------------------------------------------- */

/** Inside category 100087's title band (20–137, `limitesDoItem`). */
const TITULO_PRONTO = 'Camiseta azul de algodão, tamanho M';
/** The STORED produto Descrição, inside the 100–5000 band (the draft has none of its own). */
const DESCRICAO_DO_PRODUTO = 'Camiseta de algodão penteado, '.repeat(5);

/** A stored draft the publish would take: a category, «Sem marca», a title in the band. */
const rascunhoPronto = (id: string, extra: Record<string, unknown> = {}): Linha =>
  rascunho(id, {
    item_name: TITULO_PRONTO,
    category_id: 100087,
    brand_id: 0,
    original_brand_name: null,
    ...extra,
  });

/** The ordinary listing's 202, as the route answers it (its `aguardarMs` is the constant). */
const itemIncerto = (linkDocId: string): RespostaPublicarShopee => ({
  tipo: 'item-incerto',
  arma: 'item',
  desfecho: 'incerto',
  linkDocId,
  aguardarMs: AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  reenvioVerificaSku: true,
  recusa: null,
});

/** The props the outcome panel of `linkDocId` got on the LAST render. */
const desfechoDe = (linkDocId: string): DesfechoAcaoShopeeProps => {
  const p = h.desfechos.get(linkDocId);
  if (p === undefined) throw new Error(`no outcome rendered for ${linkDocId}`);
  return p;
};
const dialogoDePublicar = () =>
  screen.getByRole('dialog', { name: TITULO_PUBLICAR_RASCUNHO_SHOPEE });
const semDialogoDePublicar = () =>
  screen.queryByRole('dialog', { name: TITULO_PUBLICAR_RASCUNHO_SHOPEE });
const publicarDo = (linkDocId: string) =>
  botaoDoRascunho(linkDocId, ROTULO_PUBLICAR_RASCUNHO_SHOPEE);
const confirmarPublicacao = () =>
  fireEvent.click(
    within(dialogoDePublicar()).getByRole('button', { name: 'Confirmar publicação' }),
  );
/** What a live link's 404 reads (`MENSAGEM_VINCULO_FORA_DA_CONTA`) — never a draft's. */
const FORA_DA_CONTA = 'Este vínculo não pertence mais a esta conta — a lista foi atualizada.';

/**
 * The operator may author, the stored produto has its Descrição, and the bands
 * answer — and (#1911 P13) the category's attribute tree, with no attribute:
 * «Publicar» waits on that read too.
 */
function prontoParaPublicar(publicar: ShopeeClient['publicar'], extra: Partial<ShopeeClient> = {}) {
  comAutoria();
  h.extraData = { descricao: DESCRICAO_DO_PRODUTO };
  h.client = shopeeClientFalso({
    limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
    atributos: async (input) => respostaAtributos(input.categoryId),
    publicar,
    ...extra,
  });
}

/** Renders, then waits for the bands: the ready draft's Publicar enabled (positive first). */
async function renderPronto(linkDocId = 'L-rasc') {
  const r = renderEditor();
  await waitFor(() => expect(publicarDo(linkDocId).disabled).toBe(false));
  return r;
}

describe('ShopeeEditor — «Publicar» on a draft (#1911 P11)', () => {
  it('a ready draft: «Publicar» opens the confirmation and sends NOTHING; Cancelar sends nothing; the confirm publishes by linkDocId ALONE', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: true,
      impedimento: null,
    });
    // The bands of the draft's OWN category are what the gate and the form read.
    expect(formDe('L-rasc').limites).toStrictEqual(limitesDoItem(100087).limites);

    fireEvent.click(publicarDo('L-rasc'));
    expect(dialogoDePublicar()).toBeDefined();
    expect(within(dialogoDePublicar()).queryByTestId('aviso-segundo-anuncio')).toBeNull();
    expect(formDe('L-rasc').confirmacaoDePublicacao).toStrictEqual({
      segundoAnuncio: null,
      pausado: false,
      atestacao: null,
    });
    expect(publicar).not.toHaveBeenCalled();
    fireEvent.click(within(dialogoDePublicar()).getByRole('button', { name: 'Cancelar' }));
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).not.toHaveBeenCalled();

    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    expect(semDialogoDePublicar()).toBeNull();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    // EXACTLY three keys: never a `categoryId`, a status, a kit flag or a confirmation not given.
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
    });
    // The outcome holds the REQUEST's «Criar pausado» (#14): a 200 never says «criado».
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
        tipo: 'publicado',
        resposta: ITEM_REPUBLICADO,
        pedidoRascunho: { pausado: false },
      }),
    );
  });

  it('«Criar pausado» sends status UNLIST, and the outcome remembers it was ASKED', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    fireEvent.click(within(dialogoDePublicar()).getByRole('checkbox'));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    expect(publicar.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      status: 'UNLIST',
    });
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toMatchObject({ pedidoRascunho: { pausado: true } }),
    );
  });

  it('NEAR-MISS: a LIVE listing’s republish records no draft request, and its outcome gets no draft inputs', async () => {
    comEscrita();
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    h.client = shopeeClientFalso({ publicar });
    h.links = [link('L-vivo')];
    renderEditor();
    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() =>
      expect(desfechoDe('L-vivo').desfecho).toStrictEqual({
        tipo: 'publicado',
        resposta: ITEM_REPUBLICADO,
        pedidoRascunho: null,
      }),
    );
    expect(desfechoDe('L-vivo').rascunho).toBeNull();
  });

  it.each<[string, () => void, string]>([
    [
      'the bands are not loaded yet',
      () => {
        h.client = shopeeClientFalso({ limitesDoItem: () => new Promise(() => undefined) });
      },
      'faixas-desconhecidas',
    ],
    [
      'the snapshot is a cached copy',
      () => {
        h.fromCache = true;
      },
      'carregando',
    ],
    [
      'the draft has a pendência (no brand chosen)',
      () => {
        h.links = [rascunhoPronto('L-rasc', { brand_id: null })];
      },
      'pendencias',
    ],
    [
      'a publish lock is in progress (stamped)',
      () => {
        const agora = Date.now();
        h.links = [
          rascunhoPronto('L-rasc', {
            publicacaoEmCurso: {
              desde: agora,
              expiraEm: agora + 300_000,
              token: 't-1',
              sku: 'SKU-1',
            },
          }),
        ];
      },
      'publicacao-em-andamento',
    ],
  ])(
    'Publicar is disabled while %s — and its click opens nothing',
    async (_caso, preparar, impedimento) => {
      prontoParaPublicar(vi.fn<ShopeeClient['publicar']>());
      h.links = [rascunhoPronto('L-rasc')];
      preparar();
      renderEditor();
      await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe(impedimento));
      expect(publicarDo('L-rasc').disabled).toBe(true);
      // The handler re-checks the gate: even a call past the disabled button opens nothing.
      act(() => formDe('L-rasc').onPublicar());
      expect(semDialogoDePublicar()).toBeNull();
      expect(formDe('L-rasc').confirmacaoDePublicacao).toBeNull();
    },
  );

  it('NEAR-MISS: an `incerta` draft is NOT blocked — its publish is a real one (ENSURE first), and it carries no attestation unasked', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    await renderPronto();
    expect(formDe('L-rasc').bloco.publicacao.tipo).toBe('incerta');
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    expect(publicar.mock.calls[0]?.[0]).not.toHaveProperty('confirmarCriacaoIncerta');
    // ENSURE adopted (or created): the 200 is the item outcome, as on a `livre`
    // draft — never «falhou», never the no-answer notice (rev. 2a §D P11 tests).
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
        tipo: 'publicado',
        resposta: ITEM_REPUBLICADO,
        pedidoRascunho: { pausado: false },
      }),
    );
    expect(within(bloco('L-rasc')).queryByText(/falhou/i)).toBeNull();
  });

  it('the produto FORM unsaved disables Publicar (K2-7: the route reads the STORED produto) — read from the surrounding form; NEAR-MISS the same form clean again', async () => {
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>());
    h.links = [rascunhoPronto('L-rasc')];
    function ComOFormularioDoProduto() {
      const form = useForm({ defaultValues: { nome: 'Camiseta' } });
      return (
        <FormProvider {...form}>
          <button
            type="button"
            onClick={() => form.setValue('nome', 'Camiseta nova', { shouldDirty: true })}
          >
            sujar o produto
          </button>
          <button type="button" onClick={() => form.reset()}>
            limpar o produto
          </button>
          <ShopeeEditor produtoId="prod-1" db={{} as Firestore} />
        </FormProvider>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineTestProvider>
        <QueryClientProvider client={qc}>
          <ComOFormularioDoProduto />
        </QueryClientProvider>
      </MantineTestProvider>,
    );
    await waitFor(() => expect(publicarDo('L-rasc').disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'sujar o produto' }));
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('produto-nao-salvo');
    expect(publicarDo('L-rasc').disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'limpar o produto' }));
    expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true);
    expect(publicarDo('L-rasc').disabled).toBe(false);
  });

  it('one write at a time: while the publish is in flight the block shows ITS spinner and the gate reads `ocupado`', async () => {
    let soltar: (r: RespostaPublicarShopee) => void = () => undefined;
    const publicar = vi.fn<ShopeeClient['publicar']>(
      () =>
        new Promise((resolve) => {
          soltar = resolve;
        }),
    );
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(formDe('L-rasc').emVoo).toBe('publicar'));
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('ocupado');
    act(() => formDe('L-rasc').onPublicar());
    expect(semDialogoDePublicar()).toBeNull();
    await act(async () => {
      soltar(ITEM_REPUBLICADO);
      await Promise.resolve();
    });
    expect(publicar).toHaveBeenCalledTimes(1);
    expect(formDe('L-rasc').emVoo).toBeNull();
  });

  it.each<[string, Linha[], ExistentesNaContaShopee | null]>([
    [
      'a live listing',
      [link('L-vivo')],
      { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 },
    ],
    [
      'another stored draft',
      [rascunho('L-outro')],
      { quantidade: 1, comRascunho: true, naShopee: 0, rascunhos: 1 },
    ],
    [
      'only a REMOVED listing',
      [link('L-rem', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido })],
      null,
    ],
    ['nothing but the draft itself', [], null],
  ])(
    'D15 in the confirmation: a conta holding %s — the warning and the flag exactly when P10’s ONE count names one',
    async (_caso, outros, esperado) => {
      const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
      prontoParaPublicar(publicar);
      h.links = [rascunhoPronto('L-rasc'), ...outros];
      await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      expect(formDe('L-rasc').confirmacaoDePublicacao?.segundoAnuncio).toStrictEqual(esperado);
      const aviso = within(dialogoDePublicar()).queryByTestId('aviso-segundo-anuncio');
      if (esperado === null) expect(aviso).toBeNull();
      else
        expect(aviso?.textContent).toBe(
          textoDoSegundoAnuncioNaPublicacaoShopee(esperado, {
            publicacao: { tipo: 'livre' },
            atestacao: null,
          }),
        );
      confirmarPublicacao();
      await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
      if (esperado === null) {
        expect(publicar.mock.calls[0]?.[0]).not.toHaveProperty('confirmarSegundoAnuncio');
      } else {
        expect(publicar.mock.calls[0]?.[0]).toMatchObject({ confirmarSegundoAnuncio: true });
      }
    },
  );

  it('review round 3 (VERIFY-2 R8-copy#3): ANOTHER draft of the produto on this conta that may have created a listing holds «Publicar» back — `irmao-incerto`, its aviso naming that draft; no confirmation, nothing sent (the server would refuse it, confirmation or not)', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [
      rascunhoPronto('L-rasc'),
      rascunho('L-outro', { criacaoIncertaDesde: Date.now() - 600_000 }),
    ];
    renderEditor();
    await waitFor(() =>
      expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('irmao-incerto'),
    );
    expect(formDe('L-rasc').decisaoDePublicar.aviso).toBe(
      fraseDosRascunhosIrmaosIncertosShopee(['L-outro']),
    );
    expect(publicarDo('L-rasc').disabled).toBe(true);
    // The gate, not just the button: the handler the form calls opens nothing.
    act(() => formDe('L-rasc').onPublicar());
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the sibling’s lock was NEVER stamped (it sent nothing — §H Q3, `livre` at the server)',
      [
        rascunhoPronto('L-rasc'),
        rascunho('L-outro', {
          publicacaoEmCurso: { desde: Date.now() - 400_000, expiraEm: Date.now() - 1, token: 't' },
        }),
      ],
    ],
    [
      'THIS draft is the uncertain one (its publish is a real one, ENSURE first)',
      [
        rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 }),
        rascunho('L-outro'),
      ],
    ],
    [
      'the uncertain draft is ANOTHER conta’s',
      [
        rascunhoPronto('L-rasc'),
        rascunho('L-outro', {
          contaProdutoShopeeOuterRef: 'integracao/int-2',
          criacaoIncertaDesde: Date.now() - 600_000,
        }),
      ],
    ],
  ])(
    'review round 3 NEAR-MISS: %s ⇒ «Publicar» acts — never `irmao-incerto`',
    async (_caso, links) => {
      const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
      prontoParaPublicar(publicar);
      h.links = links;
      await renderPronto();
      expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBeNull();
      fireEvent.click(publicarDo('L-rasc'));
      expect(dialogoDePublicar()).toBeDefined();
      confirmarPublicacao();
      await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    },
  );

  it('a 409 rascunhoContaJaTemAnuncio re-asks with the SAME confirmation, counted from detalhes.vinculos, and re-sends the identical publish with the flag', async () => {
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio, {
          vinculos: [{ linkDocId: 'L-x', itemId: 1000009, rascunho: false }],
        }),
      )
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    fireEvent.click(within(dialogoDePublicar()).getByRole('checkbox'));
    confirmarPublicacao();

    await waitFor(() => expect(dialogoDePublicar()).toBeDefined());
    const existentes = { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 };
    expect(within(dialogoDePublicar()).getByTestId('aviso-segundo-anuncio').textContent).toBe(
      textoDoSegundoAnuncioNaPublicacaoShopee(existentes, {
        publicacao: { tipo: 'livre' },
        atestacao: null,
      }),
    );
    // Everything else as sent: «Criar pausado» stays ticked.
    expect(formDe('L-rasc').confirmacaoDePublicacao).toStrictEqual({
      segundoAnuncio: existentes,
      pausado: true,
      atestacao: null,
    });
    // A re-ask, not an outcome.
    expect(h.desfechos.get('L-rasc')).toBeUndefined();
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[0]?.[0]).not.toHaveProperty('confirmarSegundoAnuncio');
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      ...publicar.mock.calls[0]?.[0],
      confirmarSegundoAnuncio: true,
    });
    expect(publicar.mock.calls[1]?.[0]).toMatchObject({ status: 'UNLIST' });
  });

  describe('the 202 — the wait is the SNAPSHOT’s reading, at the editor’s clock', () => {
    const T0 = Date.UTC(2026, 9, 29, 15);
    afterEach(() => {
      vi.useRealTimers();
    });

    it('never «falhou»; once the route re-arms the lock the outcome reads THAT wait (never the 202’s constant), at `relogioRascunho` (never Date.now() at render)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      const publicar = vi.fn<ShopeeClient['publicar']>(async () => itemIncerto('L-rasc'));
      prontoParaPublicar(publicar);
      h.links = [rascunhoPronto('L-rasc')];
      const { rerender } = await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      confirmarPublicacao();
      await waitFor(() =>
        expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
          tipo: 'publicado',
          resposta: itemIncerto('L-rasc'),
          pedidoRascunho: { pausado: false },
        }),
      );
      expect(within(bloco('L-rasc')).queryByText(/falhou/i)).toBeNull();

      // The route re-armed the lock (stamped: it may have sent).
      const doc = rascunhoPronto('L-rasc', {
        publicacaoEmCurso: { desde: T0, expiraEm: T0 + 300_000, token: 't-2', sku: 'SKU-1' },
        criacaoIncertaDesde: T0,
      });
      h.links = [doc];
      rerenderEditor(rerender);
      const lido = desfechoDe('L-rasc').rascunho;
      expect(lido?.publicacao).toBe(formDe('L-rasc').bloco.publicacao);
      expect(lido?.publicacao).toStrictEqual(estadoPublicacaoRascunhoShopee(doc.data, T0));
      expect(lido?.publicacao).toMatchObject({ tipo: 'em-andamento', aguardarMs: 300_000 });
      expect(lido?.nowMs).toBe(T0);
      // The lock disables Publicar — and the exits that share its gate.
      expect(lido?.podePublicar).toBe(false);

      // The wall clock moves; the page's clock moves only with its timer.
      vi.setSystemTime(T0 + 5_000);
      rerenderEditor(rerender);
      expect(desfechoDe('L-rasc').rascunho?.nowMs).toBe(T0);
    });
  });

  it.each<[string, () => Error]>([
    [
      'a network failure',
      () => new ShopeeClientNetworkError('Failed to fetch', new TypeError('x')),
    ],
    ['App Hosting’s 504 (no code)', () => recusaDoRascunho(504, null)],
    [
      'a 2xx it cannot read',
      () => new ShopeeClientRespostaInvalidaError('Resposta inválida.', 200, ['itemId']),
    ],
  ])('%s on a draft Publicar is `sem-resposta`, never «falhou» (#15)', async (_caso, erro) => {
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(erro());
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toStrictEqual({ tipo: 'sem-resposta' }),
    );
    expect(within(bloco('L-rasc')).queryByText(/falhou/i)).toBeNull();
    expect(desfechoDe('L-rasc').rascunho?.publicacao).toBe(formDe('L-rasc').bloco.publicacao);
  });

  it('NEAR-MISS: a 422 is definite — its rows, and Publicar enabled again', async () => {
    const problema: ProblemaShopee = {
      campo: 'weight',
      motivo: 'sem-peso',
      mensagem: 'O produto não tem peso.',
      acao: null,
    };
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([problema]));
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toMatchObject({
        tipo: 'recusado',
        bloqueadaPeloErp: true,
        respondeAtestacao: false,
        problemas: [problema],
        pedidoKit: null,
      }),
    );
    await waitFor(() => expect(publicarDo('L-rasc').disabled).toBe(false));
  });

  it.each<[string, () => ShopeeClientHttpError, string]>([
    [
      '404 — the draft was discarded elsewhere',
      () => recusaDoRascunho(404, CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado),
      FRASE_RASCUNHO_INEXISTENTE_NA_PUBLICACAO_SHOPEE,
    ],
    [
      '409 rascunhoContencao',
      () => recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoContencao),
      FRASE_PUBLICACAO_CONTENCAO_SHOPEE,
    ],
  ])(
    'a definite answer about the DRAFT (%s) is read by the draft’s reader first — never the live link’s «não pertence mais»',
    async (_caso, erro, mensagem) => {
      const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(erro());
      prontoParaPublicar(publicar);
      h.links = [rascunhoPronto('L-rasc')];
      await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      confirmarPublicacao();
      await waitFor(() =>
        expect(desfechoDe('L-rasc').desfecho).toStrictEqual({ tipo: 'falha', mensagem }),
      );
      expect(within(bloco('L-rasc')).queryByText(FORA_DA_CONTA)).toBeNull();
    },
  );

  it.each<
    [
      string,
      () => ShopeeClientHttpError,
      (msg: string, pub: EstadoPublicacaoRascunhoShopee) => string,
    ]
  >([
    [
      '409 publicacaoExpirada (the look-up did not fit the request)',
      () =>
        new ShopeeClientHttpError(
          'A busca não coube no tempo desta requisição.',
          409,
          CODIGO_FALHA_SHOPEE.publicacaoExpirada,
          null,
          null,
          DETALHES_ERRO_SHOPEE_VAZIOS,
        ),
      fraseDaPublicacaoExpiradaShopee,
    ],
    [
      'a CODED 502 that is no rate limit',
      () =>
        new ShopeeClientHttpError(
          'offset fora do limite',
          502,
          'SHOPEE_HTTP_ERROR',
          null,
          'other',
          DETALHES_ERRO_SHOPEE_VAZIOS,
        ),
      fraseDaPublicacaoInterrompidaShopee,
    ],
  ])(
    '%s is `parada`, worded at RENDER over the block’s CURRENT reading — the `livre` exit, then the `incerta` one once the snapshot turns (§I2) — never a sentence frozen at the answer, never a throw',
    async (_caso, erro, frase) => {
      const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(erro());
      prontoParaPublicar(publicar);
      h.links = [rascunhoPronto('L-rasc')];
      const { rerender } = await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      confirmarPublicacao();
      const mensagem = erro().message;
      await waitFor(() =>
        expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
          tipo: 'parada',
          parada: {
            tipo:
              erro().code === CODIGO_FALHA_SHOPEE.publicacaoExpirada ? 'expirada' : 'interrompida',
            mensagemDoServidor: mensagem,
          },
        }),
      );
      const parada = () => screen.getByTestId('shopee-desfecho-L-rasc-parada');
      expect(parada().textContent).toBe(frase(mensagem, { tipo: 'livre' }));
      expect(parada().textContent).toContain('Procure o SKU deste produto no Seller Centre');
      // The SAME outcome, the snapshot now `incerta`: re-worded, never the
      // `livre` «crie-o lá» exit.
      h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
      rerenderEditor(rerender);
      const incerta = formDe('L-rasc').bloco.publicacao;
      expect(incerta.tipo).toBe('incerta');
      expect(parada().textContent).toBe(frase(mensagem, incerta));
      expect(parada().textContent).not.toContain('crie-o lá');
      expect(parada().textContent).not.toMatch(/falhou/i);
      expect(formDe('L-rasc').emVoo).toBeNull();
    },
  );

  it('NEAR-MISS: the SAME 404 on a live listing’s Republicar keeps the live link’s sentence', async () => {
    comEscrita();
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusaDoRascunho(404, CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado));
    h.client = shopeeClientFalso({ publicar });
    h.links = [link('L-vivo')];
    renderEditor();
    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() =>
      expect(desfechoDe('L-vivo').desfecho).toStrictEqual({
        tipo: 'falha',
        mensagem: FORA_DA_CONTA,
      }),
    );
  });

  it.each<[string, FirebaseError, string]>([
    ['no network to refresh it', SESSAO_SEM_REDE, FRASE_SESSAO_SEM_CONEXAO_SHOPEE],
    // NEAR-MISS: any other auth code — a retry never helps, a sign-in does.
    ['an expired session', SESSAO_EXPIRADA, FRASE_SESSAO_NAO_RENOVADA_SHOPEE],
  ])(
    'a failed ID-token refresh on a draft Publicar (%s) is a definite outcome in pt-BR — nothing was sent, never the SDK’s English (#1911 review G1)',
    async (_caso, erro, frase) => {
      const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(erro);
      prontoParaPublicar(publicar);
      h.links = [rascunhoPronto('L-rasc')];
      await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      confirmarPublicacao();
      await waitFor(() =>
        expect(desfechoDe('L-rasc').desfecho).toStrictEqual({ tipo: 'falha', mensagem: frase }),
      );
      // The SAME sentence the block's own draft writes give (`falhaDeSessao`).
      expect(frase).toBe(fraseDaSessaoShopee(erro));
      expect(bloco('L-rasc').textContent).not.toMatch(/Firebase/);
      expect(formDe('L-rasc').emVoo).toBeNull();
    },
  );

  it('`publicar-atestando` (criacao-incerta-sem-sku) opens the SAME confirmation and gate — the exit itself sends nothing — and the confirm carries confirmarCriacaoIncerta', async () => {
    const problema: ProblemaShopee = {
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku,
      mensagem: 'Pode ter criado.',
      acao: null,
    };
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([problema]))
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
    await waitFor(() => expect(desfechoDe('L-rasc').rascunho?.podePublicar).toBe(true));
    // The exits share the form's gate and the block's discard.
    expect(desfechoDe('L-rasc').rascunho?.podeDescartar).toBe(formDe('L-rasc').bloco.podeDescartar);

    const [saida] = saidasDoProblemaShopee(problema, { ehRascunho: true });
    if (saida?.tipo !== 'publicar-atestando')
      throw new Error('fixture must offer the publish exit');
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    expect(publicar).toHaveBeenCalledTimes(1);
    expect(within(dialogoDePublicar()).getByTestId('atestacao').textContent).toBe(saida.rotulo);
    expect(formDe('L-rasc').confirmacaoDePublicacao?.atestacao).toBe(saida);

    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[0]?.[0]).not.toHaveProperty('confirmarCriacaoIncerta');
    // §I1: the attestation travels WITH the exit's promise — `[]`, a create.
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      ...publicar.mock.calls[0]?.[0],
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [],
    });
  });

  it('an ATTESTED publish answered 409 rascunhoContaJaTemAnuncio re-asks with the attestation KEPT — the re-send carries both flags (the 409 test above is the near-miss: no attestation, no flag)', async () => {
    const problema: ProblemaShopee = {
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku,
      mensagem: 'Pode ter criado.',
      acao: null,
    };
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([problema]))
      // The snapshot lagged: the route's set names a listing the tab did not count.
      .mockRejectedValueOnce(
        recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoContaJaTemAnuncio, {
          vinculos: [{ linkDocId: 'L-x', itemId: 1000009, rascunho: false }],
        }),
      )
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
    await waitFor(() => expect(desfechoDe('L-rasc').rascunho?.podePublicar).toBe(true));
    const [saida] = saidasDoProblemaShopee(problema, { ehRascunho: true });
    if (saida?.tipo !== 'publicar-atestando')
      throw new Error('fixture must offer the publish exit');
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toMatchObject({ confirmarCriacaoIncerta: true });
    expect(publicar.mock.calls[1]?.[0]).not.toHaveProperty('confirmarSegundoAnuncio');

    // The re-ask: the D15 warning from `vinculos` AND what the operator attested.
    await waitFor(() =>
      expect(within(dialogoDePublicar()).getByTestId('aviso-segundo-anuncio')).toBeDefined(),
    );
    expect(within(dialogoDePublicar()).getByTestId('atestacao').textContent).toBe(saida.rotulo);
    expect(formDe('L-rasc').confirmacaoDePublicacao).toStrictEqual({
      segundoAnuncio: { quantidade: 1, comRascunho: false, naShopee: 1, rascunhos: 0 },
      pausado: false,
      atestacao: saida,
    });
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(3));
    // Identical but for the second-listing flag: dropping the attestation would
    // re-send into the same `criacao-incerta-sem-sku` refusal.
    expect(publicar.mock.calls[2]?.[0]).toStrictEqual({
      ...publicar.mock.calls[1]?.[0],
      confirmarSegundoAnuncio: true,
    });
    expect(publicar.mock.calls[2]?.[0]).toMatchObject({
      confirmarCriacaoIncerta: true,
      confirmarSegundoAnuncio: true,
    });
  });

  it('NEAR-MISS: the attestation exit with the gate CLOSED opens nothing', async () => {
    const problema: ProblemaShopee = {
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku,
      mensagem: 'Pode ter criado.',
      acao: null,
    };
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([problema]));
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    const { rerender } = await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
    // A cached emission: the gate closes.
    h.fromCache = true;
    rerenderEditor(rerender);
    expect(desfechoDe('L-rasc').rascunho?.podePublicar).toBe(false);
    const [saida] = saidasDoProblemaShopee(problema, { ehRascunho: true });
    if (saida === undefined) throw new Error('fixture must offer the publish exit');
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it('`descartar-atestando` (ja-vinculada, one candidate unlinked) opens the discard confirmation WITH its warning, then sends the HELD projection attested', async () => {
    const problema: ProblemaShopee = {
      campo: null,
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
      mensagem: 'Pode ser o anúncio da tentativa.',
      acao: {
        tipo: TIPO.importar,
        itemIds: [1000011, 1000012],
        vinculados: [{ itemId: 1000011, produtoId: 'prod-1' }],
      },
    };
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: true,
    }));
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([problema]));
    prontoParaPublicar(publicar, { descartarRascunho });
    h.links = [rascunhoPronto('L-rasc', { criacaoIncertaDesde: Date.now() - 600_000 })];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));

    const saida = saidasDoProblemaShopee(problema, { ehRascunho: true }).find(
      (s): s is Extract<SaidaDoProblemaShopee, { tipo: 'descartar-atestando' }> =>
        s.tipo === 'descartar-atestando',
    );
    if (saida?.aviso == null) throw new Error('fixture must warn about the unlinked candidate');
    const aviso = saida.aviso;
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    // The plain confirmation (the operator already attested) — never the three-case dialog.
    const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
    expect(within(dialogo).getByText(aviso)).toBeDefined();
    // Review round 3 (VERIFY-1 mixed-row PARTIAL): the warning never points the
    // free listing at the mass import — nowhere in the dialog.
    expect(dialogo.textContent).toContain('continua na Shopee, sem vínculo no ERP');
    expect(dialogo.textContent).not.toContain(PORTA_DA_IMPORTACAO_SHOPEE);
    expect(dialogo.textContent).not.toMatch(/importe-o/i);
    expect(
      screen.queryByRole('dialog', { name: DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.titulo }),
    ).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();

    fireEvent.click(within(dialogo).getByRole('button', { name: 'Descartar rascunho' }));
    await waitFor(() => expect(descartarRascunho).toHaveBeenCalledTimes(1));
    expect(descartarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      base: {
        item_name: TITULO_PRONTO,
        description: null,
        category_id: 100087,
        marca: { brand_id: 0, original_brand_name: null },
        attributes: null,
      },
      confirmarCriacaoIncerta: true,
    });
  });

  it('K2-13: a 422 row carrying republicar{linkDocId: <the draft>} offers NO button — a draft Publicar is never reached through a refusal row', async () => {
    const problema: ProblemaShopee = {
      campo: null,
      motivo: MOTIVO_ANUNCIO_SHOPEE.rascunhoNaoNomeado,
      mensagem: 'Este produto só tem rascunho nesta conta.',
      acao: { tipo: TIPO.republicar, linkDocId: 'L-rasc' },
    };
    // NEAR-MISS in the same 422: the SAME acao naming a LIVE link of the tab
    // does get its button — the gate is the link's address, not the row.
    const vizinho: ProblemaShopee = {
      campo: null,
      motivo: 'vinculo-substituido',
      mensagem: 'Republique o vínculo vivo.',
      acao: { tipo: TIPO.republicar, linkDocId: 'L-vivo' },
    };
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([problema, vizinho]));
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc'), link('L-vivo')];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    const painelDoDesfecho = await screen.findByTestId('shopee-desfecho-L-rasc');
    expect(desfechoDe('L-rasc').desfecho).toMatchObject({
      tipo: 'recusado',
      problemas: [problema, vizinho],
    });
    expect(
      within(painelDoDesfecho).getByRole('button', { name: 'Republicar o vínculo L-vivo' }),
    ).toBeDefined();
    expect(
      within(painelDoDesfecho).queryByRole('button', { name: 'Republicar o vínculo L-rasc' }),
    ).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(1);
  });

  it('the outcome panel gets the produto, the STORED link’s own-description fact and the tab’s surface destinations', async () => {
    comEscrita();
    h.produto = {
      nome: 'Camiseta',
      paiId: null,
      grupoDeVariacoesUid: ['documents/grupoDeVariacoes/g-1'],
      tabelaDeMedidasModaUid: 'documents/tabMedi/tm-1',
    };
    h.tabMedi = { nome: 'Camisetas adulto', tabelasMedidasShopee: {} };
    h.client = shopeeClientFalso({ publicar: async () => ITEM_REPUBLICADO });
    h.links = [link('L-vivo', { description: 'O texto do próprio anúncio.' })];
    renderEditor();
    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() => expect(h.desfechos.has('L-vivo')).toBe(true));
    expect(desfechoDe('L-vivo')).toMatchObject({
      produtoId: 'prod-1',
      linkDocId: 'L-vivo',
      descricaoPropria: true,
      destinosDasSuperficies: { variacoes: '/variacoes/g-1', medidas: '/medidas/tm-1' },
      rascunho: null,
    });
  });

  it('NEAR-MISS: two variation groups, no size chart and a blank own description name NO destination and no own text', async () => {
    comEscrita();
    h.produto = { nome: 'Camiseta', paiId: null, grupoDeVariacoesUid: ['g-1', 'g-2'] };
    h.client = shopeeClientFalso({ publicar: async () => ITEM_REPUBLICADO });
    h.links = [link('L-vivo', { description: '   ' })];
    renderEditor();
    fireEvent.click(botao('L-vivo', 'Republicar'));
    await waitFor(() => expect(h.desfechos.has('L-vivo')).toBe(true));
    expect(desfechoDe('L-vivo')).toMatchObject({
      descricaoPropria: false,
      destinosDasSuperficies: { variacoes: null, medidas: null },
    });
  });

  it('the confirm re-checks the gate: a lock that lands while it is open sends nothing — and a draft published elsewhere closes it', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>();
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    const { rerender } = await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    expect(dialogoDePublicar()).toBeDefined();

    const agora = Date.now();
    h.links = [
      rascunhoPronto('L-rasc', {
        publicacaoEmCurso: { desde: agora, expiraEm: agora + 300_000, token: 't-9', sku: 'S' },
      }),
    ];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(false);
    act(() => formDe('L-rasc').onConfirmarPublicacao(false));
    expect(publicar).not.toHaveBeenCalled();
    // Still open: the operator cancels it (or the lock ends).
    expect(dialogoDePublicar()).toBeDefined();

    // Published elsewhere: no draft block, so no confirmation either.
    h.links = [link('L-rasc', { item_id: 1000077 })];
    rerenderEditor(rerender);
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).not.toHaveBeenCalled();
  });

  it('a draft with NO category asks for no bands on render (rev. 2a B.7(b)) — its Publicar is held by the categoria-ausente pendência, never enabled on unknown bands', () => {
    const limites = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId ?? null),
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { limitesDoItem: limites });
    h.links = [rascunhoPronto('L-rasc', { category_id: null })];
    renderEditor();
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'pendencias',
    });
    expect(formDe('L-rasc').decisaoDePublicar.pendencias).toContainEqual({
      tipo: 'categoria-ausente',
    });
    expect(formDe('L-rasc').limites).toBeNull();
    expect(limites).not.toHaveBeenCalled();
  });
});

describe('ShopeeEditor — the Publicar gate reads P10’s review-fix block fields (merge of P10’s fix into P11)', () => {
  it('a READY draft whose conta document is GONE: «Descartar» alone, NO «Publicar» (`sem-permissao`), no bands asked — and a call past the missing button opens nothing', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    const limites = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId ?? null),
    );
    prontoParaPublicar(publicar, { limitesDoItem: limites });
    h.links = [rascunhoPronto('L9', { contaProdutoShopeeOuterRef: 'documents/integracao/int-9' })];
    renderEditor();
    fireEvent.click(await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ }));
    // Positive first: the block rendered, its discard authority held.
    expect(formDe('L9').somenteDescartar).toBe(true);
    expect(formDe('L9').bloco.podeDescartar).toBe(true);
    expect(
      within(raizDoRascunho('L9'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Descartar']);
    expect(formDe('L9').contaId).toBeNull();
    expect(formDe('L9').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'sem-permissao',
      aviso: null,
    });
    expect(limites).not.toHaveBeenCalled();
    act(() => formDe('L9').onPublicar());
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: the SAME ready draft on a found conta asks for its bands and offers «Publicar», enabled', async () => {
    const limites = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId ?? null),
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { limitesDoItem: limites });
    h.links = [rascunhoPronto('L-rasc')];
    await renderPronto();
    expect(formDe('L-rasc').somenteDescartar).toBe(false);
    expect(formDe('L-rasc').contaId).toBe('int-1');
    expect(limites.mock.calls.map(([i]) => i)).toStrictEqual([
      { integracaoId: 'int-1', categoryId: 100087 },
    ]);
  });

  it('a ready draft holding a legacy category `0`: no bands asked and the gate says `categoria-inexistente` with no «limites … forem lidos» wait ⟷ NEAR-MISS a positive id, Publicar enabled', async () => {
    const limites = vi.fn<ShopeeClient['limitesDoItem']>(async (input) =>
      limitesDoItem(input.categoryId ?? null),
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { limitesDoItem: limites });
    h.links = [rascunhoPronto('L-zero', { category_id: 0 }), rascunhoPronto('L-rasc')];
    await renderPronto('L-rasc');
    expect(formDe('L-zero').decisaoDePublicar).toStrictEqual({
      podePublicar: false,
      impedimento: 'categoria-inexistente',
      pendencias: [],
      aviso: null,
    });
    expect(publicarDo('L-zero').disabled).toBe(true);
    expect(limites.mock.calls.map(([i]) => i.categoryId)).toStrictEqual([100087]);
    expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true);
  });

  it('a refusal row’s ATTESTED discard (P11 `descartar-atestando`) closes like any discard once a publish takes the lock (P10) — nothing sent ⟷ NEAR-MISS a new emission that changes nothing keeps it, plain and warned', async () => {
    const problema: ProblemaShopee = {
      campo: null,
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
      mensagem: 'Pode ser o anúncio da tentativa.',
      acao: {
        tipo: TIPO.importar,
        itemIds: [1000011, 1000012],
        vinculados: [{ itemId: 1000011, produtoId: 'prod-1' }],
      },
    };
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      descartado: true,
      criacaoIncerta: true,
    }));
    const publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([problema]));
    prontoParaPublicar(publicar, { descartarRascunho });
    const incerta = { criacaoIncertaDesde: Date.now() - 600_000 };
    h.links = [rascunhoPronto('L-rasc', incerta)];
    const { rerender } = await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
    const saida = saidasDoProblemaShopee(problema, { ehRascunho: true }).find(
      (s): s is Extract<SaidaDoProblemaShopee, { tipo: 'descartar-atestando' }> =>
        s.tipo === 'descartar-atestando',
    );
    if (saida?.aviso == null) throw new Error('fixture must warn about the unlinked candidate');
    const aviso = saida.aviso;
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    const plano = () => screen.queryByRole('dialog', { name: 'Descartar rascunho' });
    expect(within(plano()!).getByText(aviso)).toBeDefined();

    // NEAR-MISS: an emission that changes nothing — still the plain, warned
    // confirmation (the block reads `incerta`, yet never the three-case dialog).
    h.links = [rascunhoPronto('L-rasc', incerta)];
    rerenderEditor(rerender);
    expect(within(plano()!).getByText(aviso)).toBeDefined();
    expect(
      screen.queryByRole('dialog', { name: DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.titulo }),
    ).toBeNull();

    // A publish takes the lock: the confirmation closes, nothing is sent.
    const agora = Date.now();
    h.links = [
      rascunhoPronto('L-rasc', {
        ...incerta,
        publicacaoEmCurso: { desde: agora - 1_000, expiraEm: agora + 200_000, token: 't-x' },
      }),
    ];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').bloco.publicacao.tipo).toBe('em-andamento');
    expect(plano()).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
  });
});

describe('ShopeeEditor — the P11 review fixes on the tab (#1911 batch-B review, TAB wave)', () => {
  /** `criacao-incerta-ja-vinculada` over two candidates; the ones not in `vinculados` are unlinked. */
  const jaVinculada = (vinculados: { itemId: number; produtoId: string }[]): ProblemaShopee => ({
    campo: null,
    motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaJaVinculada,
    mensagem: 'Pode ser o anúncio da tentativa.',
    acao: { tipo: TIPO.importar, itemIds: [1000011, 1000012], vinculados },
  });
  const MISTA = jaVinculada([{ itemId: 1000011, produtoId: 'prod-1' }]);
  const TODAS_VINCULADAS = jaVinculada([
    { itemId: 1000011, produtoId: 'prod-1' },
    { itemId: 1000012, produtoId: 'prod-9' },
  ]);
  const INCERTA = { criacaoIncertaDesde: Date.now() - 600_000 };
  const linhaDoDesfecho = () => screen.getByTestId('shopee-problema-L-rasc-0');

  /** A refused first publish of an `incerta` draft: its row and exits on screen. */
  async function recusadoCom(
    problema: ProblemaShopee,
    extra: Partial<ShopeeClient> = {},
    publicar = vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([problema])),
  ) {
    prontoParaPublicar(publicar, extra);
    h.links = [rascunhoPronto('L-rasc', INCERTA)];
    const r = await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
    await waitFor(() => expect(desfechoDe('L-rasc').rascunho?.podePublicar).toBe(true));
    return { ...r, publicar };
  }
  function saidaDe<T extends SaidaDoProblemaShopee['tipo']>(
    problema: ProblemaShopee,
    tipo: T,
  ): Extract<SaidaDoProblemaShopee, { tipo: T }> {
    const saida = saidasDoProblemaShopee(problema, { ehRascunho: true }).find(
      (s): s is Extract<SaidaDoProblemaShopee, { tipo: T }> => s.tipo === tipo,
    );
    if (saida === undefined) throw new Error(`fixture must offer ${tipo}`);
    return saida;
  }

  it('R4-1369-fold#0: an ADOPTING attestation sends its PROMISE (`criacaoIncertaAdota: [L]`), and the server’s mismatch refusal renders as the FRESH row — opened by «A situação mudou», its exits rebuilt from it ⟷ NEAR-MISS the first, unattested refusal has no such opening', async () => {
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([MISTA]))
      // L (1000012) was linked to ANOTHER produto since: the guard refuses, nothing sent.
      .mockRejectedValueOnce(recusa422([TODAS_VINCULADAS]))
      .mockResolvedValueOnce(ITEM_REPUBLICADO);
    await recusadoCom(MISTA, {}, publicar);
    // NEAR-MISS first: the operator's own first refusal is no "changed situation".
    expect(desfechoDe('L-rasc').desfecho).toMatchObject({ respondeAtestacao: false });
    expect(linhaDoDesfecho().textContent).not.toContain(FRASE_ATESTACAO_SUPERADA_SHOPEE);
    const adota = saidaDe(MISTA, 'publicar-atestando');
    expect(adota.adota).toStrictEqual([1000012]);
    expect(
      within(screen.getByTestId('shopee-desfecho-L-rasc')).getByRole('button', {
        name: rotuloDaPublicacaoQueAdotaShopee([1000012]),
      }),
    ).toBeDefined();

    act(() => desfechoDe('L-rasc').rascunho?.onSaida(adota));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    // The promise is IN the body: the server honours it or refuses (§I1).
    expect(publicar.mock.calls[1]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [1000012],
    });

    // The mismatch refusal: the FRESH row, said to answer a changed situation.
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toMatchObject({
        tipo: 'recusado',
        respondeAtestacao: true,
        problemas: [TODAS_VINCULADAS],
      }),
    );
    expect(linhaDoDesfecho().textContent?.startsWith(FRASE_ATESTACAO_SUPERADA_SHOPEE)).toBe(true);
    // Its exits are the FRESH row's: no adoption of a listing now linked elsewhere.
    const painelDoDesfecho = within(screen.getByTestId('shopee-desfecho-L-rasc'));
    expect(
      painelDoDesfecho.queryByRole('button', { name: rotuloDaPublicacaoQueAdotaShopee([1000012]) }),
    ).toBeNull();
    expect(
      painelDoDesfecho.getByRole('button', { name: ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE }),
    ).toBeDefined();
    expect(
      painelDoDesfecho.getByRole('button', { name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE }),
    ).toBeDefined();

    // Taking the fresh exit sends ITS promise: a deliberate create, `[]`.
    await waitFor(() => expect(desfechoDe('L-rasc').rascunho?.podePublicar).toBe(true));
    const segundo = saidaDe(TODAS_VINCULADAS, 'publicar-atestando');
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(segundo));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(3));
    expect(publicar.mock.calls[2]?.[0]).toMatchObject({
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [],
    });
  });

  it('§I4 (review round 4): an ATTESTED publish answered 409 rascunhoJaPublicado (another run linked the draft) ⇒ its own sentence — the confirmation had no effect, nothing created or changed — with the confirmation closed, nothing re-sent and no exit left to offer the same attestation, also once the snapshot shows the listing ⟷ NEAR-MISS the block’s own (unattested) Publicar keeps today’s sentence', async () => {
    const jaPublicado = () => recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoJaPublicado);
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusa422([MISTA]))
      .mockRejectedValueOnce(jaPublicado());
    const { rerender } = await recusadoCom(MISTA, {}, publicar);
    const adota = saidaDe(MISTA, 'publicar-atestando');
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(adota));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(2));
    expect(publicar.mock.calls[1]?.[0]).toMatchObject({
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [1000012],
    });
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
        tipo: 'falha',
        mensagem: FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
      }),
    );
    // No stuck dialog, and the refusal rows (with their exits) are gone.
    expect(semDialogoDePublicar()).toBeNull();
    expect(formDe('L-rasc').confirmacaoDePublicacao).toBeNull();
    const painelDoDesfecho = () => screen.getByTestId('shopee-desfecho-L-rasc');
    expect(within(painelDoDesfecho()).queryAllByRole('button')).toEqual([]);
    expect(painelDoDesfecho().textContent).toBe(FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE);
    expect(painelDoDesfecho().textContent).not.toMatch(/falhou/i);
    // The snapshot catches up: the link records the listing — the sentence
    // stays, there is no draft context to act on, and nothing is ever re-sent.
    h.links = [link('L-rasc', { item_id: 1000012 })];
    rerenderEditor(rerender);
    await waitFor(() => expect(desfechoDe('L-rasc').rascunho).toBeNull());
    expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
      tipo: 'falha',
      mensagem: FRASE_ATESTACAO_DE_RASCUNHO_JA_PUBLICADO_SHOPEE,
    });
    expect(semDialogoDePublicar()).toBeNull();
    expect(publicar).toHaveBeenCalledTimes(2);
  });

  it('§I4 NEAR-MISS: the block’s OWN Publicar (no attestation) answered 409 rascunhoJaPublicado keeps today’s sentence — never the attested one', async () => {
    const publicar = vi
      .fn<ShopeeClient['publicar']>()
      .mockRejectedValueOnce(recusaDoRascunho(409, CODIGO_FALHA_SHOPEE.rascunhoJaPublicado));
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc', INCERTA)];
    await renderPronto();
    fireEvent.click(publicarDo('L-rasc'));
    confirmarPublicacao();
    await waitFor(() => expect(publicar).toHaveBeenCalledTimes(1));
    expect(publicar.mock.calls[0]?.[0]).not.toHaveProperty('confirmarCriacaoIncerta');
    await waitFor(() =>
      expect(desfechoDe('L-rasc').desfecho).toStrictEqual({
        tipo: 'falha',
        mensagem: FRASE_RASCUNHO_JA_PUBLICADO_SHOPEE,
      }),
    );
    expect(semDialogoDePublicar()).toBeNull();
    expect(screen.getByTestId('shopee-desfecho-L-rasc').textContent).not.toContain(
      'A confirmação que você deu',
    );
  });

  it('the outcome panel of a draft gets the SKU the uncertain attempt SENT (the schemas’ window reading) — the SKU-moved row names it ⟷ NEAR-MISS a record with no SKU hands `null` (unknown), never a guess', async () => {
    const skuMudou: ProblemaShopee = {
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaAmbigua,
      mensagem: 'O SKU mudou.',
      acao: null,
    };
    for (const [extra, esperado] of [
      [{ criacaoIncertaSku: 'SKU-A' }, 'SKU-A'],
      [{}, null],
    ] as const) {
      prontoParaPublicar(
        vi.fn<ShopeeClient['publicar']>().mockRejectedValueOnce(recusa422([skuMudou])),
      );
      h.links = [rascunhoPronto('L-rasc', { ...INCERTA, ...extra })];
      const { unmount } = await renderPronto();
      fireEvent.click(publicarDo('L-rasc'));
      confirmarPublicacao();
      await waitFor(() => expect(desfechoDe('L-rasc').desfecho.tipo).toBe('recusado'));
      expect(desfechoDe('L-rasc').rascunho?.skuEnviado).toBe(esperado);
      if (esperado === null) expect(linhaDoDesfecho().textContent).not.toMatch(/volte o SKU/);
      else expect(linhaDoDesfecho().textContent).toContain(`«${esperado}»`);
      unmount();
    }
  });

  it('R8-copy#1: the ATTESTED discard («É o anúncio da tentativa») confirms with its own sentence, never «Nada foi publicado na Shopee» — mixed (with the warning) and all-linked (alone) ⟷ NEAR-MISS the block’s own Descartar on a `livre` draft keeps the plain sentence', async () => {
    for (const [problema, comAviso] of [
      [MISTA, true],
      [TODAS_VINCULADAS, false],
    ] as const) {
      const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
      const { unmount } = await recusadoCom(problema, { descartarRascunho });
      const saida = saidaDe(problema, 'descartar-atestando');
      act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
      const dialogo = screen.getByRole('dialog', { name: 'Descartar rascunho' });
      expect(within(dialogo).getByText(FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE)).toBeDefined();
      expect(within(dialogo).queryByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeNull();
      expect(dialogo.textContent).not.toMatch(/Nada foi publicado/);
      if (comAviso) expect(within(dialogo).getByText(saida.aviso ?? '?')).toBeDefined();
      else expect(saida.aviso).toBeNull();
      expect(descartarRascunho).not.toHaveBeenCalled();
      unmount();
    }
    // NEAR-MISS: a `livre` draft's own «Descartar» — nothing was ever published.
    comAutoria();
    h.client = shopeeClientFalso({ descartarRascunho: vi.fn() });
    h.links = [rascunho('L-livre')];
    renderEditor();
    fireEvent.click(botaoDoRascunho('L-livre', 'Descartar'));
    const plano = screen.getByRole('dialog', { name: 'Descartar rascunho' });
    expect(within(plano).getByText(FRASE_CONFIRMAR_DESCARTE_SHOPEE)).toBeDefined();
    expect(within(plano).queryByText(FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE)).toBeNull();
  });

  it('R8-copy#1 (round 2): a row with NO linked candidate (§I1’s third shape) offers no «É o anúncio da tentativa» — the attested sentence («vinculado no ERP») can never open over it; its one exit adopts, and the block’s own Descartar keeps the three-case dialog ⟷ NEAR-MISS the same free ids beside a linked one offer the discard', async () => {
    const SEM_VINCULO = jaVinculada([]);
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
    const { unmount } = await recusadoCom(SEM_VINCULO, { descartarRascunho });
    const painelDoDesfecho = within(screen.getByTestId('shopee-desfecho-L-rasc'));
    expect(
      painelDoDesfecho.queryByRole('button', {
        name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      }),
    ).toBeNull();
    const adota = rotuloDaPublicacaoQueAdotaShopee([1000011, 1000012]);
    // The one exit is the adoption: it opens the PUBLISH confirmation, never a discard.
    fireEvent.click(painelDoDesfecho.getByRole('button', { name: adota }));
    expect(formDe('L-rasc').confirmacaoDePublicacao?.atestacao).toStrictEqual({
      tipo: 'publicar-atestando',
      rotulo: adota,
      adota: [1000011, 1000012],
      varre: true,
    });
    expect(screen.queryByRole('dialog', { name: 'Descartar rascunho' })).toBeNull();
    expect(screen.queryByText(FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE)).toBeNull();
    act(() => formDe('L-rasc').onCancelarPublicacao());
    // The block's own Descartar: the three-case dialog, whose (c) is the unlinked case.
    fireEvent.click(botaoDoRascunho('L-rasc', 'Descartar'));
    const tresCasos = screen.getByRole('dialog', {
      name: DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.titulo,
    });
    expect(
      within(tresCasos).getByText(DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo),
    ).toBeDefined();
    expect(screen.queryByText(FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE)).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
    unmount();

    // NEAR-MISS: one candidate linked ⇒ the discard exit is there.
    await recusadoCom(MISTA);
    expect(
      within(screen.getByTestId('shopee-desfecho-L-rasc')).getByRole('button', {
        name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
      }),
    ).toBeDefined();
  });

  it('KNOWN #12 (tab half): the SKU-less exit reaches the confirmation AS ITSELF — `varre: false`, worded «não consegue procurar», never the change-guard ⟷ NEAR-MISS the «segundo de propósito» exit (the SAME `adota: []`) reaches it `varre: true`, with the change-guard', async () => {
    const SEM_SKU: ProblemaShopee = {
      campo: 'item_sku',
      motivo: MOTIVO_ANUNCIO_SHOPEE.criacaoIncertaSemSku,
      mensagem: 'Pode ter criado.',
      acao: null,
    };
    const textoDoForm = () =>
      textoDaConfirmacaoDePublicacaoShopee({
        contaNome: formDe('L-rasc').contaNome,
        publicacao: formDe('L-rasc').bloco.publicacao,
        atestacao: formDe('L-rasc').confirmacaoDePublicacao?.atestacao ?? null,
      });
    for (const [problema, rotulo, varre] of [
      [SEM_SKU, ROTULO_PUBLICAR_ATESTANDO_SEM_SKU_SHOPEE, false],
      [TODAS_VINCULADAS, ROTULO_PUBLICAR_SEGUNDO_DE_PROPOSITO_SHOPEE, true],
    ] as const) {
      const { unmount } = await recusadoCom(problema);
      fireEvent.click(
        within(screen.getByTestId('shopee-desfecho-L-rasc')).getByRole('button', { name: rotulo }),
      );
      expect(formDe('L-rasc').confirmacaoDePublicacao?.atestacao).toStrictEqual({
        tipo: 'publicar-atestando',
        rotulo,
        adota: [],
        varre,
      });
      if (varre) {
        expect(textoDoForm()).toContain(FRASE_ATESTACAO_QUE_VARRE_SHOPEE);
        expect(textoDoForm()).not.toContain(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE);
      } else {
        expect(textoDoForm()).toContain(FRASE_ATESTACAO_SEM_BUSCA_SHOPEE);
        expect(textoDoForm()).not.toMatch(/nada é enviado|recusa volta|procura pelo SKU/);
      }
      unmount();
    }
  });

  it('R3-tests#6 (P11 path): an ATTESTED discard confirmation whose draft was published — or discarded — elsewhere closes, and nothing is sent ⟷ NEAR-MISS a new emission that is still the draft keeps it open, its confirm enabled', async () => {
    for (const depois of [() => [link('L-rasc', { item_id: 2000002 })], () => [] as Linha[]]) {
      const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
      const { rerender, unmount } = await recusadoCom(MISTA, { descartarRascunho });
      act(() => desfechoDe('L-rasc').rascunho?.onSaida(saidaDe(MISTA, 'descartar-atestando')));
      const dialogo = () => screen.queryByRole('dialog', { name: 'Descartar rascunho' });
      // NEAR-MISS first: still the same draft — open, the confirm enabled.
      h.links = [rascunhoPronto('L-rasc', INCERTA)];
      rerenderEditor(rerender);
      const aberto = dialogo();
      if (aberto === null) throw new Error('the attested discard must still be open');
      const confirmar = within(aberto).getByRole('button', {
        name: 'Descartar rascunho',
      }) as HTMLButtonElement;
      expect(confirmar.disabled).toBe(false);
      // Published (or discarded) in another tab: no confirm left to click.
      h.links = depois();
      rerenderEditor(rerender);
      expect(dialogo()).toBeNull();
      expect(screen.queryByText(FRASE_CONFIRMAR_DESCARTE_ATESTADO_SHOPEE)).toBeNull();
      expect(descartarRascunho).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('R3-tests#5 (P11 half): the discard exit called while the block may NOT discard (a cache-served snapshot) opens nothing and sends nothing — the handler’s own re-check, past the disabled button ⟷ NEAR-MISS the same call under server truth opens it', async () => {
    const descartarRascunho = vi.fn<ShopeeClient['descartarRascunho']>();
    const { rerender } = await recusadoCom(MISTA, { descartarRascunho });
    const saida = saidaDe(MISTA, 'descartar-atestando');
    h.fromCache = true;
    rerenderEditor(rerender);
    expect(formDe('L-rasc').bloco.podeDescartar).toBe(false);
    expect(desfechoDe('L-rasc').rascunho?.podeDescartar).toBe(false);
    // The panel's button is disabled on the same decision…
    expect(
      (
        within(screen.getByTestId('shopee-desfecho-L-rasc')).getByRole('button', {
          name: ROTULO_DESCARTAR_ANUNCIO_DA_TENTATIVA_SHOPEE,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // …and a call past it is refused by the handler itself.
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    expect(screen.queryByRole('dialog', { name: 'Descartar rascunho' })).toBeNull();
    expect(descartarRascunho).not.toHaveBeenCalled();
    // NEAR-MISS: server truth again — the same call opens the confirmation.
    h.fromCache = false;
    rerenderEditor(rerender);
    act(() => desfechoDe('L-rasc').rascunho?.onSaida(saida));
    expect(screen.getByRole('dialog', { name: 'Descartar rascunho' })).toBeDefined();
  });

  it('R7-roundtrip#3 / R8-copy#9: a FAILED bands read keeps Publicar closed but says so — its cause and «Ler de novo», never the pending «forem lidos» — and the re-read opens it', async () => {
    const falhou = new ShopeeClientHttpError(
      'A Shopee recusou a consulta dos limites.',
      502,
      'SHOPEE_HTTP_ERROR',
      null,
      'other',
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
    const limites = vi
      .fn<ShopeeClient['limitesDoItem']>()
      .mockRejectedValueOnce(falhou)
      .mockImplementation(async (input) => limitesDoItem(input.categoryId ?? null));
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { limitesDoItem: limites });
    h.links = [rascunhoPronto('L-rasc')];
    renderEditor();
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());
    // The gate stays the lib's and stays CLOSED.
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'faixas-desconhecidas',
    });
    const falha = formDe('L-rasc').falhaDaLeitura;
    if (falha === null) throw new Error('a failed read must be named');
    expect(falha.mensagem).toBe(
      fraseDosLimitesNaoLidosShopee(descreverFalhaShopee(falhou, { desconhecido: '' }).mensagem),
    );
    expect(falha.mensagem).toContain('A Shopee recusou a consulta dos limites.');
    expect(falha.mensagem).not.toBe(FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE);
    expect(falha.mensagem).not.toMatch(/fica disponível quando/);
    expect(limites).toHaveBeenCalledTimes(1);

    act(() => falha.lerDeNovo?.());
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    expect(limites).toHaveBeenCalledTimes(2);
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
  });

  it('NEAR-MISS (R7-roundtrip#3): a rate-limited bands read names the limit and still offers «Ler de novo»; a PENDING read names no failure', async () => {
    const limite = new ShopeeClientHttpError(
      'burst',
      502,
      'SHOPEE_HTTP_ERROR',
      null,
      'burst',
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), {
      limitesDoItem: () => Promise.reject(limite),
    });
    h.links = [rascunhoPronto('L-rasc')];
    const { unmount } = renderEditor();
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());
    expect(formDe('L-rasc').falhaDaLeitura?.mensagem).toContain(
      descreverFalhaShopee(limite, { desconhecido: '' }).mensagem,
    );
    expect(formDe('L-rasc').falhaDaLeitura?.lerDeNovo).not.toBeNull();
    unmount();

    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), {
      limitesDoItem: () => new Promise(() => undefined),
    });
    renderEditor();
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('faixas-desconhecidas');
    expect(formDe('L-rasc').decisaoDePublicar.aviso).toBe(FRASE_PUBLICAR_SEM_FAIXAS_SHOPEE);
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
  });

  // VERIFY-3 F3 (round 2): the failure is named ONLY while the failed read IS
  // the gate's reason. An earlier, actionable impediment («Salve as
  // alterações», «Salve o produto») keeps its own sentence; the red read
  // failure must not take its place.
  it('NEAR-MISS (R7-roundtrip#3, F3): a FAILED bands read under unsaved draft edits, or an unsaved produto, keeps that reason — never the read failure in its place ⟷ the same failure with nothing unsaved IS the reason', async () => {
    const falhou = new ShopeeClientHttpError(
      'A Shopee recusou a consulta dos limites.',
      502,
      'SHOPEE_HTTP_ERROR',
      null,
      'other',
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), {
      limitesDoItem: () => Promise.reject(falhou),
    });
    h.links = [rascunhoPronto('L-rasc')];
    const { rerender } = renderEditor();
    // Positive first: with nothing unsaved the failed read IS the reason.
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('faixas-desconhecidas');

    // An unsaved produto (KNOWN #9's flag) speaks first.
    rerenderEditor(rerender, { produtoSujoForaDoFormulario: true });
    await waitFor(() =>
      expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('produto-nao-salvo'),
    );
    expect(formDe('L-rasc').decisaoDePublicar.aviso).toBe(FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE);
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
    rerenderEditor(rerender, { produtoSujoForaDoFormulario: false });
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());

    // Unsaved draft edits speak first too.
    digitarTitulo('L-rasc', 'Camiseta nova');
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('alteracoes-nao-salvas');
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
  });

  it('R8-copy#9 (b): the stored description’s listener FAILED — Publicar waits on `carregando` and says why (reload), never a silent disabled button ⟷ NEAR-MISS the description read ⇒ no failure', async () => {
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>());
    h.extraDataErro = new Error('permission-denied');
    h.links = [rascunhoPronto('L-rasc')];
    const { rerender } = renderEditor();
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'carregando',
      aviso: null,
    });
    expect(formDe('L-rasc').falhaDaLeitura).toStrictEqual({
      mensagem: FRASE_DESCRICAO_DO_PRODUTO_NAO_LIDA_SHOPEE,
      lerDeNovo: null,
      relendo: false,
    });
    h.extraDataErro = null;
    rerenderEditor(rerender);
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
  });

  // VERIFY-2 round 2 (F3's sibling, the SAME function's other arm): the failed
  // description listener is named ONLY while `carregando` IS the gate's reason.
  // An earlier, actionable impediment («Salve as alterações») keeps its own
  // sentence; the reload sentence must not take its place.
  it('NEAR-MISS (R8-copy#9 (b), F3 sibling): a FAILED description listener under unsaved draft edits keeps «alterações não salvas» — never the reload sentence in its place ⟷ with nothing unsaved the failure IS the reason', () => {
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>());
    h.extraDataErro = new Error('permission-denied');
    h.links = [rascunhoPronto('L-rasc')];
    renderEditor();
    // Positive first: nothing unsaved ⇒ the failed listener IS the reason.
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('carregando');
    expect(formDe('L-rasc').falhaDaLeitura?.mensagem).toBe(
      FRASE_DESCRICAO_DO_PRODUTO_NAO_LIDA_SHOPEE,
    );
    // Unsaved draft edits speak first.
    digitarTitulo('L-rasc', 'Camiseta nova');
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('alteracoes-nao-salvas');
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
  });

  it('KNOWN #9: unsaved produto edits OUTSIDE the form (staged variation prices / children) close Publicar as «salve o produto» — ORed with the form’s isDirty, never instead ⟷ NEAR-MISS without them it publishes', async () => {
    const publicar = vi.fn<ShopeeClient['publicar']>(async () => ITEM_REPUBLICADO);
    prontoParaPublicar(publicar);
    h.links = [rascunhoPronto('L-rasc')];
    // Outside any form provider (the prop alone).
    const { rerender, unmount } = renderEditor({ produtoSujoForaDoFormulario: true });
    await waitFor(() =>
      expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('produto-nao-salvo'),
    );
    expect(formDe('L-rasc').decisaoDePublicar.aviso).toBe(FRASE_PUBLICAR_PRODUTO_NAO_SALVO_SHOPEE);
    expect(publicarDo('L-rasc').disabled).toBe(true);
    act(() => formDe('L-rasc').onPublicar());
    expect(semDialogoDePublicar()).toBeNull();
    // NEAR-MISS: saved ⇒ open again.
    rerenderEditor(rerender, { produtoSujoForaDoFormulario: false });
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    unmount();

    // Inside a CLEAN produto form: the outside flag still closes it (an OR).
    function ComOFormularioLimpo({ fora }: { fora: boolean }) {
      const form = useForm({ defaultValues: { nome: 'Camiseta' } });
      return (
        <FormProvider {...form}>
          <ShopeeEditor
            produtoId="prod-1"
            db={{} as Firestore}
            produtoSujoForaDoFormulario={fora}
          />
        </FormProvider>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (fora: boolean) => (
      <MantineTestProvider>
        <QueryClientProvider client={qc}>
          <ComOFormularioLimpo fora={fora} />
        </QueryClientProvider>
      </MantineTestProvider>
    );
    const r = render(ui(true));
    await waitFor(() =>
      expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('produto-nao-salvo'),
    );
    r.rerender(ui(false));
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    expect(publicar).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*            #1911 P13 — the attribute tree and the «Atributos» section       */
/* -------------------------------------------------------------------------- */

/*
 * The tab reads the attribute tree of the category each draft is EDITED to
 * (beside its bands), hands the section its reading and the MODEL's rows, feeds
 * the gate, and applies `onAtributo` through `comAtributoRascunhoShopee`.
 * Public BR taxonomy (100408 «Tipo de Conexão» with 2498 / 2530, 101029
 * «Tamanho Do Pacote» and its 12 units); every typed or stored value invented.
 */
const infoDoAtributo = (p: Partial<AtributoInfoDto>): AtributoInfoDto => ({
  inputType: null,
  inputValidationType: 0,
  formatType: 1,
  dateFormatType: null,
  attributeUnitList: null,
  maxValueCount: null,
  introduction: null,
  isOem: false,
  supportSearchValue: false,
  ...p,
});
const TIPO_DE_CONEXAO: AtributoDto = {
  attributeId: 100408,
  mandatory: true,
  name: 'Tipo de Conexão',
  attributeInfo: infoDoAtributo({ inputType: 1 }),
  attributeValueList: [
    {
      valueId: 2498,
      name: 'Com fio, Sem conexão ou Outros',
      valueUnit: null,
      childAttributeList: [],
    },
    {
      valueId: 2530,
      name: 'Sem fio (Bluetooth, Wifi, Radiofrequência)',
      valueUnit: null,
      childAttributeList: [],
    },
  ],
};
const TAMANHO_DO_PACOTE: AtributoDto = {
  attributeId: 101029,
  mandatory: false,
  name: 'Tamanho Do Pacote',
  attributeInfo: infoDoAtributo({
    inputType: 3,
    inputValidationType: 3,
    formatType: 2,
    attributeUnitList: [
      'ML',
      'L',
      'MG',
      'G/GR',
      'KG',
      'CM',
      'M',
      'Dozen',
      'Piece',
      'Pack',
      'Set',
      'Box',
    ],
  }),
  attributeValueList: [],
};
/** 100087's tree holds the mandatory 100408; 100088's the optional 101029 — told apart by WHICH rows a form got. */
const ARVORES = new Map<number, AtributoDto[]>([
  [100087, [TIPO_DE_CONEXAO]],
  [100088, [TAMANHO_DO_PACOTE]],
]);
const respostaDaArvore = (categoryId: number) =>
  respostaAtributos(categoryId, ARVORES.get(categoryId) ?? []);
const COM_FIO_GUARDADO = [{ attribute_id: 100408, attribute_value_list: [{ value_id: 2498 }] }];
const SEM_FIO = [{ attribute_id: 100408, attribute_value_list: [{ value_id: 2530 }] }];

/** A tree read the test answers when it chooses — per category. */
function arvoresSobControle() {
  const pendentes = new Map<number, (r: RespostaAtributosShopee) => void>();
  const atributos = vi.fn<ShopeeClient['atributos']>(
    (input) =>
      new Promise((resolve) => {
        pendentes.set(input.categoryId, resolve);
      }),
  );
  const responder = async (categoryId: number) => {
    await waitFor(() => expect(pendentes.has(categoryId)).toBe(true));
    act(() => pendentes.get(categoryId)?.(respostaDaArvore(categoryId)));
  };
  return { atributos, responder };
}

const linhasDe = (linkDocId: string) =>
  formDe(linkDocId).atributos.linhas.map((l) => l.attributeId);

describe('ShopeeEditor — a árvore de atributos da categoria EDITADA (#1911 P13)', () => {
  it('uma leitura por (conta, categoria) — só blocos com categoria válida e conta encontrada; dois rascunhos na mesma categoria leem UMA vez ⟷ QUASE-PAR: nenhuma para categoria ausente, `0` ou conta não encontrada', async () => {
    comAutoria();
    const atributos = vi.fn<ShopeeClient['atributos']>(async (input) =>
      respostaDaArvore(input.categoryId),
    );
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos,
    });
    h.links = [
      rascunho('L-a', { category_id: 100087 }),
      rascunho('L-b', { category_id: 100087 }),
      rascunho('L-sem'),
      rascunho('L-zero', { category_id: 0 }),
      rascunho('L9', {
        category_id: 100088,
        contaProdutoShopeeOuterRef: 'documents/integracao/int-9',
        attributes: [
          ...COM_FIO_GUARDADO,
          {
            attribute_id: 101029,
            attribute_value_list: [{ value_id: 0, original_value_name: '2', value_unit: 'KG' }],
          },
        ],
      }),
    ];
    renderEditor();
    await waitFor(() => expect(formDe('L-a').atributos.leitura.tipo).toBe('lida'));
    expect(atributos.mock.calls.map(([i]) => i)).toStrictEqual([
      { integracaoId: 'int-1', categoryId: 100087 },
    ]);
    expect(linhasDe('L-a')).toStrictEqual([100408]);
    expect(linhasDe('L-b')).toStrictEqual([100408]);
    expect(formDe('L-sem').atributos.leitura).toStrictEqual({ tipo: 'sem-categoria' });
    expect(formDe('L-zero').atributos.leitura).toStrictEqual({ tipo: 'sem-categoria' });
    expect(formDe('L-sem').atributos.linhas).toStrictEqual([]);

    // The «não encontrada» tab: nothing read, the held list only counted.
    fireEvent.click(await screen.findByRole('tab', { name: /Conta int-9 \(não encontrada\)/ }));
    expect(formDe('L9').atributos.leitura).toStrictEqual({ tipo: 'sem-conta', gravados: 2 });
    expect(formDe('L9').atributos.linhas).toStrictEqual([]);
    expect(atributos).toHaveBeenCalledTimes(1);
  });

  it('«Publicar» ESPERA a árvore (`atributos-desconhecidos`, a frase da árvore; a seção diz «carregando») e só então lê a pendência do obrigatório ⟷ QUASE-PAR: as faixas sozinhas não abrem', async () => {
    const { atributos, responder } = arvoresSobControle();
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { atributos });
    h.links = [rascunhoPronto('L-rasc')];
    renderEditor();
    // The bands are in; the tree is not.
    await waitFor(() => expect(formDe('L-rasc').limites).not.toBeNull());
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'atributos-desconhecidos',
      aviso: FRASE_PUBLICAR_SEM_ATRIBUTOS_SHOPEE,
    });
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
    expect(publicarDo('L-rasc').disabled).toBe(true);
    expect(formDe('L-rasc').atributos.leitura).toStrictEqual({ tipo: 'carregando' });
    expect(formDe('L-rasc').atributos.linhas).toStrictEqual([]);

    // 100087's tree holds a MANDATORY attribute, empty here: still closed, as a pendência.
    await responder(100087);
    await waitFor(() => expect(formDe('L-rasc').atributos.leitura.tipo).toBe('lida'));
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'pendencias',
    });
    expect(formDe('L-rasc').decisaoDePublicar.pendencias).toContainEqual({
      tipo: 'atributo-obrigatorio',
      nomes: ['Tipo de Conexão'],
    });
  });

  it('a árvore lida e o obrigatório GUARDADO ⇒ «Publicar» habilitado; a seção recebe as linhas do MODELO ⟷ QUASE-PAR: categoria NÃO FOLHA ⇒ a árvore vazia completa (sem espera, sem linhas)', async () => {
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), {
      atributos: async (input) =>
        input.categoryId === 100090
          ? respostaAtributos(100090, [], { leaf: false })
          : respostaDaArvore(input.categoryId),
    });
    h.links = [
      rascunhoPronto('L-rasc', { attributes: SEM_FIO }),
      rascunhoPronto('L-galho', { category_id: 100090 }),
    ];
    await renderPronto('L-rasc');
    const linha = formDe('L-rasc').atributos.linhas[0];
    expect(linha?.attributeId).toBe(100408);
    expect(linha?.escolhidos).toStrictEqual([2530]);
    expect(formDe('L-rasc').atributos.semLugar).toStrictEqual([]);
    expect(formDe('L-rasc').atributos.removidosAoSalvar).toStrictEqual([]);

    await waitFor(() => expect(formDe('L-galho').atributos.leitura.tipo).toBe('nao-folha'));
    expect(formDe('L-galho').atributos.linhas).toStrictEqual([]);
    expect(formDe('L-galho').decisaoDePublicar.impedimento).not.toBe('atributos-desconhecidos');
  });

  it('uma leitura que FALHOU: a seção diz a causa com «Ler de novo» e o «Publicar» também — a releitura abre ⟷ QUASE-PAR: depois dela, nenhuma falha nomeada', async () => {
    const falhou = new ShopeeClientHttpError(
      'A Shopee recusou a consulta dos atributos.',
      502,
      'SHOPEE_HTTP_ERROR',
      null,
      'other',
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
    const atributos = vi
      .fn<ShopeeClient['atributos']>()
      .mockRejectedValueOnce(falhou)
      .mockImplementation(async (input) => respostaAtributos(input.categoryId));
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), { atributos });
    h.links = [rascunhoPronto('L-rasc')];
    renderEditor();
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());
    const causa = descreverFalhaShopee(falhou, { desconhecido: '' }).mensagem;
    expect(formDe('L-rasc').decisaoDePublicar).toMatchObject({
      podePublicar: false,
      impedimento: 'atributos-desconhecidos',
    });
    expect(formDe('L-rasc').falhaDaLeitura?.mensagem).toBe(fraseDosAtributosNaoLidosShopee(causa));
    expect(formDe('L-rasc').falhaDaLeitura?.mensagem).not.toBe(
      fraseDosLimitesNaoLidosShopee(causa),
    );
    const leitura = formDe('L-rasc').atributos.leitura;
    if (leitura.tipo !== 'falha') throw new Error('the section must say the read failed');
    expect(leitura.causa).toBe(causa);
    expect(leitura.relendo).toBe(false);
    expect(atributos).toHaveBeenCalledTimes(1);

    act(() => leitura.onLerDeNovo());
    await waitFor(() => expect(formDe('L-rasc').decisaoDePublicar.podePublicar).toBe(true));
    expect(atributos).toHaveBeenCalledTimes(2);
    expect(formDe('L-rasc').falhaDaLeitura).toBeNull();
    expect(formDe('L-rasc').atributos.leitura).toStrictEqual({ tipo: 'vazia', warning: null });
  });

  it('NEAR-MISS: faixas E árvore falharam ⇒ a razão é a das faixas (checadas antes) — nunca a da árvore no lugar', async () => {
    const falhou = new ShopeeClientHttpError(
      'Falhou.',
      502,
      'SHOPEE_HTTP_ERROR',
      null,
      'other',
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
    prontoParaPublicar(vi.fn<ShopeeClient['publicar']>(), {
      limitesDoItem: () => Promise.reject(falhou),
      atributos: () => Promise.reject(falhou),
    });
    h.links = [rascunhoPronto('L-rasc')];
    renderEditor();
    await waitFor(() => expect(formDe('L-rasc').falhaDaLeitura).not.toBeNull());
    const causa = descreverFalhaShopee(falhou, { desconhecido: '' }).mensagem;
    expect(formDe('L-rasc').decisaoDePublicar.impedimento).toBe('faixas-desconhecidas');
    expect(formDe('L-rasc').falhaDaLeitura?.mensagem).toBe(fraseDosLimitesNaoLidosShopee(causa));
    // The section still says its own failure.
    await waitFor(() => expect(formDe('L-rasc').atributos.leitura.tipo).toBe('falha'));
  });

  it('uma troca de categoria e uma edição de atributo no MESMO tick: a edição, feita sobre a árvore da categoria antiga, é ignorada — nunca aplicada ao rascunho da nova ⟷ QUASE-PAR: em ticks separados, a edição vale', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    // ONE render's handlers, both called before the next render.
    const form = formDe('L-rasc');
    act(() => {
      form.onCampo('category_id', 100088);
      form.onAtributo(100408, { tipo: 'lista', valueIds: [2530] });
    });
    expect(formDe('L-rasc').bloco.valores.category_id).toBe(100088);
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();

    // NEAR-MISS: back on 100087, the same edit in its own tick applies.
    act(() => formDe('L-rasc').onCampo('category_id', 100087));
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual(SEM_FIO);
  });

  it('`onAtributo` ANTES da árvore carregar não muda nada (nenhuma entrada nasce) ⟷ QUASE-PAR: carregada, a escolha cria a entrada e «Salvar rascunho» envia `patch.attributes` com a base que o operador viu', async () => {
    comAutoria();
    const { atributos, responder } = arvoresSobControle();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['attributes'],
    }));
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos,
      atualizarRascunho,
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    renderEditor();
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);

    await responder(100087);
    await waitFor(() => expect(formDe('L-rasc').atributos.leitura.tipo).toBe('lida'));
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual(SEM_FIO);
    expect(formDe('L-rasc').bloco.sujo).toBe(true);
    // The rows follow the entry: the pick is shown.
    expect(formDe('L-rasc').atributos.linhas[0]?.escolhidos).toStrictEqual([2530]);

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'L-rasc',
      base: { attributes: null },
      patch: { attributes: SEM_FIO },
    });
  });

  it('o editor usa a árvore da categoria EDITADA — depois de uma troca, nunca a da guardada: até a nova chegar nada edita; chegando, só os atributos DELA', async () => {
    comAutoria();
    const { atributos, responder } = arvoresSobControle();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos,
    });
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: COM_FIO_GUARDADO })];
    renderEditor();
    await responder(100087);
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));

    act(() => formDe('L-rasc').onCampo('category_id', 100088));
    // The held category's tree is still cached — and never read for the new one.
    expect(formDe('L-rasc').atributos.leitura).toStrictEqual({ tipo: 'carregando' });
    expect(formDe('L-rasc').atributos.linhas).toStrictEqual([]);
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();

    await responder(100088);
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([101029]));
    expect(atributos.mock.calls.map(([i]) => i.categoryId)).toStrictEqual([100087, 100088]);
    // 100408 is no attribute of 100088: the model refuses it, nothing changes.
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();
    // 100088's own attribute: a typed decimal with its unit, in the wire form.
    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '1,5', unidade: 'KG' }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual([
      {
        attribute_id: 101029,
        attribute_value_list: [{ value_id: 0, original_value_name: '1.5', value_unit: 'KG' }],
      },
    ]);

    // Back to the HELD category: its list is restored, and its CACHED tree read at once.
    act(() => formDe('L-rasc').onCampo('category_id', 100087));
    expect(formDe('L-rasc').atributos.leitura.tipo).toBe('lida');
    expect(linhasDe('L-rasc')).toStrictEqual([100408]);
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual(COM_FIO_GUARDADO);
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
  });

  it('⛔ «Marcar para remover» ANTES da árvore carregar não remove nada — sem a árvore todo guardado pareceria «sem lugar» ⟷ QUASE-PAR: carregada, só sai o que ela esconde', async () => {
    const FORA = {
      attribute_id: 999001,
      attribute_value_list: [{ value_id: 0, original_value_name: 'Valor inventado' }],
    };
    comAutoria();
    const { atributos, responder } = arvoresSobControle();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos,
    });
    const guardados = [...COM_FIO_GUARDADO, FORA];
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: guardados })];
    renderEditor();
    await waitFor(() => expect(formDe('L-rasc').bloco.camposEditaveis).toBe(true));
    expect(formDe('L-rasc').atributos.leitura).toStrictEqual({ tipo: 'carregando' });
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'remover-sem-lugar' }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual(guardados);
    expect(formDe('L-rasc').bloco.sujo).toBe(false);

    await responder(100087);
    await waitFor(() =>
      expect(formDe('L-rasc').atributos.semLugar.map((i) => i.attributeId)).toStrictEqual([999001]),
    );
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'remover-sem-lugar' }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual(COM_FIO_GUARDADO);
    expect(formDe('L-rasc').bloco.sujo).toBe(true);
  });

  it('⛔ uma árvore TRUNCADA chega TRUNCADA ao modelo: o guardado que ela não mostra não é «sem lugar» e uma edição o mantém ⟷ QUASE-PAR: completa, ele é «sem lugar» e a edição o tira', async () => {
    const FORA = {
      attribute_id: 999001,
      attribute_value_list: [{ value_id: 0, original_value_name: 'Valor inventado' }],
    };
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) =>
        respostaAtributos(input.categoryId, ARVORES.get(input.categoryId) ?? [], {
          truncated: input.categoryId === 100087,
        }),
    });
    h.links = [
      rascunho('L-trunc', { category_id: 100087, attributes: [FORA] }),
      rascunho('L-comp', { category_id: 100088, attributes: [FORA] }),
    ];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-trunc')).toStrictEqual([100408]));
    await waitFor(() => expect(linhasDe('L-comp')).toStrictEqual([101029]));
    expect(formDe('L-trunc').atributos.leitura).toStrictEqual({
      tipo: 'lida',
      truncated: true,
      warning: null,
    });
    expect(formDe('L-trunc').atributos.semLugar).toStrictEqual([]);
    act(() => formDe('L-trunc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-trunc').bloco.valores.attributes).toStrictEqual([FORA, ...SEM_FIO]);

    expect(formDe('L-comp').atributos.semLugar.map((i) => i.attributeId)).toStrictEqual([999001]);
    act(() => formDe('L-comp').onAtributo(101029, { tipo: 'texto', texto: '1,5', unidade: 'KG' }));
    expect(formDe('L-comp').bloco.valores.attributes).toStrictEqual([
      {
        attribute_id: 101029,
        attribute_value_list: [{ value_id: 0, original_value_name: '1.5', value_unit: 'KG' }],
      },
    ]);
  });

  it('a árvore lida fica em cache pelo tempo do apps/shopee: voltar à categoria GUARDADA não lê de novo ⟷ QUASE-PAR: a categoria NOVA lê uma vez', async () => {
    comAutoria();
    const atributos = vi.fn<ShopeeClient['atributos']>(async (input) =>
      respostaDaArvore(input.categoryId),
    );
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos,
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    act(() => formDe('L-rasc').onCampo('category_id', 100088));
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([101029]));
    act(() => formDe('L-rasc').onCampo('category_id', 100087));
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    // Give a refetch-on-mount its chance before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(atributos.mock.calls.map(([i]) => i.categoryId)).toStrictEqual([100087, 100088]);
  });

  it('⭐ um espaço digitado depois de um personalizado GUARDADO fica na tela (limpo para a escrita, mas é a tela do operador) e as palavras seguintes saem separadas ⟷ QUASE-PAR: redigitado igual, limpo, a linha mostra o guardado', async () => {
    const NOME_DO_MODELO: AtributoDto = {
      attributeId: 101040,
      mandatory: false,
      name: 'Nome do Modelo',
      attributeInfo: infoDoAtributo({ inputType: 3, inputValidationType: 2 }),
      attributeValueList: [],
    };
    const ALFA = [
      {
        attribute_id: 101040,
        attribute_value_list: [{ value_id: 0, original_value_name: 'Alfa' }],
      },
    ];
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['attributes'],
    }));
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaAtributos(input.categoryId, [NOME_DO_MODELO]),
      atualizarRascunho,
    });
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: ALFA })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([101040]));
    const digitar = (texto: string) =>
      act(() => formDe('L-rasc').onAtributo(101040, { tipo: 'texto', texto, unidade: null }));

    digitar('Alfa ');
    expect(formDe('L-rasc').atributos.linhas[0]?.textoDigitado).toBe('Alfa ');
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
    digitar('Alfa');
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
    expect(formDe('L-rasc').atributos.linhas[0]?.textoDigitado).toBe('Alfa');

    digitar('Alfa ');
    digitar('Alfa B');
    expect(formDe('L-rasc').bloco.sujo).toBe(true);
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0].patch).toStrictEqual({
      attributes: [
        {
          attribute_id: 101040,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Alfa B' }],
        },
      ],
    });
  });

  it('⭐ a unidade escolhida ANTES do número num rascunho guardado fica (limpo, nada a salvar) e o número depois a usa ⟷ QUASE-PAR: apagada a unidade, nada fica', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100088 })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([101029]));
    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '', unidade: 'KG' }));
    expect(formDe('L-rasc').atributos.linhas[0]?.unidadeDigitada).toBe('KG');
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '1,5', unidade: 'KG' }));
    expect(formDe('L-rasc').bloco.valores.attributes).toStrictEqual([
      {
        attribute_id: 101029,
        attribute_value_list: [{ value_id: 0, original_value_name: '1.5', value_unit: 'KG' }],
      },
    ]);
    expect(formDe('L-rasc').bloco.impedimento).toBeNull();

    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '', unidade: null }));
    expect(formDe('L-rasc').atributos.linhas[0]?.unidadeDigitada).toBeNull();
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
  });

  it('⛔ uma lista editada cuja categoria OUTRA aba trocou: «Salvar rascunho» não envia nada e abre o conflito com «Categoria» — a rota não recusaria ⟷ QUASE-PAR: só a lista mudou ⇒ a rota decide (enviado)', async () => {
    comAutoria();
    const atualizarRascunho = vi.fn<ShopeeClient['atualizarRascunho']>(async (input) => ({
      linkDocId: input.linkDocId,
      gravados: ['attributes'],
    }));
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
      atualizarRascunho,
    });
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: COM_FIO_GUARDADO })];
    const { rerender } = renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));

    // Another tab moved the category (keeping an equal list).
    h.links = [rascunho('L-rasc', { category_id: 100088, attributes: COM_FIO_GUARDADO })];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').divergencias).toEqual(['category_id']);
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await screen.findByTestId('shopee-rascunho-conflito');
    expect(h.conflito?.conflito).toStrictEqual({
      linkDocId: 'L-rasc',
      operacao: 'atualizar',
      conflitos: [{ campo: 'category_id', atual: 100088 }],
    });
    expect(atualizarRascunho).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    // NEAR-MISS: only the list moved — the route's own baseline decides.
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: [] })];
    rerenderEditor(rerender);
    expect(formDe('L-rasc').divergencias).toEqual(['attributes']);
    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() => expect(atualizarRascunho).toHaveBeenCalledTimes(1));
    expect(atualizarRascunho.mock.calls[0]?.[0]).toMatchObject({
      base: { attributes: COM_FIO_GUARDADO },
      patch: { attributes: SEM_FIO },
    });
  });

  it('a digitação que o modelo BLOQUEIA fica na entrada, aparece na linha e fecha o «Salvar» ⟷ QUASE-PAR: a mesma digitação com vírgula vale', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100088 })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([101029]));
    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '1.5', unidade: 'KG' }));
    expect(formDe('L-rasc').atributos.linhas[0]?.digitacao).toBe('tipo-de-valor');
    expect(formDe('L-rasc').atributos.linhas[0]?.textoDigitado).toBe('1.5');
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();
    expect(formDe('L-rasc').bloco.impedimento).toBe('campo-invalido');
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(true);

    act(() => formDe('L-rasc').onAtributo(101029, { tipo: 'texto', texto: '1,5', unidade: 'KG' }));
    expect(formDe('L-rasc').atributos.linhas[0]?.digitacao).toBeNull();
    expect(formDe('L-rasc').bloco.impedimento).toBeNull();
    expect(botaoDoRascunho('L-rasc', 'Salvar rascunho').disabled).toBe(false);
  });

  it('as linhas seguem o MESMO estado que a edição aplica: sem entrada, a lista guardada é lista E base; editada, «Serão removidos ao salvar» lista o que sai ⟷ QUASE-PAR: «Desfazer alterações» o devolve', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100087, attributes: COM_FIO_GUARDADO })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    expect(formDe('L-rasc').atributos.linhas[0]?.escolhidos).toStrictEqual([2498]);
    expect(formDe('L-rasc').atributos.removidosAoSalvar).toStrictEqual([]);
    expect(formDe('L-rasc').revisaoDoDesfazer).toBe(0);

    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();
    expect(formDe('L-rasc').atributos.removidosAoSalvar.map((i) => i.attributeId)).toStrictEqual([
      100408,
    ]);
    // An ordinary edit never remounts the section (the key stays).
    expect(formDe('L-rasc').revisaoDoDesfazer).toBe(0);

    act(() => formDe('L-rasc').onDesfazer());
    expect(formDe('L-rasc').atributos.removidosAoSalvar).toStrictEqual([]);
    expect(formDe('L-rasc').atributos.linhas[0]?.escolhidos).toStrictEqual([2498]);
    // «Desfazer alterações» remounts it: its screen-only state starts over.
    expect(formDe('L-rasc').revisaoDoDesfazer).toBe(1);
  });

  it('um rascunho RECÉM-SALVO mostra o que salvou: nada pendente, nenhum «Serão removidos ao salvar» de uma gravação já feita ⟷ QUASE-PAR: antes de salvar, a mesma lista os mostra', async () => {
    comAutoria();
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
      atualizarRascunho: async (input): Promise<RespostaAtualizar> => ({
        linkDocId: input.linkDocId,
        gravados: ['attributes'],
      }),
    });
    h.links = [
      rascunho('L-rasc', {
        category_id: 100087,
        attributes: COM_FIO_GUARDADO,
        ultimaModificacao: 1_000,
      }),
    ];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [] }));
    // Positive first: pending, the removal is staged and shown.
    expect(formDe('L-rasc').atributos.removidosAoSalvar).toHaveLength(1);

    fireEvent.click(botaoDoRascunho('L-rasc', 'Salvar rascunho'));
    await waitFor(() =>
      expect(formDe('L-rasc').bloco.avisos).toContain(FRASE_RASCUNHO_AGUARDANDO_SERVIDOR_SHOPEE),
    );
    expect(formDe('L-rasc').bloco.camposEditaveis).toBe(false);
    expect(formDe('L-rasc').atributos.removidosAoSalvar).toStrictEqual([]);
  });

  it('somente leitura (sem permissão de escrita): `onAtributo` não cria entrada nem muda nada', async () => {
    h.permitidos = new Set([PERM.integracao.read]);
    h.client = shopeeClientFalso({
      limitesDoItem: async (input) => limitesDoItem(input.categoryId ?? null),
      atributos: async (input) => respostaDaArvore(input.categoryId),
    });
    h.links = [rascunho('L-rasc', { category_id: 100087 })];
    renderEditor();
    await waitFor(() => expect(linhasDe('L-rasc')).toStrictEqual([100408]));
    expect(formDe('L-rasc').bloco.camposEditaveis).toBe(false);
    act(() => formDe('L-rasc').onAtributo(100408, { tipo: 'lista', valueIds: [2530] }));
    expect(formDe('L-rasc').bloco.valores.attributes).toBeNull();
    expect(formDe('L-rasc').bloco.sujo).toBe(false);
  });

  it('o caminho genérico `onCampo` nunca escreve uma lista de atributos — o tipo a recusa', () => {
    // Compile-time only (never run): P16 relies on `logistic_info` staying a generic field.
    const _generico = (p: RascunhoShopeeProps) => {
      p.onCampo('item_name', 'Camiseta');
      // @ts-expect-error — `attributes` goes only through `onAtributo` (the visible filter, the order, the typings).
      p.onCampo('attributes', null);
    };
    expect(typeof _generico).toBe('function');
  });
});
