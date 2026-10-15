'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { PERM } from '@delfrance/auth';
import { parseIsoToMillis } from '@delfrance/core/datetime';
import {
  ACAO_STATUS_ANUNCIO,
  INTEGRACAO_TIPO,
  idDoRef,
  lerRefTabelaDeMedidas,
  vinculoShopeeEhDaConta,
  type AcaoStatusAnuncio,
} from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoShopeeLinkCollection } from '@/lib/data/produtoShopeeLinkCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { formatarInstanteShopee, resumoDaReverificacaoShopee } from '@/lib/shopee/anuncioProduto';
import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  useShopeeClient,
  type ShopeeClient,
} from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee } from '@/lib/shopee/erros';
import { ContaTabs, type ContaTabItem } from '../marketplace/ContaTabs';
import type { AcaoDoAnuncioShopee, AcoesShopee } from './AcoesAnuncioShopee';
import {
  ContaShopeePanel,
  type ContaShopee,
  type TabelaMedidasDoProduto,
  type VinculoShopee,
} from './ContaShopeePanel';
import type { DesfechoAcaoShopee } from './DesfechoAcaoShopee';

/**
 * The produto editor's **Shopee** tab (step 21-3, #1529): one tab per Shopee
 * conta, each holding every listing that conta has on this produto — its state,
 * the refusals Shopee or the ERP stored on it, the violations, the template
 * entry the produto's tabela de medidas holds for it (never what a publish
 * sent — residual 7), the storefront link, on demand its models, and the
 * actions on it: pause / reactivate, re-verify, republish.
 *
 * NO CLIENT WRITE. Every listing document is written by apps/shopee — publish,
 * the import, the stock and price senders, pause/re-list, the re-verify and the
 * listing pushes — so the link docs are read LIVE: the tab repaints from the
 * same snapshot those writers land in. An action here calls the apps/shopee
 * route DIRECTLY (`useShopeeClient`), never the registry rows, which stay
 * shadowed until the step-22 flip (#1530, decision D1). One write from this
 * tab at a time: every write button is disabled while one is in flight.
 *
 * ## Which conta a link belongs to
 *
 * `vinculoShopeeEhDaConta` (`@delfrance/schemas`), the fold the stock and price
 * planners attribute a link with — so the two stored encodings of one conta ref
 * (`documents/integracao/X`, `integracao/X`) land in the SAME tab here exactly
 * as they do there. A link whose conta the query did not return still gets a
 * tab of its own ("Conta … (não encontrada)"): an orphan is shown, never dropped.
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
 *    (`modelosAbertos`, `desfechos`, the write in flight, the pause being
 *    confirmed), never inside a block: React keeps a hidden Activity's state,
 *    and one map at the top survives anything a child's remount could throw
 *    away — an in-flight handler's `setState` lands here normally.
 */

/** How many Shopee contas the tab strip shows — the `/medidas` Shopee tab's bound. */
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

/** A link that is not (or no longer) this conta's — the 404s of publish and re-verify. */
const MENSAGEM_VINCULO_FORA_DA_CONTA =
  'Este vínculo não pertence mais a esta conta — a lista foi atualizada.';

/**
 * A failed action, worded for the operator. The publish 422s keep their rows
 * (each with its `acao`); the link-addressing codes get the tab's own sentence;
 * everything else is `descreverFalhaShopee`, the channel's one ladder.
 */
function desfechoDaFalha(
  err: ShopeeClientHttpError | ShopeeClientNetworkError,
): DesfechoAcaoShopee {
  if (err instanceof ShopeeClientHttpError) {
    const { code, detalhes } = err;
    if (
      code === CODIGO_FALHA_SHOPEE.publicacaoBloqueada ||
      code === CODIGO_FALHA_SHOPEE.publicacaoRecusada
    ) {
      return {
        tipo: 'recusado',
        antesDaShopee: code === CODIGO_FALHA_SHOPEE.publicacaoBloqueada,
        etapa: detalhes.etapa,
        problemas: detalhes.problemas ?? [],
        mensagem: err.message,
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

  const registrarDesfecho = useCallback((linkDocId: string, d: DesfechoAcaoShopee | null) => {
    setDesfechos((prev) => {
      const next = new Map(prev);
      if (d === null) next.delete(linkDocId);
      else next.set(linkDocId, d);
      return next;
    });
  }, []);

  /**
   * Run ONE write on ONE link: clear its last outcome, hold the in-flight flag
   * (every write button is disabled while it is set), record what came back.
   * A failure is narrowed by the client's two classes and becomes the link's
   * outcome; anything else is not ours and rethrows (root rule 6).
   */
  async function executar(
    linkDocId: string,
    acao: AcaoDoAnuncioShopee,
    tarefa: (c: ShopeeClient) => Promise<DesfechoAcaoShopee | null>,
  ) {
    if (client === null || emVoo !== null) return;
    setEmVoo({ linkDocId, acao });
    registrarDesfecho(linkDocId, null);
    try {
      registrarDesfecho(linkDocId, await tarefa(client));
    } catch (err) {
      if (err instanceof ShopeeClientHttpError || err instanceof ShopeeClientNetworkError) {
        registrarDesfecho(linkDocId, desfechoDaFalha(err));
        return;
      }
      throw err;
    } finally {
      setEmVoo(null);
    }
  }

  /** Each listing's models are re-read after a write that can change them (the prefix of every key). */
  function invalidarModelos() {
    void queryClient.invalidateQueries({ queryKey: ['shopee-modelos', produtoId] });
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

  const acoes: AcoesShopee = {
    permitidas: !escritaCarregando && podeEscrever,
    bloqueadas: disabled === true || client === null || emVoo !== null,
    emVoo,
    desfechoDe: (linkDocId) => desfechos.get(linkDocId) ?? null,
    pedirPausa: (contaId, linkDocId) => setAlvoDaPausa({ contaId, linkDocId }),
    reativar: (contaId, linkDocId) =>
      definirStatus(contaId, linkDocId, ACAO_STATUS_ANUNCIO.reativar),
    reverificar,
    republicar,
  };
  /** A tab built from a link's conta ref alone names no conta the operator can act on. */
  const semAcoes: AcoesShopee = { ...acoes, permitidas: false };

  /** The contas, by name — a client-side sort over ≤ `MAX_CONTAS` rows leaves the live query untouched. */
  const contas = useMemo<ContaShopee[]>(
    () =>
      [...(contasSnap.data ?? [])]
        .sort((a, b) => a.data.nome.localeCompare(b.data.nome, 'pt-BR'))
        .map((c) => ({
          id: c.id,
          nome: c.data.nome,
          shopId: c.data.shop_id,
          ativo: c.data.ativo !== false,
          encontrada: true,
        })),
    [contasSnap.data],
  );

  /**
   * Every tab, with its links: the contas the query returned (in name order),
   * then one tab per conta id a link names that the query did NOT return, then
   * the links whose conta ref is unreadable. Nothing a snapshot holds is left
   * without a tab.
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
      saida.push({
        conta: {
          id: contaId,
          nome: semConta ? 'Sem conta legível' : `Conta ${contaId} (não encontrada)`,
          shopId: null,
          ativo: false,
          encontrada: false,
        },
        vinculos,
      });
    }
    return saida;
  }, [contas, linksSnap.data]);

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

  const erro = contasSnap.error ?? linksSnap.error;
  if (erro) {
    return (
      <Alert color="red" variant="light">
        Erro ao carregar os anúncios da Shopee: {erro.message}
      </Alert>
    );
  }

  // R1: `data === undefined` — a re-listen after a hidden spell keeps `data`.
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
              disabled={acoes.bloqueadas}
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
