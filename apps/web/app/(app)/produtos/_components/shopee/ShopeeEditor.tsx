'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Firestore } from 'firebase/firestore';
import { Alert, Anchor, Badge, Group, Loader, Stack, Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_TIPO, idDoRef, idFromRef, vinculoShopeeEhDaConta } from '@delfrance/schemas';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoShopeeLinkCollection } from '@/lib/data/produtoShopeeLinkCollection';
import { tabelaDeMedidasCollection } from '@/lib/data/tabelaDeMedidasCollection';
import { ContaTabs, type ContaTabItem } from '../marketplace/ContaTabs';
import {
  ContaShopeePanel,
  type ContaShopee,
  type TabelaMedidasDoProduto,
  type VinculoShopee,
} from './ContaShopeePanel';
import { textoPreenchido } from './campos';

/**
 * The produto editor's **Shopee** tab (step 21-3, #1529): one tab per Shopee
 * conta, each holding every listing that conta has on this produto — its state,
 * the refusals Shopee or the ERP stored on it, the violations, the size chart a
 * publish would send, the storefront link and, on demand, its models.
 *
 * READ-ONLY. Every listing document is written by apps/shopee — publish, the
 * import, the stock and price senders, pause/re-list, the re-verify and the
 * listing pushes — so the link docs are read LIVE: the tab repaints from the
 * same snapshot those writers land in. Nothing here writes a link, and the
 * actions on a listing (pause, re-verify, republish, the native-kit arms) call
 * the apps/shopee routes, never the registry rows, which stay shadowed until
 * the step-22 flip (#1530, decision D1).
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
 *    (`modelosAbertos` today), never inside a block: React keeps a hidden
 *    Activity's state, and one map at the top survives anything a child's
 *    remount could throw away.
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
  /** The produto form is read-only. Nothing in the tab writes yet; the actions will honour it. */
  disabled?: boolean;
}

export function ShopeeEditor({ produtoId, db }: ShopeeEditorProps) {
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
  const paiId = textoPreenchido(produto?.paiId);
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

  // The produto's tabela de medidas, read by its id the way the Mercado Livre
  // editor reads it: each listing block says which Shopee template entry it
  // holds for that listing's conta and category. Memoised for the reason
  // `produtoDocRef` is.
  const tabelaId = textoPreenchido(produto?.tabelaDeMedidasModaUid);
  const tabelaDocId = tabelaId === null ? null : textoPreenchido(idFromRef(tabelaId));
  const tabelaDocRef = useMemo(
    () =>
      ehRaiz && tabelaDocId !== null ? tabelaDeMedidasCollection.docRef(db, {}, tabelaDocId) : null,
    [db, ehRaiz, tabelaDocId],
  );
  const tabelaSnap = useDocSnapshot(tabelaDocRef);
  const tabelaMedidas = useMemo<TabelaMedidasDoProduto>(() => {
    if (tabelaDocId === null) return { estado: 'sem-tabela' };
    if (tabelaSnap.data === undefined) return { estado: 'carregando' };
    if (tabelaSnap.data === null) return { estado: 'ausente', id: tabelaDocId };
    return {
      estado: 'tabela',
      id: tabelaDocId,
      nome: tabelaSnap.data.data.nome,
      entradasShopee: tabelaSnap.data.data.tabelasMedidasShopee,
    };
  }, [tabelaDocId, tabelaSnap.data]);

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
            />
          );
        }}
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
