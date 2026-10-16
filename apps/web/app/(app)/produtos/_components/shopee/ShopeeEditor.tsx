'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { FirebaseError } from 'firebase/app';
import { getDoc, type Firestore } from 'firebase/firestore';
import { keepPreviousData, skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  ACAO_STATUS_ANUNCIO,
  INTEGRACAO_TIPO,
  idDoRef,
  lerRefTabelaDeMedidas,
  naoDocId,
  vinculoShopeeEhDaConta,
  type AcaoStatusAnuncio,
  type Integracao,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoShopeeLinkCollection } from '@/lib/data/produtoShopeeLinkCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import {
  FRASE_LIMITE_NA_CRIACAO_DE_KIT,
  criacaoDeKitIncerta,
  esperaDoKitIncerto,
  formatarInstanteShopee,
  gravarIncerto,
  itemIdDoAnuncioShopee,
  lerIncerto,
  limiteNaCriacaoDeKit,
  resumoDaReverificacaoShopee,
  type IncertoKitShopee,
} from '@/lib/shopee/anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  useShopeeClient,
  type PublicarShopeeInput,
  type ShopeeClient,
} from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee } from '@/lib/shopee/erros';
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
  type ContaShopee,
  type TabelaMedidasDoProduto,
  type VinculoShopee,
} from './ContaShopeePanel';
import { textoPreenchido } from './campos';
import type { DesfechoAcaoShopee } from './DesfechoAcaoShopee';
import { KitNativoShopeeModal, type AlvoDoKitShopee } from './KitNativoShopeeModal';

/**
 * The produto editor's **Shopee** tab (step 21-3, #1529): one tab per Shopee
 * conta, each holding every listing that conta has on this produto — its state,
 * the refusals Shopee or the ERP stored on it, the violations, the template
 * entry the produto's tabela de medidas holds for it (never what a publish
 * sent — residual 7), the storefront link, the native kit (its badge, the ERP
 * recipe and its warnings), on demand its models, and the actions on it: pause
 * / reactivate, re-verify, republish, recriar / converter em kit nativo.
 *
 * NO CLIENT WRITE. Every listing document is written by apps/shopee — publish,
 * the import, the stock and price senders, pause/re-list, the re-verify and the
 * listing pushes — so the link docs are read LIVE: the tab repaints from the
 * same snapshot those writers land in. An action here calls the apps/shopee
 * route DIRECTLY (`useShopeeClient`), never the registry rows, which stay
 * shadowed until the step-22 flip (#1530, decision D1).
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
 * The tab is NOT in `PRODUTO_PERSISTENT_SECTIONS` (it holds no drafts and
 * registers no flush — see `ShopeeTab`), so `<Activity mode="hidden">` unmounts
 * its effects on every tab switch and re-runs them on return:
 *
 *  - **R1 — the spinner gates on `data === undefined`, never on `loading`.**
 *    `useSnapshot` keeps the last `data` while it re-listens (`loading: true`),
 *    so a re-show never unmounts `ContaTabs` — which would lose the selected
 *    conta — or the listing blocks.
 *  - **R2 — every piece of UI state lives HERE, keyed by link doc id**
 *    (`modelosAbertos`, `kitAbertos`, `desfechos`, the write in flight, the
 *    pause and the kit create being confirmed, the principal picked) or by
 *    conta (`incertos`), never inside a block: React keeps a hidden Activity's
 *    state, and one map at the top survives anything a child's remount could
 *    throw away — an in-flight handler's `setState` lands here normally.
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
  /** The produto form is read-only: every action button is disabled. */
  disabled?: boolean;
}

/** The pause being confirmed: a pause stops a live sale, so it is asked first. */
interface AlvoDaPausa {
  readonly contaId: string;
  readonly linkDocId: string;
}

/**
 * An uncertain kit create as this page holds it: the stored wait and body, plus
 * Shopee's refusal sentence when the 202 carried one (never stored — a reload
 * keeps the wait, not the sentence).
 */
type IncertoNaPagina = IncertoKitShopee & { readonly fraseShopee: string | null };

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

export function ShopeeEditor({ produtoId, db, disabled }: ShopeeEditorProps) {
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
  // open, which is the cheap direction for a notice.
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
   * rewritten while a refusal row or the pause confirmation is on screen loses
   * its button there too.
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

  const tabItems = useMemo<ContaTabItem[]>(
    () =>
      abas.map(({ conta, vinculos }) => ({
        id: conta.id,
        label: conta.nome,
        badge: (
          <Badge color="gray" variant="light" size="sm">
            {vinculos.length === 0 ? 'Sem anúncio' : `${String(vinculos.length)} anúncio(s)`}
          </Badge>
        ),
      })),
    [abas],
  );

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
        bloqueado={
          bloqueadas ||
          (alvoDoKit !== null && (incertoNaTela(alvoDoKit.contaId)?.pendente ?? false))
        }
        onConfirmar={confirmarKit}
        onFechar={() => setAlvoDoKit(null)}
      />
    </Stack>
  );
}

function Carregando() {
  return (
    <Group justify="center" py="md">
      <Loader size="sm" />
    </Group>
  );
}
