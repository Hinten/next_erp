'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { FirebaseError } from 'firebase/app';
import { getDoc, type Firestore } from 'firebase/firestore';
import {
  keepPreviousData,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  ACAO_STATUS_ANUNCIO,
  CAMPO_RASCUNHO_SHOPEE,
  INTEGRACAO_TIPO,
  PRODUTO_EXTRA_DATA_DOC_ID,
  ehKitVirtualEfetivo,
  ehRascunhoShopee,
  idDoRef,
  lerRefTabelaDeMedidas,
  naoDocId,
  vinculoShopeeEhDaConta,
  type AcaoStatusAnuncio,
  type CamposRascunhoShopee,
  type EstadoPublicacaoRascunhoShopee,
  type Integracao,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { CATEGORIAS_SHOPEE_STALE_MS } from '@/components/shopee/ShopeeCategoriaBrowser';
import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { produtoShopeeLinkCollection } from '@/lib/data/produtoShopeeLinkCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import {
  DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE,
  FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE,
  FRASE_CONFIRMAR_DESCARTE_SHOPEE,
  FRASE_LIMITE_NA_CRIACAO_DE_KIT,
  FRASE_RASCUNHO_CRIADO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE,
  FRASE_RASCUNHO_DESCARTADO_SHOPEE,
  FRASE_RASCUNHO_SALVO_SHOPEE,
  FRASE_RASCUNHO_SEM_MUDANCA_SHOPEE,
  ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE,
  TITULO_SEGUNDO_ANUNCIO_SHOPEE,
  criacaoDeKitIncerta,
  esperaDoKitIncerto,
  formatarInstanteShopee,
  gravarIncerto,
  itemIdDoAnuncioShopee,
  lerIncerto,
  limiteNaCriacaoDeKit,
  resumoDaReverificacaoShopee,
  textoDoSegundoAnuncioShopee,
  type IncertoKitShopee,
  type OperacaoRascunhoShopee,
} from '@/lib/shopee/anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  useShopeeClient,
  type PublicarShopeeInput,
  type ShopeeClient,
} from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import {
  algumRascunhoShopeeSujo,
  categoriaAceitaNoBlocoShopee,
  comCampoRascunhoShopee,
  conciliarEdicaoRascunhoShopee,
  conflitosAtualizadosDoRascunhoShopee,
  corpoAtualizarRascunhoShopee,
  corpoCriarRascunhoShopee,
  corpoDescartarRascunhoShopee,
  divergenciasDoServidorShopee,
  edicaoDoRascunhoGuardadoShopee,
  edicaoRascunhoShopeeSuja,
  estadoDoBlocoRascunhoShopee,
  existentesDosVinculosShopee,
  falhaDoRascunhoShopee,
  idDeNovoRascunhoShopee,
  marcarRascunhoShopeeSalvo,
  novaEdicaoRascunhoShopee,
  projecaoGuardadaDoRascunhoShopee,
  rebasearEdicaoRascunhoShopee,
  segundoAnuncioNaContaShopee,
  type BlocoRascunhoShopee,
  type CampoDoFormularioRascunhoShopee,
  type DescarteDoRascunhoShopee,
  type EdicaoRascunhoShopee,
  type ExistentesNaContaShopee,
  type FormularioRascunhoShopee,
} from '@/lib/shopee/rascunho';
import { useReceitaKitShopee } from '@/lib/shopee/useReceitaKitShopee';
import { ContaTabs, type ContaTabItem } from '../marketplace/ContaTabs';
import type {
  AcaoDoAnuncioShopee,
  AcoesShopee,
  ArmaKitShopee,
  IncertoKitNaTela,
} from './AcoesAnuncioShopee';
import {
  ContaShopeePanel,
  type AvisoDeRascunhoShopee,
  type ContaShopee,
  type RascunhosShopee,
  type TabelaMedidasDoProduto,
  type VinculoShopee,
} from './ContaShopeePanel';
import { textoPreenchido } from './campos';
import { idDeCategoriaShopeeValido } from './CategoriaRascunhoShopee';
import {
  ConflitoRascunhoShopeeModal,
  type ConflitoRascunhoShopeeAberto,
} from './ConflitoRascunhoShopeeModal';
import type { DesfechoAcaoShopee } from './DesfechoAcaoShopee';
import { KitNativoShopeeModal, type AlvoDoKitShopee } from './KitNativoShopeeModal';
import type {
  AcaoDoRascunhoShopee,
  RascunhoShopeeProps,
  ResultadoDoRascunhoShopee,
  TextosDoProdutoRascunhoShopee,
} from './RascunhoShopee';

/**
 * The produto editor's **Shopee** tab (step 21-3, #1529): one tab per Shopee
 * conta, each holding every listing that conta has on this produto — its state,
 * the refusals Shopee or the ERP stored on it, the violations, the template
 * entry the produto's tabela de medidas holds for it (never what a publish
 * sent — residual 7), the storefront link, the native kit (its badge, the ERP
 * recipe and its warnings), on demand its models, and the actions on it: pause
 * / reactivate, re-verify, republish, recriar / converter em kit nativo — and
 * (#1911 P10) the listing DRAFTS of a first publish, authored here.
 *
 * NO CLIENT WRITE. Every listing document is written by apps/shopee — publish,
 * the import, the stock and price senders, pause/re-list, the re-verify, the
 * listing pushes and the listing DRAFT route — so the link docs are read LIVE:
 * the tab repaints from the same snapshot those writers land in. An action
 * here names ONE listing and calls the apps/shopee route DIRECTLY
 * (`useShopeeClient`), never the registry rows — those back the /produtos
 * selection-wide pushes (the Mercado Livre tab's per-listing actions do the
 * same; its per-conta stock push goes through `enviarEstoqueParaIntegracao`).
 *
 * ## The listing DRAFT (#1911 P10) — authored here, written by apps/shopee
 *
 * A draft is a link with no listing yet (`ehRascunhoShopee`). «Novo anúncio»
 * opens a LOCAL draft (a minted id, nothing written) — behind the
 * second-listing confirmation when the conta already holds one of the
 * produto's listings or drafts (D15); its block edits Título, Descrição,
 * Categoria and Marca; «Salvar rascunho» sends a create or an edit, «Descartar»
 * a discard, each through the draft route (P8's client methods) and the SAME
 * one-write lock as every other action. Publicar is not offered yet (P11).
 *
 * Every decision is `@/lib/shopee/rascunho`'s — what is dirty, what each body
 * carries, what each refusal means, what a block may do now
 * (`estadoDoBlocoRascunhoShopee`); this file holds the STATE and routes the
 * answers. Rule 7: the create is tier 0 (a client id the route `create()`s);
 * an edit and a discard carry the `base` the operator SAW (tier 3 — a loser is
 * a 409 the operator resolves, never a silent overwrite).
 *
 *  - **The entry** (`edicoes`, by link doc id) exists only while the operator
 *    edits; a stored draft with no entry renders its snapshot. The first edit
 *    is allowed only once the links snapshot came from the SERVER
 *    (`fromCache === false`), so a cached pre-write copy never becomes the
 *    `base`.
 *  - **Reconciled during render, never in an effect**: every render reads each
 *    entry through `conciliarEdicaoRascunhoShopee` against the current
 *    snapshot — a clean one is dropped (the snapshot is always current), a
 *    dirty one is kept over a concurrent write, a dirty one whose draft got
 *    published or discarded elsewhere is dropped WITH a notice the operator
 *    dismisses (never a silent drop).
 *  - **After a 2xx** the entry shows what was saved, read-only, until THIS
 *    draft's echo: its document's stamp moves past the one it had when the
 *    request LEFT (a create: its document arrives) — another link's write is
 *    no echo (`conciliarEdicaoRascunhoShopee`). The echo then repaints the
 *    block. An answer that wrote nothing drops the entry at once: no echo
 *    will come. Nor may one come while the bounded links query is FULL
 *    (`MAX_LINKS`): then any newer snapshot releases the entry (`saturado`),
 *    never a block stuck read-only.
 *  - **The publish reading** (`estadoPublicacaoRascunhoShopee`, through the
 *    block decision) is taken against `relogioRascunho`, a clock re-read by a
 *    timer at the instant the reading changes (`releituraEmMs` = `aguardarMs`
 *    + 1 s) — never `agoraMs`, which is frozen at mount and would never see
 *    `em-andamento` turn into `incerta`. A clock that is behind only ever
 *    reads a lock as still in progress (the reading moves one way in time),
 *    and the timer fires at the ABSOLUTE instant the reading changes, so it
 *    costs at most one immediate re-read.
 *  - **A draft whose conta document is gone** (a «não encontrada» tab whose
 *    id a document could carry) is read-only and offers «Descartar» alone —
 *    the discard route reads only the link — so it never blocks the produto's
 *    delete for good; nothing is read for that conta (no tree, no bands, no
 *    brand shortlist).
 *  - **Unsaved work** is reported through `onDirtyChange` with NO cleanup (see
 *    `ShopeeTab`) and marks the conta's tab; the page blocks its own save's
 *    navigation on it (`exigirRascunhosShopeeSalvos`).
 *
 * ## One write at a time, and a kit create that may have happened
 *
 * Every write runs through `executar`, which holds a `useRef` lock set
 * SYNCHRONOUSLY before its first `await` and released in `finally` — two clicks
 * landing before a re-render (a double click on a confirm) send ONE request —
 * and every write button is disabled while it is held. That matters most for
 * the two kit CREATE arms: `add_kit_item` is not idempotent.
 *
 * A recriar / converter that ends without a definite answer — the 202, a
 * network error, a 2xx it cannot read, a 5xx other than a rate-limited 502
 * (`criacaoDeKitIncerta`) — may still have created the kit. It is UNCERTAIN,
 * never "falhou": the conta's kit buttons wait out `aguardarMs` (or the schemas'
 * `AGUARDAR_KIT_INCERTO_SHOPEE_MS`), after which "Repetir" re-sends the
 * IDENTICAL body — the only safe re-send, since a plain publish would reach a
 * different arm. (A rate-limited 502 is definite — the kit's link is written
 * before any call that can hit the limit, so a re-send resumes it — but the
 * kit may already exist, and the outcome says so: `limiteNaCriacaoDeKit`.)
 *
 * The wait is kept in this tab's `sessionStorage` (`lerIncerto` /
 * `gravarIncerto`) and written AHEAD: a provisional wait is stored before the
 * request leaves and the answer replaces it, so a reload — or the page left and
 * re-opened — WHILE the request is in flight finds the conta still waiting
 * instead of an enabled "Converter". A blocked store keeps it for this page
 * only. What no browser lock covers — a second tab, a second operator, the CLI —
 * is the server-lease follow-up's (#1912).
 *
 * ## Which conta a link belongs to
 *
 * `vinculoShopeeEhDaConta` (`@delfrance/schemas`), the fold the stock and price
 * planners attribute a link with — so the two stored encodings of one conta ref
 * (`documents/integracao/X`, `integracao/X`) land in the SAME tab here exactly
 * as they do there.
 *
 * The contas query is BOUNDED (`MAX_CONTAS`, unordered) while the links are not
 * bounded by it, so a conta a link names that the query did not return is read
 * BY ID — one document lookup each, never a new query shape (root `CLAUDE.md`
 * rule 1) — and gets its real tab: name, `shop_id`, storefront link. Only a conta
 * whose document does NOT exist (or whose id no document can carry) gets
 * "Conta … (não encontrada)" ("carregando…" while its read is in flight): an
 * orphan is shown, never dropped, and never called missing when it is merely
 * past the bound (#1951 review).
 *
 * ## The two rules a non-persistent section needs
 *
 * The tab is NOT in `PRODUTO_PERSISTENT_SECTIONS` (it stages nothing in the
 * produto form and registers no flush — its drafts are saved by their own
 * button; see `ShopeeTab`), so `<Activity mode="hidden">` unmounts its effects
 * on every tab switch and re-runs them on return:
 *
 *  - **R1 — the spinner gates on `data === undefined`, never on `loading`.**
 *    `useSnapshot` keeps the last `data` while it re-listens (`loading: true`),
 *    so a re-show never unmounts `ContaTabs` — which would lose the selected
 *    conta — or the listing blocks.
 *  - **R2 — every piece of UI state lives HERE, keyed by link doc id**
 *    (`modelosAbertos`, `kitAbertos`, `desfechos`, the write in flight, the
 *    pause and the kit create being confirmed, the principal picked, the
 *    drafts being edited and their last sentence, the draft conflict, discard
 *    and second-listing confirmations) or by conta (`incertos`), never inside
 *    a block: React keeps a hidden Activity's state, and one map at the top
 *    survives anything a child's remount could throw away — an in-flight
 *    handler's `setState` lands here normally.
 */

/**
 * How many Shopee contas the live query returns — the `/medidas` Shopee tab's
 * bound. A conta past it that HOLDS a listing here is still shown: it is read by
 * id (`lerContasPorId`). Only a conta past it with no listing gets no tab.
 */
const MAX_CONTAS = 50;

/**
 * How many listing links the tab reads for one produto. Not `MAX_CONTAS`: one
 * conta can hold several listings on one produto (a native kit beside the
 * ordinary listing it superseded, a recriar's old and new kit). The alert below
 * says so out loud when the cap is reached, rather than truncating quietly —
 * Mercado Livre's `MAX_LINKS` reasoning.
 */
const MAX_LINKS = MAX_CONTAS * 4;

/**
 * The tab of the links whose conta ref names no readable id. Firestore forbids
 * a document id of the `__…__` form, so no real conta can collide with it.
 */
const CHAVE_SEM_CONTA = '__sem_conta__';

/** Firestore reserves every `__…__` id, so no conta can carry one — and none is read. */
const ID_RESERVADO = /^__.*__$/;

/** Can a conta with this id exist at all? If not, "não encontrada" is the truth and nothing is read. */
function idDeContaLegivel(id: string): boolean {
  return !naoDocId(id) && !ID_RESERVADO.test(id);
}

/** One `integracao` document as a tab — the same mapping for the query's rows and the by-id reads. */
function contaShopeeDoDoc(id: string, dados: Integracao): ContaShopee {
  return {
    id,
    // A soft-read hands over the RAW document when it does not parse.
    nome: textoPreenchido(dados.nome) ?? `Conta ${id}`,
    shopId: dados.shop_id,
    ativo: dados.ativo !== false,
    encontrada: true,
    carregando: false,
  };
}

/**
 * The contas the links name that the live query did NOT return, read BY ID —
 * `getDoc` on each document, no query. `null` = no SHOPEE conta has that id: the
 * document does not exist, or it is another channel's `integracao` — the
 * query's own `tipo` filter, applied to the one document, so a by-id read never
 * counts a conta the query would not.
 *
 * No `catch`: a failed read (offline with nothing cached, a permission change)
 * fails the whole lookup, and the tab shows the error instead of calling a conta
 * it could not read "não encontrada".
 */
async function lerContasPorId(
  db: Firestore,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ContaShopee | null>> {
  const lidas = await Promise.all(
    ids.map(async (id) => {
      const snap = await getDoc(integracaoCollection.docRef(db, {}, id));
      const dados = snap.data();
      const ehShopee = dados !== undefined && dados.tipo === INTEGRACAO_TIPO.shopee;
      return [id, ehShopee ? contaShopeeDoDoc(id, dados) : null] as const;
    }),
  );
  return new Map(lidas);
}

export interface ShopeeEditorProps {
  produtoId: string;
  db: Firestore;
  /** The produto form is read-only: every action button is disabled, every draft read-only. */
  disabled?: boolean;
  /**
   * Whether any listing draft of this produto holds unsaved work — reported on
   * every change and on every re-show, and NEVER reset by a cleanup (a hidden
   * Activity unmounts effects; a cleanup reporting `false` would disarm the
   * page's leave-guard while the typed draft is still there).
   */
  onDirtyChange?: (dirty: boolean) => void;
}

/** The pause being confirmed: a pause stops a live sale, so it is asked first. */
interface AlvoDaPausa {
  readonly contaId: string;
  readonly linkDocId: string;
}

/** The second-listing confirmation being shown (D15). */
interface PedidoDeSegundoAnuncio {
  readonly contaId: string;
  readonly existentes: ExistentesNaContaShopee;
  /**
   * `null` — «Novo anúncio»: a LOCAL draft follows the confirmation. A link doc
   * id — the create the route refused with 409 `rascunhoContaJaTemAnuncio`,
   * re-sent with `confirmarSegundoAnuncio` on confirm.
   */
  readonly reenviar: string | null;
}

/** The discard being confirmed. */
interface DescarteAberto {
  readonly contaId: string;
  readonly linkDocId: string;
  readonly tipo: DescarteDoRascunhoShopee;
  /**
   * The HELD projection when «Descartar» was clicked — what the operator SAW,
   * sent as the discard's `base` (`null` for a local draft: nothing is sent).
   * Never re-read at confirm: a draft changed meanwhile is a 409, not a delete
   * of something unseen.
   */
  readonly projecao: CamposRascunhoShopee | null;
}

/** One draft block as this render decides it. */
interface BlocoDoEditor {
  readonly contaId: string;
  /** The stored document, or `null` for a local draft. */
  readonly link: Record<string, unknown> | null;
  readonly podeEditar: boolean;
  /** The operator may discard it — also on a tab whose conta document is gone (`decidirBloco`). */
  readonly permiteDescarte: boolean;
  readonly bloco: BlocoRascunhoShopee;
}

/** The draft writes — `emVoo` names one of these when a draft write is in flight. */
function ehAcaoDeRascunho(acao: AcaoDoAnuncioShopee): acao is AcaoDoRascunhoShopee {
  return acao === 'salvar-rascunho' || acao === 'descartar-rascunho';
}

/** `limitesDoItem`'s cache key part for one conta's category. */
function chaveDeLimites(contaId: string, categoryId: number): string {
  return `${contaId}/${String(categoryId)}`;
}

/**
 * An uncertain kit create as this page holds it: the stored wait and body, plus
 * Shopee's refusal sentence when the 202 carried one (never stored — a reload
 * keeps the wait, not the sentence).
 */
type IncertoNaPagina = IncertoKitShopee & { readonly fraseShopee: string | null };

/** A token refresh that could not reach the network: nothing was sent, and a retry is safe. */
export const FRASE_SESSAO_SEM_CONEXAO_SHOPEE =
  'Sem conexão para renovar a sessão — nada foi enviado. Confira a conexão e tente de novo.';

/** Any other token-refresh failure: nothing was sent, and only signing in again helps. */
export const FRASE_SESSAO_NAO_RENOVADA_SHOPEE =
  'A sessão não pôde ser renovada — nada foi enviado. Entre novamente para continuar.';

/**
 * A failed ID-token refresh (`getAuthToken()`, awaited BEFORE any request
 * leaves) worded for the operator. The SDK's own message is English and
 * developer-shaped (`Firebase: Error (auth/network-request-failed).`), so it
 * is never shown: the code picks one of two pt-BR sentences — a network
 * failure can be retried, any other code (an expired or revoked session, a
 * disabled user) needs a new sign-in. Both say nothing was sent, which holds:
 * the refresh precedes the request.
 */
export function fraseDaSessaoShopee(err: FirebaseError): string {
  return err.code === 'auth/network-request-failed'
    ? FRASE_SESSAO_SEM_CONEXAO_SHOPEE
    : FRASE_SESSAO_NAO_RENOVADA_SHOPEE;
}

/** A link that is not (or no longer) this conta's — the 404s of publish and re-verify. */
const MENSAGEM_VINCULO_FORA_DA_CONTA =
  'Este vínculo não pertence mais a esta conta — a lista foi atualizada.';

/** Which kit create arm a publish input is, or `null` for any other publish. */
function armaDoPedido(pedido: PublicarShopeeInput | undefined): ArmaKitShopee | null {
  if (pedido?.recriar === true) return 'recriar';
  if (pedido?.converterEmKit === true) return 'converter';
  return null;
}

/**
 * A failed action, worded for the operator. The publish 422s keep their rows
 * (each with its `acao`) and, after a kit create arm, which arm on which link
 * was refused; the link-addressing codes get the tab's own sentence;
 * everything else is `descreverFalhaShopee`, the channel's one ladder.
 */
function desfechoDaFalha(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
  pedido: PublicarShopeeInput | undefined,
): DesfechoAcaoShopee {
  if (err instanceof ShopeeClientHttpError) {
    const { code, detalhes } = err;
    if (
      code === CODIGO_FALHA_SHOPEE.publicacaoBloqueada ||
      code === CODIGO_FALHA_SHOPEE.publicacaoRecusada
    ) {
      const arma = armaDoPedido(pedido);
      return {
        tipo: 'recusado',
        antesDaShopee: code === CODIGO_FALHA_SHOPEE.publicacaoBloqueada,
        etapa: detalhes.etapa,
        problemas: detalhes.problemas ?? [],
        mensagem: err.message,
        pedidoKit:
          arma === null || pedido?.linkDocId === undefined
            ? null
            : { arma, linkDocId: pedido.linkDocId },
      };
    }
    if (
      code === CODIGO_FALHA_SHOPEE.anuncioNaoEncontrado ||
      code === CODIGO_FALHA_SHOPEE.anuncioSemVinculo
    ) {
      return { tipo: 'falha', mensagem: MENSAGEM_VINCULO_FORA_DA_CONTA };
    }
    if (code === CODIGO_FALHA_SHOPEE.anuncioNaoPublicado) {
      return { tipo: 'falha', mensagem: 'Este vínculo ainda não foi publicado na Shopee.' };
    }
    if (code === CODIGO_FALHA_SHOPEE.contaPausada) {
      const ms = detalhes.pausadoAte === null ? null : parseIsoToMillis(detalhes.pausadoAte);
      const ate = ms === null ? null : formatarInstanteShopee(ms);
      return {
        tipo: 'falha',
        mensagem:
          'A cota diária da Shopee desta conta se esgotou' +
          (ate === null ? '.' : ` — até ${ate}.`),
      };
    }
  }
  // Definite, but NOT "nothing ran": the limited call may follow a successful
  // `add_kit_item` (`limiteNaCriacaoDeKit`).
  if (armaDoPedido(pedido) !== null && limiteNaCriacaoDeKit(err)) {
    return { tipo: 'falha', mensagem: FRASE_LIMITE_NA_CRIACAO_DE_KIT };
  }
  return {
    tipo: 'falha',
    mensagem: descreverFalhaShopee(err, { desconhecido: 'Falha ao falar com a Shopee.' }).mensagem,
  };
}

export function ShopeeEditor({ produtoId, db, disabled, onDirtyChange }: ShopeeEditorProps) {
  // `integracao` is integracao.read-protected while the links follow the
  // produto's permissions, so the contas query is gated on the bit — without
  // it Firestore would answer a raw permission-denied. `loading` first: the
  // hook answers `allowed: false` while the claims resolve.
  const { allowed: canRead, loading: permLoading } = usePermission(PERM.integracao.read);

  // Memoised: `docRef()` returns a fresh object per call, and `useDocSnapshot`
  // re-subscribes on ref identity. The page already listens to this document,
  // so the SDK serves both from one watch.
  const produtoDocRef = useMemo(() => produtoCollection.docRef(db, {}, produtoId), [db, produtoId]);
  const produtoSnap = useDocSnapshot(produtoDocRef);
  const produto = produtoSnap.data?.data;
  // A variation child carries no listing of its own — its MODEL lives on the
  // parent's listing — so the tab sends the operator there and reads nothing.
  // ⚠️ "Child" is the publish dispatcher's test (`publicarShopee.ts`: any
  // non-empty string), NOT a trim: the tab's Republicar reaches that gate, so a
  // whitespace-only `paiId` the dispatcher refuses as `produto-e-filho` must
  // not be offered as a root here either. `''` is a root for every rule.
  const paiBruto: unknown = produto?.paiId;
  const paiId = typeof paiBruto === 'string' && paiBruto !== '' ? paiBruto : null;
  const ehRaiz = produtoSnap.data !== undefined && paiId === null;

  const contasQuery = useMemo(
    () =>
      canRead
        ? buildQuery(integracaoCollection.ref(db, {}), [
            whereEqual('tipo', INTEGRACAO_TIPO.shopee),
            limit(MAX_CONTAS),
          ])
        : null,
    [db, canRead],
  );
  const contasSnap = useSnapshot(contasQuery);

  // Gated on the same bit: without the contas there is no tab to hold a link.
  const linksQuery = useMemo(
    () =>
      ehRaiz && canRead
        ? buildQuery(produtoShopeeLinkCollection.ref(db, { produtoId }), [limit(MAX_LINKS)])
        : null,
    [db, produtoId, ehRaiz, canRead],
  );
  const linksSnap = useSnapshot(linksQuery);

  // The conta ids the links name that the bounded contas query did not return —
  // sorted, so the lookup's key is the SET. Read only once both snapshots are in.
  const contasDaPagina = contasSnap.data;
  const vinculosLidos = linksSnap.data;
  const contaIdsFora = useMemo<readonly string[]>(() => {
    if (contasDaPagina === undefined || vinculosLidos === undefined) return [];
    const naPagina = new Set(contasDaPagina.map((c) => c.id));
    const ids = new Set<string>();
    for (const l of vinculosLidos) {
      const id = idDoRef(l.data.contaProdutoShopeeOuterRef);
      if (id !== null && !naPagina.has(id) && idDeContaLegivel(id)) ids.add(id);
    }
    return [...ids].sort();
  }, [contasDaPagina, vinculosLidos]);
  const contasForaQuery = useQuery({
    queryKey: ['shopee-contas-por-id', contaIdsFora],
    queryFn: contaIdsFora.length === 0 ? skipToken : () => lerContasPorId(db, contaIdsFora),
    // A new id arriving while the tab is open changes the key: the contas already
    // read keep their names (and tab places) while the new set is read, and only
    // the new id reads "carregando…".
    placeholderData: keepPreviousData,
  });
  const contasFora = contasForaQuery.data;

  // The produto's tabela de medidas: each listing block says which Shopee
  // template entry it holds for that listing's conta and category. The ref is
  // resolved by `lerRefTabelaDeMedidas` — the rule the Shopee publish resolves
  // it with — so a ref into another collection reads NOTHING here, as it reads
  // nothing there. Memoised for the reason `produtoDocRef` is.
  const tabelaModaUid: unknown = produto?.tabelaDeMedidasModaUid;
  const refTabela = useMemo(() => lerRefTabelaDeMedidas(tabelaModaUid), [tabelaModaUid]);
  const tabelaDocId = refTabela.tipo === 'tabela' ? refTabela.id : null;
  const tabelaDocRef = useMemo(
    () =>
      ehRaiz && tabelaDocId !== null ? tabelaDeMedidasCollection.docRef(db, {}, tabelaDocId) : null,
    [db, ehRaiz, tabelaDocId],
  );
  const tabelaSnap = useDocSnapshot(tabelaDocRef);
  const tabelaMedidas = useMemo<TabelaMedidasDoProduto>(() => {
    if (refTabela.tipo === 'sem-tabela') return { estado: 'sem-tabela' };
    if (refTabela.tipo === 'ref-invalida') return { estado: 'ref-invalida', ref: refTabela.ref };
    if (tabelaSnap.data === undefined) return { estado: 'carregando' };
    if (tabelaSnap.data === null) return { estado: 'ausente', id: refTabela.id };
    return {
      estado: 'tabela',
      id: refTabela.id,
      nome: tabelaSnap.data.data.nome,
      entradasShopee: tabelaSnap.data.data.tabelasMedidasShopee,
    };
  }, [refTabela, tabelaSnap.data]);

  // R2: which listings have their "Variações" open, by link doc id.
  const [modelosAbertos, setModelosAbertos] = useState<ReadonlySet<string>>(() => new Set());
  const alternarModelos = useCallback((linkDocId: string) => {
    setModelosAbertos((prev) => {
      const next = new Set(prev);
      if (next.has(linkDocId)) next.delete(linkDocId);
      else next.add(linkDocId);
      return next;
    });
  }, []);

  // The instant the stock skip set is read against (`pularPorRecusaAnterior`
  // takes its clock as a parameter). Fixed when the editor mounts: a skip whose
  // time half expires while the tab is open reads as armed until the next
  // open, which is the cheap direction for a notice. ⚠️ NEVER the draft's
  // publish reading's clock: that one must move (`relogioRascunho`).
  const [agoraMs] = useState(() => Date.now());

  // ---- The actions (PR 7). Every route below is `integracao.write`. --------
  const { allowed: podeEscrever, loading: escritaCarregando } = usePermission(
    PERM.integracao.write,
  );
  const client = useShopeeClient();
  const queryClient = useQueryClient();
  // R2: the write in flight, each link's last outcome and the pause being
  // confirmed — all here, never inside a block.
  const [emVoo, setEmVoo] = useState<AcoesShopee['emVoo']>(null);
  const [desfechos, setDesfechos] = useState<ReadonlyMap<string, DesfechoAcaoShopee>>(
    () => new Map(),
  );
  const [alvoDaPausa, setAlvoDaPausa] = useState<AlvoDaPausa | null>(null);
  /**
   * THE single-flight lock: set synchronously before the first `await`, so a
   * second click that lands before React re-renders (both handlers reading the
   * same stale `emVoo`) finds it held. `emVoo` only paints the buttons.
   */
  const travaRef = useRef(false);

  const registrarDesfecho = useCallback((linkDocId: string, d: DesfechoAcaoShopee | null) => {
    setDesfechos((prev) => {
      const next = new Map(prev);
      if (d === null) next.delete(linkDocId);
      else next.set(linkDocId, d);
      return next;
    });
  }, []);

  /**
   * Run ONE write on ONE link: take the lock (a write already in flight from
   * this tab makes this a no-op), clear the link's last outcome, record what
   * came back. A failure is narrowed by the client's two classes and becomes
   * the link's outcome — a refused kit create remembering its `pedido`; so does
   * a `FirebaseError` (below); anything else is not ours and rethrows (root
   * rule 6).
   */
  async function executar(
    linkDocId: string,
    acao: AcaoDoAnuncioShopee,
    tarefa: (c: ShopeeClient) => Promise<DesfechoAcaoShopee | null>,
    pedido?: PublicarShopeeInput,
  ) {
    if (client === null || travaRef.current) return;
    travaRef.current = true;
    setEmVoo({ linkDocId, acao });
    registrarDesfecho(linkDocId, null);
    try {
      registrarDesfecho(linkDocId, await tarefa(client));
    } catch (err) {
      if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
        registrarDesfecho(linkDocId, desfechoDaFalha(err, pedido));
        return;
      }
      // ⚠️ A failed ID-token refresh: `getAuthToken()` is awaited OUTSIDE the
      // client's try (`client.ts`), so it is none of the client's classes, and
      // rethrown from these `void`-ed handlers it would end a confirmed pause in
      // silence. Nothing was sent, so it is a definite answer — never uncertain.
      if (err instanceof FirebaseError) {
        registrarDesfecho(linkDocId, { tipo: 'falha', mensagem: err.message });
        return;
      }
      throw err;
    } finally {
      travaRef.current = false;
      setEmVoo(null);
    }
  }

  /**
   * Re-read what a publish can change: each listing's models (the prefix of
   * every key) and the produto editor's live-native-kit notice.
   */
  function invalidarModelos() {
    void queryClient.invalidateQueries({ queryKey: ['shopee-modelos', produtoId] });
    void queryClient.invalidateQueries({ queryKey: ['shopee-kit-nativo'] });
  }

  /**
   * Pause or reactivate ONE listing — the link is NAMED, so a produto holding
   * several listings on the conta moves only this one. 200 even when Shopee
   * refused it: the run's own per-listing sentence becomes the outcome.
   */
  function definirStatus(contaId: string, linkDocId: string, acao: AcaoStatusAnuncio) {
    void executar(linkDocId, acao, async (c) => ({
      tipo: 'status',
      resposta: await c.definirStatusAnuncios({
        integracaoId: contaId,
        produtoIds: [produtoId],
        acao,
        linkDocId,
      }),
    }));
  }

  /** Re-read ONE listing from Shopee. The toast says what the ERP did; the snapshot repaints the rest. */
  function reverificar(contaId: string, linkDocId: string) {
    void executar(linkDocId, 'reverificar', async (c) => {
      const resposta = await c.reverificarAnuncio({ integracaoId: contaId, produtoId, linkDocId });
      const resumo = resumoDaReverificacaoShopee(resposta);
      notifications.show({ color: resumo.cor, title: resumo.titulo, message: resumo.mensagem });
      invalidarModelos();
      return null;
    });
  }

  /**
   * Republish an EXISTING link, named — with no kit option, ever: a plain
   * republish never reaches a create arm, so the uncertain-create rules do not
   * apply to it.
   */
  function republicar(contaId: string, linkDocId: string) {
    void executar(linkDocId, 'publicar', async (c) => {
      const resposta = await c.publicar({ integracaoId: contaId, produtoId, linkDocId });
      invalidarModelos();
      return { tipo: 'publicado', resposta };
    });
  }

  // ---- The native kit (PR 8): recriar / converter, and an uncertain create. --
  // R2: which kit sections show their composition, the create being confirmed
  // and the principal picked for each link.
  const [kitAbertos, setKitAbertos] = useState<ReadonlySet<string>>(() => new Set());
  const alternarKit = useCallback((linkDocId: string) => {
    setKitAbertos((prev) => {
      const next = new Set(prev);
      if (next.has(linkDocId)) next.delete(linkDocId);
      else next.add(linkDocId);
      return next;
    });
  }, []);
  const [alvoDoKit, setAlvoDoKit] = useState<AlvoDoKitShopee | null>(null);
  const [principais, setPrincipais] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // The recipe the confirmation previews — read only while it is open.
  const receitaDoKit = useReceitaKitShopee({ db, produtoId, enabled: alvoDoKit !== null });

  /**
   * R2, by conta: the uncertain kit create THIS page recorded — `null` once it
   * was answered here. A conta this page has not touched reads the tab's store
   * instead ({@link armazenados}), which is what a reload finds.
   */
  const [incertos, setIncertos] = useState<ReadonlyMap<string, IncertoNaPagina | null>>(
    () => new Map(),
  );
  // Read on EVERY render (one `getItem` per conta), never memoised: another
  // instance of this editor in the same browser tab — the page left and
  // re-opened while a kit create was in flight — writes the same keys when ITS
  // answer lands, and this one must see that on its next render (the wait
  // timer below re-renders it, at the latest, when the stored `ate` ends).
  const armazenados = new Map(
    (contasSnap.data ?? []).map((c) => [c.id, lerIncerto(c.id, produtoId)] as const),
  );
  function incertoGuardado(contaId: string): IncertoNaPagina | null {
    if (incertos.has(contaId)) return incertos.get(contaId) ?? null;
    const lido = armazenados.get(contaId) ?? null;
    return lido === null ? null : { ...lido, fraseShopee: null };
  }

  // The clock an uncertain create's wait is read against. It ticks ONCE, when
  // the earliest pending wait ends — nothing re-renders every second.
  const [relogio, setRelogio] = useState(() => Date.now());
  const ates: number[] = [];
  for (const [contaId, lido] of armazenados) {
    if (!incertos.has(contaId) && lido !== null) ates.push(lido.ate);
  }
  for (const i of incertos.values()) if (i !== null) ates.push(i.ate);
  const pendentes = ates.filter((ate) => ate > relogio);
  const proximoFim = pendentes.length === 0 ? null : Math.min(...pendentes);
  useEffect(() => {
    if (proximoFim === null) return;
    // ⚠️ `Math.max`: the timer runs on a monotonic clock and `Date.now()` is the
    // wall clock, which can be slewed back during the wait. A tick that landed
    // BEFORE the deadline it was armed for would leave `proximoFim` unchanged —
    // and with it this effect, so nothing would ever tick again.
    const espera = setTimeout(
      () => setRelogio(Math.max(Date.now(), proximoFim)),
      Math.max(0, proximoFim - Date.now()),
    );
    return () => clearTimeout(espera);
  }, [proximoFim]);

  function marcarIncerto(contaId: string, incerto: IncertoKitShopee, fraseShopee: string | null) {
    // A store that refuses it (blocked, full) leaves the wait in memory: it still
    // holds for this page — only a reload loses it.
    gravarIncerto(contaId, produtoId, incerto);
    setIncertos((prev) => new Map(prev).set(contaId, { ...incerto, fraseShopee }));
  }
  function limparIncerto(contaId: string) {
    gravarIncerto(contaId, produtoId, null);
    setIncertos((prev) => new Map(prev).set(contaId, null));
  }

  /**
   * Send ONE native-kit create — the confirmation's and "Repetir"'s — under the
   * lock. It ends in exactly one of three ways:
   *
   *  - UNCERTAIN (the 202, or a failure `criacaoDeKitIncerta` cannot rule out):
   *    the conta waits, the body is kept for the identical re-send, and no
   *    "falhou" is ever shown — the kit may exist;
   *  - a definite refusal: the link's outcome, as any other failure (a refused
   *    create also answers an earlier uncertainty — the server read the shop);
   *  - the 200: the link's outcome, and the uncertainty is over.
   */
  function enviarKit(contaId: string, corpo: PublicarShopeeInput) {
    const arma = armaDoPedido(corpo);
    const linkDocId = corpo.linkDocId;
    if (arma === null || linkDocId === undefined) return;
    // What the conta reads NOW — what a send that never left restores.
    const anterior = incertoGuardado(contaId);
    void executar(
      linkDocId,
      arma,
      async (c) => {
        // ⚠️ WRITE AHEAD (rule 7): the provisional wait reaches the store BEFORE
        // the request leaves — the lock is a ref and dies with this instance, and
        // `publicar` takes no signal, so a reload mid-flight leaves the server
        // running. Every answer below replaces it. This page keeps reading
        // `anterior` (its own state wins over the store): its spinner, not the
        // uncertain alert, says a create is in flight.
        setIncertos((prev) => new Map(prev).set(contaId, anterior));
        gravarIncerto(contaId, produtoId, {
          ate: Date.now() + esperaDoKitIncerto(undefined),
          corpo,
        });
        let resposta: Awaited<ReturnType<ShopeeClient['publicar']>>;
        try {
          resposta = await c.publicar(corpo);
        } catch (err) {
          if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
            if (criacaoDeKitIncerta(err)) {
              marcarIncerto(
                contaId,
                { ate: Date.now() + esperaDoKitIncerto(undefined), corpo },
                null,
              );
              return null;
            }
            limparIncerto(contaId);
          } else if (err instanceof FirebaseError) {
            // A failed ID-token refresh sent NOTHING (`getAuthToken()` runs
            // before the request): the store goes back to what the conta read
            // before the click. Rethrown, it is `executar`'s definite outcome.
            gravarIncerto(
              contaId,
              produtoId,
              anterior === null ? null : { ate: anterior.ate, corpo: anterior.corpo },
            );
          }
          // Anything else is not ours (rule 6): the provisional wait stands in
          // the store — the safe direction, whatever the request did.
          throw err;
        }
        if (resposta.tipo === 'kit' && resposta.desfecho === 'incerto') {
          marcarIncerto(
            contaId,
            { ate: Date.now() + esperaDoKitIncerto(resposta.aguardarMs), corpo },
            resposta.recusa?.fraseShopee ?? null,
          );
          return null;
        }
        limparIncerto(contaId);
        invalidarModelos();
        return { tipo: 'publicado', resposta };
      },
      corpo,
    );
  }

  /** The confirmation's send: the arm's flag, the link, and the principal only when one was picked. */
  function confirmarKit() {
    if (alvoDoKit === null) return;
    const { contaId, linkDocId, arma } = alvoDoKit;
    const principal = principais.get(linkDocId) ?? null;
    setAlvoDoKit(null);
    enviarKit(contaId, {
      integracaoId: contaId,
      produtoId,
      linkDocId,
      // Exactly ONE arm flag: the route refuses both together (400).
      ...(arma === 'recriar' ? { recriar: true as const } : { converterEmKit: true as const }),
      ...(principal === null ? {} : { principal }),
    });
  }

  /** The conta's uncertain create as the buttons read it: still waiting while `relogio` is before `ate`. */
  function incertoNaTela(contaId: string): IncertoKitNaTela | null {
    const incerto = incertoGuardado(contaId);
    return incerto === null ? null : { ...incerto, pendente: incerto.ate > relogio };
  }

  /**
   * "Repetir": the stored body, VERBATIM — never rebuilt from what the tab shows
   * now — and only once the wait the button shows is over.
   */
  function repetirKit(contaId: string) {
    const incerto = incertoNaTela(contaId);
    if (incerto === null || incerto.pendente) return;
    enviarKit(contaId, incerto.corpo);
  }

  // Read in THIS render as a plain value: the handlers below hold the lock ref.
  const bloqueadas = disabled === true || client === null || emVoo !== null;

  /**
   * The loaded links whose `item_id` can address a Shopee listing — what
   * `AcoesShopee.enderecavel` answers from. The live snapshot, so a link
   * rewritten while a refusal row, a kit aviso's step, or the pause or kit
   * confirmation is on screen loses its button there too. (The one button that
   * sends a link id without asking is "Repetir" — see `IncertoDoKit`.)
   */
  const enderecaveis = useMemo(
    () =>
      new Set(
        (linksSnap.data ?? [])
          .filter((l) => itemIdDoAnuncioShopee(l.data.item_id) !== null)
          .map((l) => l.id),
      ),
    [linksSnap.data],
  );
  const acoes: AcoesShopee = {
    permitidas: !escritaCarregando && podeEscrever,
    bloqueadas,
    emVoo,
    desfechoDe: (linkDocId) => desfechos.get(linkDocId) ?? null,
    enderecavel: (linkDocId) => enderecaveis.has(linkDocId),
    pedirPausa: (contaId, linkDocId) => setAlvoDaPausa({ contaId, linkDocId }),
    reativar: (contaId, linkDocId) =>
      definirStatus(contaId, linkDocId, ACAO_STATUS_ANUNCIO.reativar),
    reverificar,
    republicar,
    abrirKit: (contaId, linkDocId, arma, focarPrincipal = false) =>
      setAlvoDoKit({ contaId, linkDocId, arma, focarPrincipal }),
    incertoDe: incertoNaTela,
    repetirKit,
    kitAberto: (linkDocId) => kitAbertos.has(linkDocId),
    alternarKit,
  };
  /** A tab built from a link's conta ref alone names no conta the operator can act on. */
  const semAcoes: AcoesShopee = { ...acoes, permitidas: false };

  /**
   * The contas, by name: the query's rows plus the ones read by id — a
   * client-side sort over ≤ `MAX_CONTAS` (+ the by-id few) rows leaves the live
   * query untouched.
   */
  const contas = useMemo<ContaShopee[]>(() => {
    const daPagina = (contasDaPagina ?? []).map((c) => contaShopeeDoDoc(c.id, c.data));
    // Only the ids still wanted: a placeholder answer may hold one no link names now.
    const lidasPorId = contaIdsFora.flatMap((id) => {
      const conta = contasFora?.get(id);
      return conta ? [conta] : [];
    });
    return [...daPagina, ...lidasPorId].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [contasDaPagina, contaIdsFora, contasFora]);

  /**
   * Every tab, with its links: the contas (in name order), then one tab per
   * conta id a link names that has no conta document — or whose by-id read is
   * still in flight — then the links whose conta ref is unreadable. Nothing a
   * snapshot holds is left without a tab.
   */
  const abas = useMemo(() => {
    const links: VinculoShopee[] = linksSnap.data ?? [];
    const saida: { conta: ContaShopee; vinculos: VinculoShopee[] }[] = contas.map((conta) => ({
      conta,
      vinculos: links.filter((l) => vinculoShopeeEhDaConta(l.data, conta.id)),
    }));
    const conhecidas = new Set(contas.map((c) => c.id));
    const orfas = new Map<string, VinculoShopee[]>();
    for (const l of links) {
      const contaId = idDoRef(l.data.contaProdutoShopeeOuterRef) ?? CHAVE_SEM_CONTA;
      if (conhecidas.has(contaId)) continue;
      const daConta = orfas.get(contaId);
      if (daConta) daConta.push(l);
      else orfas.set(contaId, [l]);
    }
    // Insertion order, except the unreadable-ref tab, which always goes last.
    const ultimaSemConta = (id: string) => (id === CHAVE_SEM_CONTA ? 1 : 0);
    const orfasOrdenadas = [...orfas].sort(([a], [b]) => ultimaSemConta(a) - ultimaSemConta(b));
    for (const [contaId, vinculos] of orfasOrdenadas) {
      const semConta = contaId === CHAVE_SEM_CONTA;
      // Its by-id read has not answered yet: never called missing before it
      // says so. Same tab id either way, so the selection survives the answer.
      const lendo = !semConta && idDeContaLegivel(contaId) && !(contasFora?.has(contaId) ?? false);
      saida.push({
        conta: {
          id: contaId,
          nome: semConta
            ? 'Sem conta legível'
            : lendo
              ? `Conta ${contaId} (carregando…)`
              : `Conta ${contaId} (não encontrada)`,
          shopId: null,
          ativo: false,
          encontrada: false,
          carregando: lendo,
        },
        vinculos,
      });
    }
    return saida;
  }, [contas, linksSnap.data, contasFora]);

  // ---- The listing DRAFTS (#1911 P10). Every rule is `@/lib/shopee/rascunho`'s.
  // Authoring one needs BOTH bits (D6) — the route enforces `integracao.write`,
  // and the draft is produto content — and an editable produto form.
  const { allowed: podeEscreverProduto, loading: escritaProdutoCarregando } = usePermission(
    PERM.produto.write,
  );
  const podeEditarRascunhos =
    !escritaCarregando &&
    podeEscrever &&
    !escritaProdutoCarregando &&
    podeEscreverProduto &&
    disabled !== true;
  /** A write of this tab is in flight, or there is no client to send one with. */
  const ocupado = client === null || emVoo !== null;
  const kitVirtual = produto != null && ehKitVirtualEfetivo(produto);

  // The STORED produto description: the pendências read what the publish reads
  // (the documents `preparar` loads), never the produto form's unsaved text.
  // Memoised for `produtoDocRef`'s reason; a child reads nothing.
  const extraDataDocRef = useMemo(
    () =>
      ehRaiz
        ? produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID)
        : null,
    [db, produtoId, ehRaiz],
  );
  const extraDataSnap = useDocSnapshot(extraDataDocRef);
  const textosDoProduto = useMemo<TextosDoProdutoRascunhoShopee | null>(() => {
    // Either document unread ⇒ no pendência from missing knowledge. A soft-read
    // may hand over a raw document: anything but a string is "none".
    if (produtoSnap.data === undefined || extraDataSnap.data === undefined) return null;
    const nome: unknown = produtoSnap.data?.data.nome;
    const descricao: unknown = extraDataSnap.data?.data.descricao;
    return {
      nomeProduto: typeof nome === 'string' ? nome : null,
      descricaoProduto: typeof descricao === 'string' ? descricao : null,
    };
  }, [produtoSnap.data, extraDataSnap.data]);

  // R2: the drafts being edited (by link doc id), each one's last sentence,
  // and the three draft confirmations — never inside a block.
  const [edicoes, setEdicoes] = useState<ReadonlyMap<string, EdicaoRascunhoShopee>>(
    () => new Map(),
  );
  const [resultadosRascunho, setResultadosRascunho] = useState<
    ReadonlyMap<string, ResultadoDoRascunhoShopee>
  >(() => new Map());
  const [conflitoRascunho, setConflitoRascunho] = useState<ConflitoRascunhoShopeeAberto | null>(
    null,
  );
  const [segundoAnuncio, setSegundoAnuncio] = useState<PedidoDeSegundoAnuncio | null>(null);
  const [descarte, setDescarte] = useState<DescarteAberto | null>(null);
  /** The drafts whose second listing the operator confirmed: their create carries `confirmarSegundoAnuncio`. */
  const [segundosConfirmados, setSegundosConfirmados] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The clock the drafts' publish reading is taken against — re-read by the
  // timer below at the instant a reading changes (see the docblock).
  const [relogioRascunho, setRelogioRascunho] = useState(() => Date.now());

  // Reconciled DURING RENDER: an entry the snapshot overtook is read as gone
  // here, every render, so nothing stale is ever painted (no effect, no
  // flicker). A dirty one dropped this way keeps its notice until dismissed.
  const servidorConfirmado = linksSnap.fromCache === false;
  // The bounded links query is full: a just-saved draft's document may never
  // be in it, so its echo may never come — the bridge must not stay read-only.
  const linksSaturados = (vinculosLidos?.length ?? 0) >= MAX_LINKS;
  const vinculoPorId = new Map((vinculosLidos ?? []).map((l) => [l.id, l] as const));
  const efetivas = new Map<string, EdicaoRascunhoShopee>();
  const avisosSobreBloco = new Map<string, string>();
  const avisosSemBloco: (AvisoDeRascunhoShopee & { readonly contaId: string })[] = [];
  for (const [linkDocId, edicao] of edicoes) {
    const link = vinculoPorId.get(linkDocId)?.data;
    const conciliacao = conciliarEdicaoRascunhoShopee(edicao, {
      link,
      snapshot: vinculosLidos,
      servidorConfirmado,
      saturado: linksSaturados,
    });
    if (conciliacao.acao === 'manter') {
      efetivas.set(linkDocId, edicao);
    } else if (conciliacao.aviso !== null) {
      if (link === undefined) {
        avisosSemBloco.push({ contaId: edicao.contaId, linkDocId, mensagem: conciliacao.aviso });
      } else {
        avisosSobreBloco.set(linkDocId, conciliacao.aviso);
      }
    }
  }

  // Every draft block of this render: the stored drafts of each tab, then the
  // LOCAL ones (an entry `novo` whose document the snapshot does not hold).
  const contaPorId = new Map(abas.map((a) => [a.conta.id, a.conta] as const));
  const blocos = new Map<string, BlocoDoEditor>();
  const locais = new Map<string, string[]>();
  const decidirBloco = (
    linkDocId: string,
    contaId: string,
    link: Record<string, unknown> | null,
  ): BlocoDoEditor => {
    // A tab built from a link's conta ref alone names no conta to write to.
    const conta = contaPorId.get(contaId);
    const podeEditar = podeEditarRascunhos && (conta?.encontrada ?? false);
    // …but the DISCARD route reads only the link (no conta document, no Shopee
    // call), so a draft whose conta was DELETED can still go — never left to
    // block the produto's delete forever. Not while the conta's read is in
    // flight, and never for an id no document can carry (the route would
    // refuse it, and no such conta ever existed).
    const contaApagada =
      conta !== undefined &&
      !conta.encontrada &&
      !conta.carregando &&
      contaId !== CHAVE_SEM_CONTA &&
      idDeContaLegivel(contaId);
    const permiteDescarte = podeEditarRascunhos && (podeEditar || contaApagada);
    return {
      contaId,
      link,
      podeEditar,
      permiteDescarte,
      bloco: estadoDoBlocoRascunhoShopee({
        link,
        edicao: efetivas.get(linkDocId) ?? null,
        nowMs: relogioRascunho,
        kitVirtual,
        servidorConfirmado,
        podeEditar,
        permiteDescarte,
        ocupado,
      }),
    };
  };
  for (const { conta, vinculos } of abas) {
    for (const v of vinculos) {
      if (ehRascunhoShopee(v.data)) blocos.set(v.id, decidirBloco(v.id, conta.id, v.data));
    }
  }
  for (const [linkDocId, edicao] of efetivas) {
    // A local draft just CREATED (saved, not `novo`) keeps its block — showing
    // what was saved — until the snapshot brings the stored draft in.
    if (vinculoPorId.has(linkDocId) || (!edicao.novo && edicao.salvo === null)) continue;
    blocos.set(linkDocId, decidirBloco(linkDocId, edicao.contaId, null));
    locais.set(edicao.contaId, [...(locais.get(edicao.contaId) ?? []), linkDocId]);
  }

  // Unsaved work: the page's leave-guard and each conta tab's mark.
  const sujo = algumRascunhoShopeeSujo(efetivas.values());
  const contasSujas = new Set(
    [...efetivas.values()].filter((e) => edicaoRascunhoShopeeSuja(e)).map((e) => e.contaId),
  );
  // ⚠️ NO cleanup, on purpose: `<Activity mode="hidden">` unmounts this effect
  // on every tab switch, and a cleanup reporting `false` would disarm the
  // page's guard while the typed draft is still here. A re-show re-reports.
  useEffect(() => {
    onDirtyChange?.(sujo);
  }, [sujo, onDirtyChange]);

  // ONE timer for every draft: at the earliest ABSOLUTE instant a reading
  // changes (`relogioRascunho + releituraEmMs`). `Math.max` for the kit wait's
  // reason: the wall clock may be slewed back during the wait.
  const proximaReleitura = [...blocos.values()].reduce<number | null>((menor, { bloco }) => {
    if (bloco.releituraEmMs === null) return menor;
    const quando = relogioRascunho + bloco.releituraEmMs;
    return menor === null || quando < menor ? quando : menor;
  }, null);
  useEffect(() => {
    if (proximaReleitura === null) return;
    const espera = setTimeout(
      () => setRelogioRascunho(Math.max(Date.now(), proximaReleitura)),
      Math.max(0, proximaReleitura - Date.now()),
    );
    return () => clearTimeout(espera);
  }, [proximaReleitura]);

  // The bands of the category each draft is EDITED to — only while one is set
  // (a draft with no category asks apps/shopee nothing on render), and only
  // for a conta whose document was found: apps/shopee can only answer 404 for
  // a «não encontrada» / unreadable / still-loading tab's conta.
  const pedidosDeLimites: { readonly contaId: string; readonly categoryId: number }[] = [];
  for (const { contaId, bloco } of blocos.values()) {
    if (contaPorId.get(contaId)?.encontrada !== true) continue;
    const categoryId = bloco.valores.category_id;
    // A positive id only: the picker offers leaves, and a legacy `0` asks nothing.
    if (!idDeCategoriaShopeeValido(categoryId)) continue;
    const chave = chaveDeLimites(contaId, categoryId);
    if (pedidosDeLimites.some((p) => chaveDeLimites(p.contaId, p.categoryId) === chave)) continue;
    pedidosDeLimites.push({ contaId, categoryId });
  }
  const limitesLidos = useQueries({
    queries: pedidosDeLimites.map(({ contaId, categoryId }) => ({
      queryKey: ['shopee', 'limitesDoItem', contaId, categoryId],
      queryFn:
        client === null
          ? skipToken
          : () => client.limitesDoItem({ integracaoId: contaId, categoryId }),
      staleTime: CATEGORIAS_SHOPEE_STALE_MS,
      retry: shopeeQueryRetry,
    })),
  });
  const limitesPorChave = new Map<string, RascunhoShopeeProps['limites']>(
    pedidosDeLimites.map(({ contaId, categoryId }, i) => [
      chaveDeLimites(contaId, categoryId),
      limitesLidos[i]?.data?.limites ?? null,
    ]),
  );

  function definirResultado(linkDocId: string, resultado: ResultadoDoRascunhoShopee | null) {
    setResultadosRascunho((prev) => {
      if (resultado === null && !prev.has(linkDocId)) return prev;
      const next = new Map(prev);
      if (resultado === null) next.delete(linkDocId);
      else next.set(linkDocId, resultado);
      return next;
    });
  }

  /** Forget a draft's entry — its block then renders the snapshot (or is gone with it). */
  function largarEdicao(linkDocId: string) {
    setEdicoes((prev) => {
      if (!prev.has(linkDocId)) return prev;
      const next = new Map(prev);
      next.delete(linkDocId);
      return next;
    });
    setSegundosConfirmados((prev) => {
      if (!prev.has(linkDocId)) return prev;
      const next = new Set(prev);
      next.delete(linkDocId);
      return next;
    });
  }

  /**
   * After a 2xx: the entry shows what was saved until THIS draft's echo — its
   * document in `enviadoContra` (the snapshot the request left against) is
   * what the echo must move past (`marcarRascunhoShopeeSalvo`).
   */
  function marcarSalvo(linkDocId: string, enviadoContra: unknown) {
    setEdicoes((prev) => {
      const edicao = prev.get(linkDocId);
      if (edicao === undefined) return prev;
      return new Map(prev).set(linkDocId, marcarRascunhoShopeeSalvo(edicao, enviadoContra));
    });
  }

  function fecharConflito(linkDocId: string) {
    setConflitoRascunho((aberto) => (aberto?.linkDocId === linkDocId ? null : aberto));
  }

  /**
   * A refused draft call, as `falhaDoRascunhoShopee` reads it: the conflict
   * modal, the second-listing or the three-case confirmation, a draft that is
   * no longer one (its entry dropped — the outcome lands on whatever block the
   * link still has, and a toast covers one that is gone), or the block's
   * sentence. Returns the link's outcome, for `executar` to record.
   */
  function aplicarFalhaDoRascunho(
    err: ShopeeClientHttpError | ShopeeClientNetworkError,
    operacao: OperacaoRascunhoShopee,
    alvo: { readonly contaId: string; readonly linkDocId: string },
    projecao: CamposRascunhoShopee | null,
  ): DesfechoAcaoShopee | null {
    const { contaId, linkDocId } = alvo;
    const falha = falhaDoRascunhoShopee(err, operacao);
    if (falha.tipo !== 'conflito') fecharConflito(linkDocId);
    switch (falha.tipo) {
      case 'conflito':
        if (operacao !== 'descartar') {
          setConflitoRascunho({ linkDocId, operacao, conflitos: falha.conflitos });
        }
        return null;
      case 'segundo-anuncio':
        setSegundoAnuncio({
          contaId,
          existentes: existentesDosVinculosShopee(falha.vinculos),
          reenviar: linkDocId,
        });
        return null;
      case 'criacao-incerta':
        setDescarte({ contaId, linkDocId, tipo: 'atestar', projecao });
        return null;
      case 'largar':
        largarEdicao(linkDocId);
        notifications.show({ color: 'orange', message: falha.mensagem });
        return { tipo: 'falha', mensagem: falha.mensagem };
      case 'mensagem':
        definirResultado(linkDocId, { mensagem: falha.mensagem, incerto: falha.incerto });
        return null;
    }
  }

  /**
   * A failed ID-token refresh on a draft call: `getAuthToken()` runs before the
   * request leaves, so NOTHING was sent — a definite sentence on the block,
   * in pt-BR ({@link fraseDaSessaoShopee}): never the SDK's raw English
   * `FirebaseError.message`.
   */
  function falhaDeSessao(linkDocId: string, err: FirebaseError): null {
    fecharConflito(linkDocId);
    definirResultado(linkDocId, { mensagem: fraseDaSessaoShopee(err), incerto: false });
    return null;
  }

  /**
   * «Salvar rascunho» of ONE entry, under the one-write lock: the create of a
   * `novo` entry, else the edit — each body built by `@/lib/shopee/rascunho`
   * from the entry as it is NOW, against the block's publish reading `estado`.
   * Returns whether there was a body to send.
   */
  function enviarSalvar(
    edicao: EdicaoRascunhoShopee,
    contaId: string,
    estado: EstadoPublicacaoRascunhoShopee,
    confirmarSegundoAnuncio: boolean,
  ): boolean {
    const { linkDocId } = edicao;
    // The snapshot current as the request LEAVES: THIS draft's document there
    // is what its echo moves past (never just any newer snapshot — another
    // link's write is no echo), which then repaints the block.
    const enviadoContra = vinculosLidos;
    const docListado = vinculoPorId.has(linkDocId);

    if (edicao.novo) {
      const corpo = corpoCriarRascunhoShopee(edicao, estado, {
        produtoId,
        confirmarSegundoAnuncio,
      });
      if (corpo === null) return false;
      void executar(linkDocId, 'salvar-rascunho', async (c) => {
        definirResultado(linkDocId, null);
        try {
          const resposta = await c.criarRascunho(corpo);
          fecharConflito(linkDocId);
          // 200 `criado: false`: the same draft was already stored. If the
          // snapshot already held it, no echo will come — show it as stored.
          if (!resposta.criado && docListado) largarEdicao(linkDocId);
          else marcarSalvo(linkDocId, enviadoContra);
          notifications.show({ color: 'green', message: FRASE_RASCUNHO_CRIADO_SHOPEE });
          return null;
        } catch (err) {
          if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
            return aplicarFalhaDoRascunho(err, 'criar', { contaId, linkDocId }, null);
          }
          if (err instanceof FirebaseError) return falhaDeSessao(linkDocId, err);
          throw err;
        }
      });
      return true;
    }

    const corpo = corpoAtualizarRascunhoShopee(edicao, estado, { produtoId });
    if (corpo === null) return false;
    void executar(linkDocId, 'salvar-rascunho', async (c) => {
      definirResultado(linkDocId, null);
      try {
        const resposta = await c.atualizarRascunho(corpo);
        fecharConflito(linkDocId);
        // `gravados: []`: the stored draft already held every value — nothing
        // was written, so no echo will come.
        if (resposta.gravados.length === 0) {
          largarEdicao(linkDocId);
          notifications.show({ color: 'blue', message: FRASE_RASCUNHO_SEM_MUDANCA_SHOPEE });
        } else {
          marcarSalvo(linkDocId, enviadoContra);
          notifications.show({ color: 'green', message: FRASE_RASCUNHO_SALVO_SHOPEE });
        }
        return null;
      } catch (err) {
        if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
          return aplicarFalhaDoRascunho(err, 'atualizar', { contaId, linkDocId }, null);
        }
        if (err instanceof FirebaseError) return falhaDeSessao(linkDocId, err);
        throw err;
      }
    });
    return true;
  }

  /**
   * The gates of a save that a MODAL re-sends (the second-listing confirmation,
   * «Salvar mesmo assim») and `salvarDoBloco` reads through `podeSalvar`: the
   * operator may author it now, and the produto is no virtual kit (the route
   * refuses one). Not `podeSalvar` itself: its plan was computed before the
   * modal's rebase or flag; the body builders re-plan.
   */
  function podeReenviarRascunho(entrada: BlocoDoEditor): boolean {
    return entrada.podeEditar && !entrada.bloco.kitVirtual;
  }

  /** «Salvar rascunho» on a block — only what its decision allows. */
  function salvarDoBloco(linkDocId: string) {
    const entrada = blocos.get(linkDocId);
    const edicao = efetivas.get(linkDocId);
    if (entrada === undefined || edicao === undefined || !entrada.bloco.podeSalvar) return;
    enviarSalvar(
      edicao,
      entrada.contaId,
      entrada.bloco.publicacao,
      segundosConfirmados.has(linkDocId),
    );
  }

  /**
   * One field typed or picked. The FIRST one of a stored draft creates its
   * entry from the snapshot — only under server truth, which the block's
   * `camposEditaveis` says (and the category only as the block accepts it:
   * any pick while `categoriaEditavel`; in `incerta`, only the held category
   * put back — `categoriaAceitaNoBlocoShopee`).
   */
  function definirCampo<C extends CampoDoFormularioRascunhoShopee>(
    linkDocId: string,
    campo: C,
    valor: FormularioRascunhoShopee[C],
  ) {
    const entrada = blocos.get(linkDocId);
    if (entrada === undefined || !entrada.bloco.camposEditaveis) return;
    if (
      campo === CAMPO_RASCUNHO_SHOPEE.categoryId &&
      !categoriaAceitaNoBlocoShopee(entrada.bloco, typeof valor === 'number' ? valor : null)
    ) {
      return;
    }
    const { contaId, link } = entrada;
    const naRender = edicoes.get(linkDocId);
    const efetiva = efetivas.get(linkDocId) ?? null;
    setEdicoes((prev) => {
      const anterior = prev.get(linkDocId);
      // Set since this render (a second call in the same tick): build on it.
      const edicao =
        anterior !== undefined && anterior !== naRender
          ? anterior
          : (efetiva ??
            (link === null ? null : edicaoDoRascunhoGuardadoShopee({ linkDocId, contaId, link })));
      if (edicao === null) return prev;
      return new Map(prev).set(linkDocId, comCampoRascunhoShopee(edicao, campo, valor));
    });
  }

  /** «Desfazer alterações»: the entry is dropped; nothing is sent. */
  function desfazerRascunho(linkDocId: string) {
    if (blocos.get(linkDocId)?.bloco.podeDesfazer !== true) return;
    largarEdicao(linkDocId);
    definirResultado(linkDocId, null);
  }

  /** «Descartar»: its confirmation, holding what the operator SAW now. */
  function pedirDescarte(linkDocId: string, tipo: DescarteDoRascunhoShopee) {
    const entrada = blocos.get(linkDocId);
    if (entrada === undefined || !entrada.bloco.podeDescartar) return;
    const { contaId, link } = entrada;
    setDescarte({
      contaId,
      linkDocId,
      tipo,
      projecao:
        tipo === 'local' || link === null
          ? null
          : projecaoGuardadaDoRascunhoShopee(efetivas.get(linkDocId) ?? null, link),
    });
  }

  /**
   * The discard confirmation as THIS render may still show it — and send it —
   * or `null` when it is no longer offered: the draft is no block here any
   * more (published, adopted or discarded elsewhere while the dialog was
   * open; a local one saved meanwhile), or a publish holds its lock
   * (`em-andamento`: every draft route answers 409, and «Nada foi publicado»
   * is no longer known). A plain confirmation whose draft turned `incerta`
   * meanwhile becomes the three-case dialog: the route would answer exactly
   * that, and the plain sentence would no longer be true. The `base` stays the
   * one the operator SAW at the click.
   */
  function descarteAindaOferecido(alvo: DescarteAberto | null): DescarteAberto | null {
    if (alvo === null) return null;
    const entrada = blocos.get(alvo.linkDocId);
    if (entrada === undefined || entrada.bloco.publicacao.tipo === 'em-andamento') return null;
    if (alvo.tipo === 'local') return entrada.bloco.descarte === 'local' ? alvo : null;
    if (entrada.bloco.descarte === 'local') return null;
    if (alvo.tipo === 'confirmar' && entrada.bloco.descarte === 'atestar') {
      return { ...alvo, tipo: 'atestar' };
    }
    return alvo;
  }

  /** The discard confirmed: a local draft is dropped here, a saved one goes to the route. */
  function confirmarDescarte(clicado: DescarteAberto, confirmarCriacaoIncerta: boolean) {
    setDescarte(null);
    // Re-read: the dialog may be one render behind the snapshot.
    const alvo = descarteAindaOferecido(clicado);
    if (alvo === null) return;
    const { contaId, linkDocId, projecao } = alvo;
    if (alvo.tipo === 'local' || projecao === null) {
      largarEdicao(linkDocId);
      definirResultado(linkDocId, null);
      return;
    }
    const corpo = corpoDescartarRascunhoShopee({
      contaId,
      linkDocId,
      produtoId,
      projecao,
      confirmarCriacaoIncerta,
    });
    void executar(linkDocId, 'descartar-rascunho', async (c) => {
      definirResultado(linkDocId, null);
      try {
        const resposta = await c.descartarRascunho(corpo);
        largarEdicao(linkDocId);
        notifications.show({
          color: 'green',
          message: resposta.criacaoIncerta
            ? FRASE_RASCUNHO_DESCARTADO_INCERTO_SHOPEE
            : FRASE_RASCUNHO_DESCARTADO_SHOPEE,
        });
        return null;
      } catch (err) {
        if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
          return aplicarFalhaDoRascunho(err, 'descartar', { contaId, linkDocId }, projecao);
        }
        if (err instanceof FirebaseError) return falhaDeSessao(linkDocId, err);
        throw err;
      }
    });
  }

  /** «Novo anúncio» is offered on this conta (see `RascunhosShopee.podeCriar`). */
  const podeCriarRascunho = (conta: ContaShopee | undefined): boolean =>
    podeEditarRascunhos && conta?.encontrada === true && !kitVirtual;

  /** A LOCAL draft: ONE id per click, reused by every retry of its create. Nothing is sent. */
  function abrirRascunhoLocal(contaId: string, segundoConfirmado: boolean) {
    const linkDocId = idDeNovoRascunhoShopee();
    const edicao = novaEdicaoRascunhoShopee({ linkDocId, contaId, nomeProduto: produto?.nome });
    setEdicoes((prev) => new Map(prev).set(linkDocId, edicao));
    if (segundoConfirmado) setSegundosConfirmados((prev) => new Set(prev).add(linkDocId));
  }

  function novoAnuncio(contaId: string) {
    if (!podeCriarRascunho(contaPorId.get(contaId))) return;
    // The set the draft route's create and the publish re-check refuse with
    // (a `removido` link is not in it), plus this screen's own local drafts.
    const existentes = segundoAnuncioNaContaShopee(vinculosLidos ?? [], contaId, efetivas.values());
    if (existentes !== null) {
      setSegundoAnuncio({ contaId, existentes, reenviar: null });
      return;
    }
    abrirRascunhoLocal(contaId, false);
  }

  /** The second listing confirmed: a new local draft, or the refused create re-sent with the flag. */
  function confirmarSegundoAnuncio() {
    if (segundoAnuncio === null) return;
    const { contaId, reenviar } = segundoAnuncio;
    setSegundoAnuncio(null);
    if (reenviar === null) {
      abrirRascunhoLocal(contaId, true);
      return;
    }
    const edicao = efetivas.get(reenviar);
    const entrada = blocos.get(reenviar);
    if (edicao === undefined || entrada === undefined || !edicao.novo) return;
    if (!podeReenviarRascunho(entrada)) return;
    setSegundosConfirmados((prev) => new Set(prev).add(reenviar));
    enviarSalvar(edicao, contaId, entrada.bloco.publicacao, true);
  }

  // The conflict modal reads the STORED draft at its id from the live snapshot
  // — both resolving buttons rebase on it, never on the 409's `conflitos`.
  const conflitoAberto =
    conflitoRascunho !== null && efetivas.has(conflitoRascunho.linkDocId) ? conflitoRascunho : null;
  const guardadoDoConflito =
    conflitoAberto === null ? undefined : vinculoPorId.get(conflitoAberto.linkDocId)?.data;
  const servidorDoConflito =
    guardadoDoConflito !== undefined && ehRascunhoShopee(guardadoDoConflito)
      ? guardadoDoConflito
      : null;

  /**
   * «Salvar mesmo assim»: re-send, rebased on the stored draft (an edit, even
   * after a create retry — rev. 2a #19) — but ONLY over what the modal showed.
   *
   * 1. The rows must still show what the re-send would overwrite
   *    (`conflitosAtualizadosDoRascunhoShopee` against the CURRENT snapshot's
   *    document). A writer that landed while the modal was open makes it
   *    answer the rows to show NOW: the modal refreshes (`renovado`) and
   *    NOTHING is sent — never an overwrite of a value nobody showed (rule 7).
   * 2. The rebase moves only the rows' fields (`listados`): an untouched field
   *    takes the stored value and never enters the patch; a changed field the
   *    rows do not name keeps the base the operator loaded, so a writer there
   *    is another 409, never a revert.
   *
   * The block's own gates are re-read too (the produto may have become a
   * virtual kit, the bits gone): this send skips `salvarDoBloco`.
   */
  function salvarMesmoAssim() {
    if (conflitoAberto === null || servidorDoConflito === null) return;
    const { linkDocId, conflitos } = conflitoAberto;
    const edicao = efetivas.get(linkDocId);
    const entrada = blocos.get(linkDocId);
    if (edicao === undefined || entrada === undefined) return;
    if (!podeReenviarRascunho(entrada)) {
      // The entry stays as typed; the block says why it cannot be saved now.
      setConflitoRascunho(null);
      return;
    }
    const atualizados = conflitosAtualizadosDoRascunhoShopee(edicao, servidorDoConflito, conflitos);
    if (atualizados !== null) {
      setConflitoRascunho({ ...conflitoAberto, conflitos: atualizados, renovado: true });
      return;
    }
    const campos = conflitos.map((c) => c.campo);
    const rebaseada = rebasearEdicaoRascunhoShopee(edicao, servidorDoConflito, [], campos);
    setEdicoes((prev) => new Map(prev).set(linkDocId, rebaseada));
    // Nothing left to send (the stored draft holds what was typed): close; the
    // clean entry is then read as gone and the block shows the stored draft.
    if (!enviarSalvar(rebaseada, entrada.contaId, entrada.bloco.publicacao, false)) {
      setConflitoRascunho(null);
    }
  }

  /**
   * «Usar o que está salvo»: the rows' fields take the stored values (base AND
   * form); an untouched field follows the stored draft too, so it never reads
   * as an edit. Nothing is sent.
   */
  function usarOQueEstaSalvo() {
    if (conflitoAberto === null || servidorDoConflito === null) return;
    const { linkDocId, conflitos } = conflitoAberto;
    const edicao = efetivas.get(linkDocId);
    setConflitoRascunho(null);
    if (edicao === undefined) return;
    const campos = conflitos.map((c) => c.campo);
    setEdicoes((prev) =>
      new Map(prev).set(
        linkDocId,
        rebasearEdicaoRascunhoShopee(edicao, servidorDoConflito, campos, campos),
      ),
    );
  }

  /** ONE draft's form: its decision, the inputs it reads and its handlers. */
  function propsDoRascunho(conta: ContaShopee, linkDocId: string): RascunhoShopeeProps | null {
    const entrada = blocos.get(linkDocId);
    if (entrada === undefined) return null;
    const { link, bloco, podeEditar, permiteDescarte } = entrada;
    const edicao = efetivas.get(linkDocId) ?? null;
    const categoryId = bloco.valores.category_id;
    return {
      db,
      // A tab whose conta document is not found (or not read yet) hands NO
      // conta: the pickers then read nothing apps/shopee could only 404.
      contaId: conta.encontrada ? conta.id : null,
      contaNome: conta.nome,
      linkDocId,
      bloco,
      // §H Q1's "stored" brand: the HELD projection's (a local draft has none).
      marcaGuardada: link === null ? null : projecaoGuardadaDoRascunhoShopee(edicao, link).marca,
      textosDoProduto,
      limites:
        categoryId === null
          ? null
          : (limitesPorChave.get(chaveDeLimites(conta.id, categoryId)) ?? null),
      divergencias:
        edicao === null || link === null ? [] : divergenciasDoServidorShopee(edicao, link),
      podeEditar,
      somenteDescartar: !podeEditar && permiteDescarte,
      emVoo:
        emVoo !== null && emVoo.linkDocId === linkDocId && ehAcaoDeRascunho(emVoo.acao)
          ? emVoo.acao
          : null,
      resultado: resultadosRascunho.get(linkDocId) ?? null,
      onCampo: <C extends CampoDoFormularioRascunhoShopee>(
        campo: C,
        valor: FormularioRascunhoShopee[C],
      ) => definirCampo(linkDocId, campo, valor),
      onSalvar: () => salvarDoBloco(linkDocId),
      onDesfazer: () => desfazerRascunho(linkDocId),
      onDescartar: (tipo) => pedirDescarte(linkDocId, tipo),
    };
  }

  const rascunhos: RascunhosShopee = {
    podeCriar: podeCriarRascunho,
    criarBloqueado: ocupado,
    novoAnuncio,
    locaisDe: (contaId) => locais.get(contaId) ?? [],
    propsDe: propsDoRascunho,
    avisoDe: (linkDocId) => avisosSobreBloco.get(linkDocId) ?? null,
    avisosSemBlocoDe: (contaId) => avisosSemBloco.filter((a) => a.contaId === contaId),
    dispensarAviso: (linkDocId) => largarEdicao(linkDocId),
  };

  // Plain, not memoised: the dirty marks change with every keystroke.
  const tabItems: ContaTabItem[] = abas.map(({ conta, vinculos }) => ({
    id: conta.id,
    label: conta.nome,
    badge: (
      <Badge color="gray" variant="light" size="sm">
        {vinculos.length === 0 ? 'Sem anúncio' : `${String(vinculos.length)} anúncio(s)`}
      </Badge>
    ),
    dirty: contasSujas.has(conta.id),
  }));

  /** The first tab holding a listing opens first — beats the first name with nothing. */
  const contaInicial = useMemo(
    () => abas.find((a) => a.vinculos.length > 0)?.conta.id ?? null,
    [abas],
  );

  if (permLoading || (produtoSnap.data === undefined && produtoSnap.error == null)) {
    return <Carregando />;
  }

  if (produtoSnap.error) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar o produto: {produtoSnap.error.message}
      </Alert>
    );
  }

  if (paiId !== null) {
    return (
      <Alert color="blue" variant="light" data-testid="shopee-variacao-filha">
        Os anúncios da Shopee ficam no produto pai.{' '}
        <Anchor component={Link} href={`/produtos/${paiId}/editar`} size="sm">
          Abrir o produto pai
        </Anchor>
      </Alert>
    );
  }

  if (!canRead) {
    return (
      <Text size="sm" c="dimmed">
        Requer permissão de leitura em integrações para ver os anúncios da Shopee.
      </Text>
    );
  }

  const erro = contasSnap.error ?? linksSnap.error ?? contasForaQuery.error;
  if (erro) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar os anúncios da Shopee: {erro.message}
      </Alert>
    );
  }

  // R1: `data === undefined` — a re-listen after a hidden spell keeps `data`.
  // ⚠️ The by-id lookup gates NOTHING: its key changes whenever a link names a
  // new off-page conta, and a spinner there would unmount `ContaTabs` (losing
  // the selected conta) on a data change. Its pending ids read "carregando…".
  if (contasSnap.data === undefined || linksSnap.data === undefined) return <Carregando />;

  if (abas.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nenhuma conta Shopee cadastrada.{' '}
        <Anchor component={Link} href="/canais/shopee" size="sm">
          Cadastrar em Canais de venda
        </Anchor>
        .
      </Text>
    );
  }

  const contasPorId = new Map(abas.map((a) => [a.conta.id, a]));
  // The discard confirmation is painted only while this render still offers
  // it (`descarteAindaOferecido`): one that is no longer offered CLOSES —
  // never a dead button under a sentence that stopped being true. The block
  // itself then says why (published, or the publish notice). Closed for good:
  // a lock released later never re-opens it on its own.
  const descarteNaTela = descarteAindaOferecido(descarte);
  if (descarte !== null && descarteNaTela === null) setDescarte(null);
  // A saved draft's discard is a write: held by the lock.
  const descarteBloqueado =
    descarteNaTela !== null && descarteNaTela.tipo !== 'local' && bloqueadas;

  return (
    <Stack gap="sm">
      {linksSnap.data.length >= MAX_LINKS && (
        <Alert color="yellow" variant="light" data-testid="shopee-limite-anuncios">
          Este produto tem {MAX_LINKS} anúncios da Shopee ou mais. A lista abaixo está truncada —
          nem todos aparecem.
        </Alert>
      )}
      <ContaTabs
        items={tabItems}
        defaultId={contaInicial}
        testIdPrefix="shopee"
        renderPanel={(contaId) => {
          const aba = contasPorId.get(contaId);
          if (!aba) return null;
          return (
            <ContaShopeePanel
              db={db}
              produtoId={produtoId}
              conta={aba.conta}
              vinculos={aba.vinculos}
              contaDoAnuncioLegivel={aba.conta.id !== CHAVE_SEM_CONTA}
              tabelaMedidas={tabelaMedidas}
              agoraMs={agoraMs}
              modelosAbertos={modelosAbertos}
              onAlternarModelos={alternarModelos}
              produtoEhKit={produto?.ehKit === true}
              acoes={aba.conta.encontrada ? acoes : semAcoes}
              rascunhos={rascunhos}
            />
          );
        }}
      />
      {/* A pause stops a live sale, so it is confirmed. It is immediate on
          confirm and never staged behind the produto's save: the write is not
          the form's — it is Shopee's, through apps/shopee. */}
      <Modal
        opened={alvoDaPausa !== null}
        onClose={() => setAlvoDaPausa(null)}
        title="Pausar anúncio"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            O anúncio deixa de vender na Shopee até ser reativado. Na Shopee o anúncio é a família
            inteira: todas as variações dele param juntas.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={() => setAlvoDaPausa(null)}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="orange"
              // The link may have been rewritten since "Pausar anúncio" opened this.
              // The plain Set, never `acoes.enderecavel`: `acoes` carries the
              // handlers that hold the lock ref, which a render must not read.
              disabled={
                bloqueadas || alvoDaPausa === null || !enderecaveis.has(alvoDaPausa.linkDocId)
              }
              onClick={() => {
                if (alvoDaPausa === null) return;
                setAlvoDaPausa(null);
                definirStatus(
                  alvoDaPausa.contaId,
                  alvoDaPausa.linkDocId,
                  ACAO_STATUS_ANUNCIO.pausar,
                );
              }}
            >
              Pausar
            </Button>
          </Group>
        </Stack>
      </Modal>
      {/* A kit create makes a NEW listing on Shopee, so it is confirmed — with
          the recipe it will send and the principal pick. */}
      <KitNativoShopeeModal
        alvo={alvoDoKit}
        link={
          alvoDoKit === null
            ? null
            : (linksSnap.data.find((l) => l.id === alvoDoKit.linkDocId)?.data ?? null)
        }
        receita={receitaDoKit}
        principal={alvoDoKit === null ? null : (principais.get(alvoDoKit.linkDocId) ?? null)}
        onPrincipal={(principal) => {
          if (alvoDoKit === null) return;
          setPrincipais((prev) => new Map(prev).set(alvoDoKit.linkDocId, principal));
        }}
        // The link may have been rewritten since the arm opened this — the
        // plain Set again, for the pause confirmation's reason.
        bloqueado={
          bloqueadas ||
          (alvoDoKit !== null &&
            ((incertoNaTela(alvoDoKit.contaId)?.pendente ?? false) ||
              !enderecaveis.has(alvoDoKit.linkDocId)))
        }
        onConfirmar={confirmarKit}
        onFechar={() => setAlvoDoKit(null)}
      />
      {/* The draft's 409 field diff — its buttons rebase on the STORED draft. */}
      <ConflitoRascunhoShopeeModal
        conflito={conflitoAberto}
        edicao={conflitoAberto === null ? null : (efetivas.get(conflitoAberto.linkDocId) ?? null)}
        servidorCarregado={servidorDoConflito !== null}
        salvando={
          conflitoAberto !== null &&
          emVoo !== null &&
          emVoo.linkDocId === conflitoAberto.linkDocId &&
          emVoo.acao === 'salvar-rascunho'
        }
        onSalvarMesmoAssim={salvarMesmoAssim}
        onUsarOQueEstaSalvo={usarOQueEstaSalvo}
        onCancelar={() => setConflitoRascunho(null)}
      />
      {/* D15: a second listing of the produto on one conta risks a duplicate
          (spam) mark, so it is confirmed — before «Novo anúncio», or after the
          create route refused it (409 `rascunhoContaJaTemAnuncio`). */}
      <Modal
        opened={segundoAnuncio !== null}
        onClose={() => setSegundoAnuncio(null)}
        title={TITULO_SEGUNDO_ANUNCIO_SHOPEE}
        centered
      >
        {segundoAnuncio !== null && (
          <Stack gap="md">
            <Text size="sm">{textoDoSegundoAnuncioShopee(segundoAnuncio.existentes)}</Text>
            <Group justify="flex-end" gap="sm">
              <Button type="button" variant="default" onClick={() => setSegundoAnuncio(null)}>
                Cancelar
              </Button>
              <Button
                type="button"
                color="orange"
                // The re-send is a write; a new local draft is not.
                disabled={segundoAnuncio.reenviar !== null && bloqueadas}
                onClick={confirmarSegundoAnuncio}
              >
                {ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
      {/* A discard deletes the draft: confirmed. `atestar` (the reading is
          `incerta`, or the route said so) is the three-case Seller-Centre
          dialog: (a) and (b) re-send the SAME discard attested, (c) is text
          only — discarding there would lose the record the import adopts. */}
      <Modal
        opened={descarteNaTela !== null}
        onClose={() => setDescarte(null)}
        title={
          descarteNaTela?.tipo === 'atestar'
            ? DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.titulo
            : 'Descartar rascunho'
        }
        centered
      >
        {descarteNaTela !== null &&
          (descarteNaTela.tipo === 'atestar' ? (
            <Stack gap="md">
              <Text size="sm">{DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.texto}</Text>
              {[
                DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.naoExiste,
                DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeVinculado,
              ].map((rotulo) => (
                <Button
                  key={rotulo}
                  type="button"
                  color="red"
                  variant="light"
                  disabled={descarteBloqueado}
                  onClick={() => confirmarDescarte(descarteNaTela, true)}
                  styles={ROTULO_EM_LINHAS}
                >
                  {rotulo}
                </Button>
              ))}
              <Alert color="blue" variant="light">
                {DIALOGO_DESCARTE_CRIACAO_INCERTA_SHOPEE.existeSemVinculo}
              </Alert>
              <Group justify="flex-end">
                <Button type="button" variant="default" onClick={() => setDescarte(null)}>
                  Cancelar
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack gap="md">
              <Text size="sm">
                {descarteNaTela.tipo === 'local'
                  ? FRASE_CONFIRMAR_DESCARTE_LOCAL_SHOPEE
                  : FRASE_CONFIRMAR_DESCARTE_SHOPEE}
              </Text>
              <Group justify="flex-end" gap="sm">
                <Button type="button" variant="default" onClick={() => setDescarte(null)}>
                  Cancelar
                </Button>
                <Button
                  type="button"
                  color="red"
                  disabled={descarteBloqueado}
                  onClick={() => confirmarDescarte(descarteNaTela, false)}
                >
                  Descartar rascunho
                </Button>
              </Group>
            </Stack>
          ))}
      </Modal>
    </Stack>
  );
}

/** A long button label wraps instead of being cut (the three-case dialog's sentences). */
const ROTULO_EM_LINHAS = {
  root: { height: 'auto', paddingBlock: 6 },
  label: { whiteSpace: 'normal', textAlign: 'left' },
} as const;

function Carregando() {
  return (
    <Group justify="center" py="md">
      <Loader size="sm" />
    </Group>
  );
}
