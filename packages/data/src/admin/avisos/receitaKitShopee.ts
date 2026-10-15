import type {
  DocumentSnapshot,
  Firestore,
  QuerySnapshot,
  Transaction,
} from 'firebase-admin/firestore';
import {
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  avisoReceitaKitShopee,
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  decidirAvisoDeReceitaKit,
  ehKitNativoAtivo,
  ehKitNativoQueAindaVende,
  ehVinculoSubstituido,
  idFromRef,
  toOuterRef,
  toOuterRefOrNull,
} from '@delfrance/schemas';
import { avisoCollection } from '../collections/avisoCollection';
import { integracaoCollection } from '../collections/integracaoCollection';
import { produtoCollection } from '../collections/produtoCollection';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '../collections/produtoShopeeLinkCollection';
import { escreverAviso, resolverAviso } from './escreverAviso';

/**
 * **The IO twin of `decidirAvisoDeReceitaKit`** (`@delfrance/schemas`), step 19
 * (#1527). It opens or resolves the ONE `shopeeKitReceitaDivergente` aviso of a
 * (Shopee conta, kit produto K) pair, and it is the ONLY writer of that aviso:
 * step 9's import, the kit arms (create, republish, recriar, converter), the
 * reverify/push path and the `apps/functions` recipe trigger all call it AFTER
 * their own fingerprint stamp, never a blind `resolverAviso`.
 *
 * ## What it decides on
 *
 * Nothing the caller hands in. It RE-READS the current state, because a caller
 * that stamped a row and then resolved from what it believed would close an edit
 * an operator saved in between (rule 7):
 *
 *  1. K's `prodshopee` links, the conta compared in memory (both stored ref
 *     encodings), kept when `ehKitNativoQueAindaVende` — an active native kit,
 *     OR a superseded one that is neither removed nor banned: the old kit of a
 *     recriar whose delete did not take still sells the OLD composition, so its
 *     rows keep the aviso open;
 *  2. K's children (`produtos where paiId == K`), whose CURRENT `componentesKit`
 *     is each child's recipe, folded by `chaveReceitaKitErp`;
 *  3. each child's `variashopee`, kept when its conta matches and its
 *     `produtoShopeeOuterRef` names one of the links of (1) — bound by the ref's
 *     document id through schemas `idFromRef`, which reads BOTH stored encodings
 *     (`documents/…` and bare). A raw `===` on the path would miss one of them.
 *     Skipped entirely when (1) kept no link: no row could bind.
 *
 * Then `decidirAvisoDeReceitaKit` answers `abrir` (any row's stamp differs from
 * its child's current fingerprint, a `null` stamp included), `resolver` (every
 * row equal) or `nada` (no such row).
 *
 * ## One read-only snapshot, then the write (R-16)
 *
 * ALL of the reads above run in ONE `db.runTransaction(fn, { readOnly: true })`
 * — a consistent snapshot. Sequential reads would let a stale `resolver` and a
 * fresh `abrir` reach the SAME clock below, and `escreverAviso` drops an equal
 * raise, so the resolve landing first would win: a FALSE RESOLVE. The aviso
 * write lands AFTER the transaction, outside it: `escreverAviso` and
 * `resolverAviso` run their own create/precondition ladders and must not be
 * re-run by an OCC retry.
 *
 * ## The clock (rule 7 tier 2, MICROSECONDS)
 *
 * `relogioEvento` = the NEWEST `updateTime`, in µs ({@link microsDeUpdateTime}),
 * over EVERY document the decision read: the children, K's links of this conta
 * and the bound rows. The links and rows are in it on purpose: a recriar, a
 * converter or a fold-equal republish writes only link and `variashopee`
 * documents, never the child produto, so a children-only clock would TIE the
 * raise it has to close — and `resolverAviso` drops an equal clock as stale. Any
 * two snapshots whose decisions differ by a WRITE differ by a document whose
 * `updateTime` is newer than everything the older one read, so the newer
 * decision always carries the strictly newer clock.
 *
 * ⚠️ **Accepted residual (R-16):** two snapshots with an EQUAL clock differ only
 * by DELETIONS, which can only turn `abrir` into `resolver`/`nada`; that resolve
 * is dropped as not newer, so the aviso stays OPEN (the safe direction) until the
 * next save, republish or reverify. For the same reason a K whose children and
 * links were all DELETED reads clock `0` and cannot close an open row.
 *
 * ## `nada`
 *
 * No still-selling native kit of K holds a row. An OPEN row is resolved
 * `sem-kit-ativo` (whatever motivo the caller passed: the kit no longer sells).
 * With no open row it still writes the resolved WATERMARK — `resolverAviso`
 * creates a resolved row on a missing key, or advances a resolved row's clock —
 * but ONLY when K holds some native-kit link of this conta (`kitNativo === true`,
 * removed or superseded included): a raise computed while the kit was live and
 * landing after this observation is then dropped as stale. A K with no native
 * link writes NOTHING, because the trigger reaches `nada` for every old-model kit
 * edit and a watermark there would be a row per edited kit. The aviso row is read
 * (in the same snapshot) only when that second test cannot already decide.
 *
 * ## The return value
 *
 * The DECISION this snapshot reached — `aberto`, `resolvido` or `nada` — not
 * whether the write landed: a write dropped as stale (a newer observation already
 * stands) still answers what this snapshot saw.
 *
 * `packages/data/src/admin/**` imports `firebase-admin` as types only
 * (`adminBundleSafety.test.ts`), so the increment sentinel arrives in `deps`.
 * Every Shopee-side caller builds `deps` through `avisos/autorizacao.ts`'s µs seam
 * (`depsDeEscrita` / `agoraUsDe`), the trigger from its own event clock — never
 * `nowMs * 1000`.
 */

/** The deps every caller supplies — the µs "now" and the increment sentinel. */
export interface ReavaliarAvisoDeReceitaKitDeps {
  readonly agoraUs: number;
  readonly increment: (by: number) => unknown;
}

type MotivoResolucaoReceitaKit =
  (typeof MOTIVO_RESOLUCAO_RECEITA_KIT)[keyof typeof MOTIVO_RESOLUCAO_RECEITA_KIT];

/**
 * µs of a Firestore `updateTime`: `seconds · 1e6 + ⌊nanoseconds / 1e3⌋`. THE one
 * conversion (S3F-07).
 *
 * ⚠️ Never `toMillis() * 1000`: it truncates to the millisecond, so two commits
 * in one millisecond read as the SAME clock, and an equal clock is dropped as
 * stale — the newer of the two observations would lose.
 *
 * Total over a real `Timestamp`; anything else (a stamp with no numeric
 * `seconds`/`nanoseconds`) THROWS rather than yielding `NaN`, because a `NaN`
 * watermark compares false against everything and would silently disable the
 * guard it feeds.
 */
export function microsDeUpdateTime(ts: {
  readonly seconds: number;
  readonly nanoseconds: number;
}): number {
  const { seconds, nanoseconds } = ts;
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds > 999_999_999
  ) {
    throw new RangeError(
      'microsDeUpdateTime: the updateTime carries no integer seconds/nanoseconds pair',
    );
  }
  const micros = seconds * 1_000_000 + Math.floor(nanoseconds / 1_000);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError('microsDeUpdateTime: the updateTime is outside the safe-integer range');
  }
  return micros;
}

/** A kit-model row bound to a still-selling native link. */
interface LinhaVinculada {
  readonly linkDocId: string;
  readonly carimbo: string | null;
}

interface FilhoLido {
  readonly produtoId: string;
  readonly chaveAtual: string;
  readonly linhas: readonly LinhaVinculada[];
}

interface LinkLido {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/** What the one read-only snapshot saw — every decision input, nothing written. */
interface Leitura {
  /** K's links of this conta that still sell (`ehKitNativoQueAindaVende`). */
  readonly vendem: readonly LinkLido[];
  /** Whether K holds ANY native-kit link of this conta (removed/superseded included). */
  readonly temVinculoNativo: boolean;
  readonly filhos: readonly FilhoLido[];
  /** µs — the newest `updateTime` over every document the decision read; `0` when none. */
  readonly relogioUs: number;
  /** `null` = not read (the decision did not need it). */
  readonly avisoAberto: boolean | null;
}

function comoRegistro(bruto: unknown): Record<string, unknown> {
  return typeof bruto === 'object' && bruto !== null ? (bruto as Record<string, unknown>) : {};
}

/** The stored `componentesKit` as the fingerprint reads it; anything not a map is `null`. */
function comoMapaDeKit(
  bruto: unknown,
): Readonly<Record<string, { readonly quantidade?: unknown }>> | null {
  return typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto)
    ? (bruto as Record<string, { readonly quantidade?: unknown }>)
    : null;
}

/** The link document id a stored `produtoShopeeOuterRef` names — both encodings — or `null`. */
function idDoLinkDaLinha(bruto: unknown): string | null {
  if (typeof bruto !== 'string' || bruto.trim() === '') return null;
  const id = idFromRef(bruto);
  return id === '' ? null : id;
}

function itemIdEnderecavel(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** Lexically first by document id — the rule `escolherLink` applies within a tier. */
function primeiroPorId(links: readonly LinkLido[]): LinkLido | null {
  let escolhido: LinkLido | null = null;
  for (const l of links) if (escolhido === null || l.id < escolhido.id) escolhido = l;
  return escolhido;
}

async function lerSnapshot(
  db: Firestore,
  tx: Transaction,
  integracaoId: string,
  kitProdutoId: string,
): Promise<Leitura> {
  const conta = toOuterRef(integracaoCollection.docPath({}, integracaoId));
  const daConta = (refBruto: unknown): boolean => toOuterRefOrNull(refBruto) === conta;
  let relogioUs = 0;
  const marcar = (snap: { readonly updateTime: { seconds: number; nanoseconds: number } }) => {
    relogioUs = Math.max(relogioUs, microsDeUpdateTime(snap.updateTime));
  };

  const [linksSnap, filhosSnap]: [QuerySnapshot, QuerySnapshot] = await Promise.all([
    tx.get(produtoShopeeLinkCollection.ref(db, { produtoId: kitProdutoId })),
    tx.get(produtoCollection.ref(db, {}).where('paiId', '==', kitProdutoId)),
  ]);

  const linksDaConta: LinkLido[] = [];
  for (const d of linksSnap.docs) {
    const raw = comoRegistro(d.data());
    if (!daConta(raw.contaProdutoShopeeOuterRef)) continue;
    marcar(d);
    linksDaConta.push({ id: d.id, raw });
  }
  const vendem = linksDaConta.filter((l) => ehKitNativoQueAindaVende(l.raw));
  const idsQueVendem = new Set(vendem.map((l) => l.id));
  const temVinculoNativo = linksDaConta.some((l) => l.raw.kitNativo === true);

  for (const d of filhosSnap.docs) marcar(d);
  const linhasPorFilho: QuerySnapshot[] =
    idsQueVendem.size === 0
      ? []
      : await Promise.all(
          filhosSnap.docs.map((f) =>
            tx.get(variacaoShopeeLinkCollection.ref(db, { produtoId: f.id })),
          ),
        );

  const filhos: FilhoLido[] = filhosSnap.docs.map((f, i) => {
    const linhas: LinhaVinculada[] = [];
    for (const d of linhasPorFilho[i]?.docs ?? []) {
      const raw = comoRegistro(d.data());
      if (!daConta(raw.contaVariacaoShopeeOuterRef)) continue;
      const linkDocId = idDoLinkDaLinha(raw.produtoShopeeOuterRef);
      if (linkDocId === null || !idsQueVendem.has(linkDocId)) continue;
      marcar(d);
      const carimbo = raw.receitaKitConferida;
      linhas.push({ linkDocId, carimbo: typeof carimbo === 'string' ? carimbo : null });
    }
    return {
      produtoId: f.id,
      chaveAtual: chaveReceitaKitErp(comoMapaDeKit(comoRegistro(f.data()).componentesKit)),
      linhas,
    };
  });

  let avisoAberto: boolean | null = null;
  const semLinhas = filhos.every((f) => f.linhas.length === 0);
  if (semLinhas && !temVinculoNativo) {
    const chave = chaveAvisoReceitaKitShopee(integracaoId, kitProdutoId);
    const avisoSnap: DocumentSnapshot = await tx.get(avisoCollection.docRef(db, {}, chave));
    avisoAberto = avisoSnap.exists && comoRegistro(avisoSnap.data()).resolvidoEm == null;
  }

  return { vendem, temVinculoNativo, filhos, relogioUs, avisoAberto };
}

/**
 * The link the aviso names on `abrir` (V2R2-02): among the still-selling links
 * holding a DIVERGENT row, a SUPERSEDED one first — the old kit is what sells the
 * old recipe, and `--link <it> --recriar` is its delete retry — then the active
 * ones (R-12(b) order), lexically first within a tier. Never the active link
 * merely for being active.
 */
function linkDoAvisoAberto(leitura: Leitura): LinkLido | null {
  const divergentes = new Set<string>();
  for (const f of leitura.filhos) {
    for (const l of f.linhas) if (l.carimbo !== f.chaveAtual) divergentes.add(l.linkDocId);
  }
  const candidatos = leitura.vendem.filter((l) => divergentes.has(l.id));
  return (
    primeiroPorId(candidatos.filter((l) => ehVinculoSubstituido(l.raw))) ??
    primeiroPorId(candidatos)
  );
}

/** The metadata of a RESOLVED row (only used when the row must be created): R-12(b) order. */
function linkDoAvisoResolvido(leitura: Leitura): LinkLido | null {
  return (
    primeiroPorId(leitura.vendem.filter((l) => ehKitNativoAtivo(l.raw))) ??
    primeiroPorId(leitura.vendem)
  );
}

/**
 * Re-read the (conta, K) state in ONE read-only snapshot, decide, and open or
 * resolve the kit-recipe aviso under the µs clock — see the module docblock.
 * `motivoSeResolver` is the caller's case (`MOTIVO_RESOLUCAO_RECEITA_KIT`); on
 * `nada` the motivo is always `sem-kit-ativo`, whatever was passed.
 */
export async function reavaliarAvisoDeReceitaKit(
  db: Firestore,
  a: { readonly integracaoId: string; readonly kitProdutoId: string },
  motivoSeResolver: MotivoResolucaoReceitaKit,
  deps: ReavaliarAvisoDeReceitaKitDeps,
): Promise<'aberto' | 'resolvido' | 'nada'> {
  const leitura = await db.runTransaction(
    (tx) => lerSnapshot(db, tx, a.integracaoId, a.kitProdutoId),
    { readOnly: true },
  );

  const decisao = decidirAvisoDeReceitaKit(
    leitura.filhos.map((f) => ({
      produtoId: f.produtoId,
      chaveAtual: f.chaveAtual,
      carimbos: f.linhas.map((l) => l.carimbo),
    })),
  );
  const relogioEvento = leitura.relogioUs;
  const chave = chaveAvisoReceitaKitShopee(a.integracaoId, a.kitProdutoId);
  const plano = (link: LinkLido | null, variacoesDivergentes: readonly string[]) =>
    avisoReceitaKitShopee({
      integracaoId: a.integracaoId,
      kitProdutoId: a.kitProdutoId,
      itemId: link === null ? null : itemIdEnderecavel(link.raw.item_id),
      linkDocId: link === null ? null : link.id,
      variacoesDivergentes,
    });

  if (decisao.acao === 'abrir') {
    await escreverAviso(
      db,
      { ...plano(linkDoAvisoAberto(leitura), decisao.divergentes), relogioEvento },
      deps,
    );
    return 'aberto';
  }

  if (decisao.acao === 'resolver') {
    await resolverAviso(db, chave, motivoSeResolver, deps, {
      ...plano(linkDoAvisoResolvido(leitura), []),
      relogioEvento,
    });
    return 'resolvido';
  }

  if (leitura.temVinculoNativo || leitura.avisoAberto === true) {
    await resolverAviso(db, chave, MOTIVO_RESOLUCAO_RECEITA_KIT.semKitAtivo, deps, {
      ...plano(null, []),
      relogioEvento,
    });
  }
  return 'nada';
}
