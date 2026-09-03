import {
  FieldPath,
  FieldValue,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

import {
  derivarFilhoUnico,
  reapontarComponentesKit,
  toOuterRef,
  type ComponentesKit,
} from '@delfrance/schemas';

import {
  isMainModule,
  MigrationArgError,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import { resumirEstoques, type EstoqueBruto, type ResumoEstoque } from './predicate';
import {
  planejarConversao,
  planejarPonteiro,
  type MotivoPular,
  type MotivoSemPonteiro,
  type PlanoDeConversao,
} from './transform';

/**
 * One-time conversion: every legacy **Produto Simples** becomes a **family of
 * one** (#1398). Idempotent, re-runnable, dry-run by default.
 * Runbook: `tools/migrations/produto-sem-variacoes.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id>
 *   pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id> --apply
 *
 * The decision is `transform.ts` — pure, unit-tested, and where every "why" is
 * written down. This file is Firestore I/O and nothing else.
 *
 * ## ⚠️ ONE ATOMIC BATCH PER PRODUTO, and it must stay that way
 *
 * A produto's writes move stock: the parent's row is decremented and the child's
 * is incremented by the same number. Split them across two commits and a crash in
 * between either destroys units or duplicates them, permanently and silently. So
 * `writer.flush()` runs after EVERY produto rather than every 400 ops — one commit
 * RPC per converted produto is the price of the unit being all-or-nothing, and for
 * a one-shot run over a bounded corpus that is not a price worth negotiating.
 *
 * ⚠️ `BatchWriter` still auto-flushes at its own cap. A produto holding more than
 * ~200 depósitos would therefore straddle a commit; no such produto exists in this
 * corpus (the census reports `nDepositos`), and if one ever did the fix is a bigger
 * per-produto batch, never a smaller unit of atomicity.
 *
 * ## ⚠️ This is a FULL `produtos` walk, twice
 *
 * Pass 1 reads every produto to learn which ids are named as a `paiId` — Firestore
 * cannot answer "has no children" as a filter, and `where('paiId','==',null)` on
 * Enterprise silently full-scans anyway (rule 1) while missing every document that
 * has no `paiId` KEY at all. Pass 2 then reads the estoques and the ML links of the
 * candidates only. Enterprise bills data scanned, which is exactly why this is a
 * one-shot manual run inside the cutover window and never anything scheduled.
 *
 * ## ⛔ Agents never run this. See root `CLAUDE.md` rule 8 / ADR 0013.
 */

const PAGE_SIZE = 300;

/** Page any collection by document id — stable cursor, bounded memory, no index. */
async function* pagesByDocId(base: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/* -------------------------------------------------------------------------- */
/*                    Pass 1 — the whole corpus, in one walk                   */
/* -------------------------------------------------------------------------- */

/** A produto carrying a kit composition — a root, a sole member, or a kit-variation child. */
interface KitDoCorpus {
  produtoId: string;
  componentesKit: Record<string, unknown> | null;
}

interface Corpus {
  /** Root produtos (no `paiId`), in key order: `[id, doc]`. */
  raizes: Array<[string, Record<string, unknown>]>;
  /**
   * `paiId` → its children's ids, from this same walk.
   *
   * ⚠️ Replaces a `Set<paiId>`, and the count is the point: "this produto is a
   * family of MANY" is unanswerable from a boolean, and phase 2 has to answer it
   * for every kit component — a script cannot pick which variation a kit means.
   */
  filhosPorPai: Map<string, string[]>;
  /** Every produto carrying a kit composition, root or variation child. */
  kits: KitDoCorpus[];
  /** Root id → its STORED `filhoUnicoId`, for the drift comparison. */
  ponteiroArmazenado: Map<string, string | null>;
}

/**
 * The fields pass 1 keeps — `paiId` plus everything `montarMembroUnico` mirrors,
 * plus the two phase 2 needs.
 *
 * ⚠️ A `.select()` projection, not a convenience. Enterprise bills DATA SCANNED,
 * and this is a full-collection walk: an unprojected `doc.data()` pulls the whole
 * produto — the `nome_embedding` vector, `fotos`, the marketplace denorms — and
 * `raizes` then RETAINS all of it for the entire duration of pass 2. That is the
 * exact shape `kitRollup.ts:246-255` calls out by name for rule 1, and the sibling
 * census already does the opposite on the same walk (it pushes a small
 * `ProdutoBruto`).
 *
 * ⚠️ The list is closed and must stay in step with `ParentParaMembroUnico`: a field
 * added there and not here is silently `undefined` in the mirror, which
 * `montarMembroUnico` turns into `null`.
 *
 * ⚠️ `filhoUnicoId` and `componentesKitKeys` are here for phase 2 — and them
 * riding this SAME projection is why the kit rewrite costs no extra reads at all.
 * A second script would have to walk `produtos` again, which on Enterprise is the
 * single most expensive thing this package can do.
 */
const CAMPOS_DO_PRODUTO = [
  'paiId',
  'filhoUnicoId',
  'nome',
  'sku',
  'codPai',
  'gtin',
  'publicado',
  'ehKit',
  'ehKitVirtual',
  'ehUsado',
  'componentesKit',
  'componentesKitKeys',
  'precos',
  'categoriaProdutoOuterRef',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
] as const;

const texto = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * ⚠️ A variation child is NOT discarded any more, and that is what fixes the
 * silent half of the kit rewrite.
 *
 * The earlier version pushed roots and threw everything else away after noting
 * its `paiId`. But a kit-variation child owns its OWN `componentesKit` (written
 * by "Gerar Variações"), and so does the sole member of a kit parent — so a walk
 * that keeps only roots rewrites the parent's map and leaves the member's naming
 * produtos with no stock. The mirror then compares the member against the
 * parent's new map, reads the mismatch as operator divergence, and freezes the
 * whole kit group for the life of the produto.
 */
async function lerCorpus(ctx: MigrationContext): Promise<Corpus> {
  const out: Corpus = {
    raizes: [],
    filhosPorPai: new Map(),
    kits: [],
    ponteiroArmazenado: new Map(),
  };
  for await (const docs of pagesByDocId(
    ctx.db.collection('produtos').select(...CAMPOS_DO_PRODUTO),
  )) {
    for (const doc of docs) {
      const data = doc.data() as Record<string, unknown>;

      // Every produto that carries a composition, whichever half of a family it is.
      const componentes = data.componentesKit;
      if (componentes != null && typeof componentes === 'object') {
        out.kits.push({
          produtoId: doc.id,
          componentesKit: componentes as Record<string, unknown>,
        });
      }

      const paiId = texto(data.paiId);
      if (paiId !== null) {
        out.filhosPorPai.set(paiId, [...(out.filhosPorPai.get(paiId) ?? []), doc.id]);
        continue;
      }
      out.ponteiroArmazenado.set(doc.id, texto(data.filhoUnicoId));
      out.raizes.push([doc.id, data]);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                     Pass 2 — the per-candidate reads                       */
/* -------------------------------------------------------------------------- */

async function lerEstoques(ctx: MigrationContext, produtoId: string): Promise<ResumoEstoque> {
  const snap = await ctx.db.collection(`produtos/${produtoId}/estoques`).get();
  const brutos: EstoqueBruto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      docId: d.id,
      depositoOuterRef: data.depositoOuterRef,
      quantidade: data.quantidade,
      quantidadeReservada: data.quantidadeReservada,
    };
  });
  return resumirEstoques(produtoId, brutos);
}

/**
 * Which children does this produto have RIGHT NOW? (Capped — see below.)
 *
 * ⚠️ Pass 1's `filhosPorPai` is a snapshot taken before pass 2 started, and pass 2
 * is minutes long. A variation created in that window makes the snapshot say "no
 * children" for a produto that has one — so the script would mint a SECOND member
 * and stamp `filhoUnicoId` on a family of two, which is the stale-pointer harm the
 * whole design is built to avoid (every stock reader would then resolve the parent
 * to one arbitrary child).
 *
 * It self-heals on the produto's next save — `VariationManager` re-derives the
 * pointer from the live child set — but "self-heals eventually" is not a property
 * to rely on for a run whose whole point is to leave the corpus correct.
 *
 * So pass 1 stays the CHEAP pre-filter and this is the fresh re-check. Rides the
 * existing `produtos(paiId ASC, nome ASC)` index on its prefix.
 *
 * ⚠️ `limite` is 1 for the conversion (the answer is boolean — "any child at all")
 * and 2 for the pointer stamp, where the question is the narrower "EXACTLY one".
 * Never more: `derivarFilhoUnico` only ever distinguishes one from not-one, so a
 * third document would be read and discarded on every family in the corpus.
 *
 * ⚠️ The pointer arm re-reads for the SAME reason the conversion does, and the
 * failure is worse rather than milder: a variation created between pass 1 and here
 * makes the snapshot say "one child" for a family of two, and stamping then points
 * every stock reader at one arbitrary variation — the precise drift `filhoUnicoId`
 * exists to prevent, written by the tool meant to establish it.
 *
 * ⚠️ It does NOT close the window entirely — a child created between this read and
 * the commit still slips through. Firestore has no batch precondition on a QUERY,
 * so closing it fully would mean a transaction per produto, and the run this script
 * exists for happens on a quiet database (the legacy app is off, traffic has not cut
 * over). This shrinks the window from minutes to milliseconds, which is the whole
 * difference between "a staging rehearsal will hit it" and "it will not".
 */
async function filhosAgora(
  ctx: MigrationContext,
  produtoId: string,
  limite: number,
): Promise<string[]> {
  const snap = await ctx.db
    .collection('produtos')
    .where('paiId', '==', produtoId)
    .limit(limite)
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * Does this produto sell on Mercado Livre?
 *
 * ⛔ `limit(1)` because the ANSWER is boolean and the consequence is a skip —
 * `transform.ts`'s header carries the reason a produto with a link must not be
 * converted here. Reading the whole subcollection to answer a yes/no would bill
 * every link of every candidate for nothing.
 */
async function temVinculoMercadoLivre(ctx: MigrationContext, produtoId: string): Promise<boolean> {
  const snap = await ctx.db.collection(`produtos/${produtoId}/produtoMercadoLivre`).limit(1).get();
  return !snap.empty;
}

/* -------------------------------------------------------------------------- */
/*                                 The writes                                 */
/* -------------------------------------------------------------------------- */

/**
 * Apply one conversion. Every write lands in the caller's batch; the caller
 * flushes immediately after, which is what makes the produto atomic.
 *
 * ⚠️ The child's estoque row is a MERGE-SET carrying `FieldValue.increment`, not a
 * plain set. A re-run after an *entrada* was booked on the parent has real units
 * to move onto a row that already exists, and a plain set would overwrite what is
 * there — destroying everything the first run moved. `dataCriacao` takes
 * `minimum` for the mirror-image reason: a second pass must not push the row's
 * birthday forward.
 *
 * ⚠️ The parent's row is DECREMENTED, never deleted (`FieldValue.increment(-n)`).
 * A delete cascades through `onEstoqueDeleted`, taking the row's whole
 * `historicoEstoque` ledger with it — and a migration run INSIDE the cutover
 * window does fire triggers; only the import fires none (ADR 0013).
 */
async function aplicarConversao(
  ctx: MigrationContext,
  produtoId: string,
  plano: Extract<PlanoDeConversao, { tipo: 'converter' }>,
  agora: number,
): Promise<void> {
  const { writer, db } = ctx;

  await writer.set(db.doc(`produtos/${plano.childId}`), {
    ...plano.childDoc,
    timestamp: agora,
    // ⚠️ Load-bearing: `produtoMeta.defaultQuery` sorts on `ultimaModificacao`, and
    // a document missing the sort key is invisible to `orderBy` (#159/#861). A
    // sole member nobody can list is a produto whose stock nobody can find.
    ultimaModificacao: agora,
  });

  await writer.update(db.doc(`produtos/${produtoId}`), {
    ...plano.parentPatch,
    ultimaModificacao: FieldValue.maximum(agora),
  });

  for (const mov of plano.movimentos) {
    await writer.set(
      db.doc(`produtos/${plano.childId}/estoques/${mov.docIdNoFilho}`),
      {
        parentId: plano.childId,
        depositoOuterRef: toOuterRef(`depositos/${mov.depositoId}`),
        quantidade: FieldValue.increment(mov.quantidade),
        dataCriacao: FieldValue.minimum(agora),
        ultimaModificacao: FieldValue.maximum(agora),
      },
      { merge: true },
    );
    await writer.update(db.doc(`produtos/${produtoId}/estoques/${mov.docIdNoPai}`), {
      quantidade: FieldValue.increment(-mov.quantidade),
      ultimaModificacao: FieldValue.maximum(agora),
    });
  }

  // ⛔ Per PRODUTO, not per 400 ops. See the module header.
  await writer.flush();
}

/** What the pointer stamp actually did, once the I/O is folded in. */
type ResultadoPonteiro =
  | { tipo: 'nada'; motivo: MotivoSemPonteiro }
  | { tipo: 'estampado'; filhoUnicoId: string; substituiu: string | null }
  /** Lost the precondition twice, or the produto vanished. Reported, never silent. */
  | { tipo: 'conflito' };

/**
 * Give a family that ALREADY exists the pointer nothing else will ever write.
 *
 * ## ⚠️ The parent read is paid only when a stamp is actually due
 *
 * `planejarPonteiro` decides from the fresh child query plus pass 1's stored
 * value, and the overwhelmingly common answer on a re-run is `ja-correto` — which
 * costs the `limit(2)` and nothing else. Only a produto that really needs the
 * write pays for the parent snapshot, and that set is bounded and shrinks to zero.
 *
 * ## ⚠️ A lost precondition RE-RUNS THE DERIVATION — it must not just retry the write
 *
 * Copied from `aplicarPonteiroMembroUnico` (the ML importer), including the reason
 * its comment spells out: the value comes from a `where('paiId','==',id)` QUERY,
 * and no precondition covers a query. A sibling appearing between that query and
 * this update changes the correct answer without touching the parent's version, so
 * the precondition cannot detect the staleness — and the run holding the FRESH
 * view is the one whose write fails. Re-deriving is what sees the sibling and
 * answers `muitos-filhos` instead of stamping a family of two at one variation.
 *
 * Bounded at one retry: a second concurrent writer in the same instant is not
 * worth a loop, and the pointer self-heals on the produto's next save.
 */
async function estamparPonteiro(
  ctx: MigrationContext,
  produtoId: string,
  ponteiroConhecido: string | null,
  agora: number,
  tentativas = 1,
): Promise<ResultadoPonteiro> {
  const filhos = await filhosAgora(ctx, produtoId, 2);
  const plano = planejarPonteiro({
    produtoId,
    filhoUnicoIdArmazenado: ponteiroConhecido,
    filhos: filhos.map((id) => ({ id })),
  });
  if (plano.tipo === 'nada') return plano;

  const ref = ctx.db.doc(`produtos/${produtoId}`);
  const snap = await ref.get();
  if (!snap.exists || !snap.updateTime) return { tipo: 'conflito' };
  // Re-checked against the FRESH document: a concurrent writer may have stamped
  // the same value between pass 1 and here, and that is a no-op, not a conflict.
  const armazenadoAgora = (snap.data() ?? {}).filhoUnicoId ?? null;
  if (armazenadoAgora === plano.filhoUnicoId) return { tipo: 'nada', motivo: 'ja-correto' };

  const ok = await ctx.writer.updateGuarded(
    ref,
    { filhoUnicoId: plano.filhoUnicoId, ultimaModificacao: FieldValue.maximum(agora) },
    snap.updateTime,
  );
  if (ok) {
    return { tipo: 'estampado', filhoUnicoId: plano.filhoUnicoId, substituiu: plano.substituiu };
  }
  if (tentativas > 0) {
    // ⚠️ The whole derivation, not the write. See the docblock.
    return estamparPonteiro(
      ctx,
      produtoId,
      armazenadoAgora as string | null,
      agora,
      tentativas - 1,
    );
  }
  return { tipo: 'conflito' };
}

/**
 * Repoint one kit's composition at the produtos that hold the stock.
 *
 * ⚠️ Both fields in ONE `update`, never two. `componentesKitKeys` is derived from
 * `componentesKit` and feeds an `array-contains`; a document carrying keys that
 * disagree with its map is a state `onProdutoDeleted` and the mirror both go out
 * of their way to make impossible.
 *
 * ⚠️ Ordinary batching here, unlike the conversion's one-commit-per-produto. The
 * conversion MOVES STOCK — its parent decrement and child increment must not be
 * separable — while this rewrites two fields of a single document, which one
 * `update` already makes atomic.
 */
async function reescreverKit(
  ctx: MigrationContext,
  produtoId: string,
  componentesKit: ComponentesKit | null,
  componentesKitKeys: string[] | null,
  agora: number,
): Promise<void> {
  await ctx.writer.update(ctx.db.doc(`produtos/${produtoId}`), {
    componentesKit,
    componentesKitKeys,
    ultimaModificacao: FieldValue.maximum(agora),
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Targets                                   */
/* -------------------------------------------------------------------------- */

const ALVOS = ['conversao', 'kits'] as const;
type Alvo = (typeof ALVOS)[number];

/**
 * ⚠️ An unknown `--target` THROWS, and copying the flag without this would be the
 * worst failure this package can have. `runner.ts` accepts any string, so
 * `--target kit` (singular) would select neither phase, write nothing, and exit
 * **0** reporting success — a run that looks done and did not happen.
 */
export function resolverAlvos(brutos: readonly string[]): Alvo[] {
  if (brutos.length === 0) return [...ALVOS];
  const out: Alvo[] = [];
  for (const bruto of brutos) {
    if (!(ALVOS as readonly string[]).includes(bruto)) {
      throw new MigrationArgError(
        `--target desconhecido: "${bruto}". Conhecidos: ${ALVOS.join(', ')}.`,
      );
    }
    const alvo = bruto as Alvo;
    if (!out.includes(alvo)) out.push(alvo);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                    Run                                     */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  // ONE clock for the whole run, so every document this pass writes carries the
  // same stamp and the batch is orderable against neighbouring runs. Also what
  // makes a re-run's `FieldValue.maximum` a no-op rather than a churn write.
  const agora = Date.now();
  const alvos = resolverAlvos(ctx.args.targets);
  log(`[produto-sem-variacoes] fases: ${alvos.join(', ')}; stamp ${agora}`);

  const corpus = await lerCorpus(ctx);
  log(
    `[produto-sem-variacoes] ${corpus.raizes.length} raiz(es); ` +
      `${corpus.filhosPorPai.size} já são família; ${corpus.kits.length} produto(s) com composição`,
  );

  /* ---------------------------------------------------------------------- */
  /*        The sellable unit of every produto — phase 2's whole input       */
  /* ---------------------------------------------------------------------- */

  /**
   * ⚠️ Seeded from the OBSERVED child set, never from the stored `filhoUnicoId`.
   *
   * The pointer is a denormalisation with nothing keeping it honest, and
   * `unidadeVendavel`'s own guard only covers the child direction — it cannot
   * tell "this parent names one of its three children". Baking a drifted pointer
   * into every kit map would make it permanent, so the live child set decides and
   * the disagreement is reported.
   *
   * ⚠️ Absent means "resolves to ITSELF", and that is what keeps an ML-linked
   * produto safe. A produto the conversion is about to skip as
   * `tem-vinculo-mercado-livre` is childless here, so it is never added — whereas
   * pre-seeding every childless root with the id the conversion WOULD mint would
   * repoint its kits at a document that is never created. `transform.ts`'s header
   * is explicit that breaking one of those listings costs its sales history
   * irrecoverably, and phase 2 must not be the thing that does it.
   */
  const unidades = new Map<string, string>();
  let ponteirosAusentes = 0;
  let ponteirosDivergentes = 0;
  for (const [id] of corpus.raizes) {
    const filhos = corpus.filhosPorPai.get(id) ?? [];
    const derivado = derivarFilhoUnico(filhos.map((f) => ({ id: f })));
    if (derivado !== null && derivado !== id) unidades.set(id, derivado);
    const armazenado = corpus.ponteiroArmazenado.get(id) ?? null;
    if (armazenado === derivado) continue;
    if (armazenado === null) ponteirosAusentes += 1;
    else ponteirosDivergentes += 1;
  }

  const pulados = new Map<MotivoPular, number>();
  const semPonteiro = new Map<MotivoSemPonteiro, number>();
  let convertidos = 0;
  let estampados = 0;
  let conflitosDePonteiro = 0;
  let unidadesMovidas = 0;
  let unidadesQueFicamNoPai = 0;
  let linhasSemDeposito = 0;
  // ⚠️ Units, not lines. One unresolvable row can hold any number of them, and
  // they are in neither `unidadesMovidas` nor `unidadesQueFicamNoPai`.
  let unidadesPresas = 0;

  /**
   * ⚠️ The children phase 1 mints, so phase 2 can rewrite them too.
   *
   * `montarMembroUnico` copies `componentesKit` VERBATIM, and the child is written
   * after `lerCorpus` already returned — so it is invisible to the walk. Leave it
   * out and the parent ends up naming children while its own sole member still
   * names parents; the next parent edit then compares the member against the
   * stored map, reads the mismatch as operator divergence, and freezes the four
   * kit fields for the life of the produto. Its map IS the parent's pre-rewrite
   * map, so it folds to exactly the same answer.
   */
  const kitsMintados: KitDoCorpus[] = [];

  if (alvos.includes('conversao')) {
    for (const [produtoId, produto] of corpus.raizes) {
      const temFilhos = (corpus.filhosPorPai.get(produtoId) ?? []).length > 0;

      // ⚠️ NOT a blind skip any more. Nothing else ever backfills `filhoUnicoId`
      // on a family that already exists — its four writers all fire on a WRITE and
      // `apps/functions` only reads it — so a family publish created before #1398
      // would otherwise keep a null pointer for ever, resolve to the parent whose
      // stock publish already moved, and read 0 in every kit naming it.
      if (temFilhos) {
        const resultado = await estamparPonteiro(
          ctx,
          produtoId,
          corpus.ponteiroArmazenado.get(produtoId) ?? null,
          agora,
        );
        if (resultado.tipo === 'estampado') {
          estampados += 1;
          unidades.set(produtoId, resultado.filhoUnicoId);
          ctx.sink.change(
            `produtos/${produtoId}`,
            'filhoUnicoId',
            resultado.substituiu,
            resultado.filhoUnicoId,
          );
        } else if (resultado.tipo === 'conflito') {
          conflitosDePonteiro += 1;
          ctx.sink.skip(`produtos/${produtoId}`, 'filhoUnicoId', null, 'ponteiro-conflito');
        } else {
          semPonteiro.set(resultado.motivo, (semPonteiro.get(resultado.motivo) ?? 0) + 1);
          // ⚠️ The FRESH read outranks the seed. Pass 1 ran minutes ago; if a
          // sibling has appeared since, this produto is a family of many and must
          // resolve to ITSELF — a script cannot choose which variation a kit means.
          if (resultado.motivo !== 'ja-correto') unidades.delete(produtoId);
          ctx.sink.skip(`produtos/${produtoId}`, 'filhoUnicoId', null, resultado.motivo);
        }
        continue;
      }

      const noMercadoLivre = await temVinculoMercadoLivre(ctx, produtoId);
      const estoque = await lerEstoques(ctx, produtoId);
      const plano = planejarConversao({
        produtoId,
        produto,
        // ⚠️ Re-read, not the pass-1 snapshot. See `filhosAgora`.
        temFilhos: (await filhosAgora(ctx, produtoId, 1)).length > 0,
        temVinculoMercadoLivre: noMercadoLivre,
        estoque,
      });

      if (plano.tipo === 'pular') {
        pulados.set(plano.motivo, (pulados.get(plano.motivo) ?? 0) + 1);
        ctx.sink.skip(`produtos/${produtoId}`, 'filhoUnicoId', null, plano.motivo);
        continue;
      }

      convertidos += 1;
      unidadesMovidas += plano.movimentos.reduce((acc, m) => acc + m.quantidade, 0);
      unidadesQueFicamNoPai += plano.ficaNoPai;
      linhasSemDeposito += estoque.nDepositosIrreconheciveis;
      unidadesPresas += plano.presasSemDeposito;
      unidades.set(produtoId, plano.childId);
      const mapaDoPai = produto.componentesKit;
      if (mapaDoPai != null && typeof mapaDoPai === 'object') {
        kitsMintados.push({
          produtoId: plano.childId,
          componentesKit: mapaDoPai as Record<string, unknown>,
        });
      }

      ctx.sink.change(`produtos/${produtoId}`, 'filhoUnicoId', null, plano.childId);
      for (const mov of plano.movimentos) {
        ctx.sink.change(
          `produtos/${produtoId}/estoques/${mov.docIdNoPai}`,
          'quantidade',
          `-${mov.quantidade}`,
          `produtos/${plano.childId}/estoques/${mov.docIdNoFilho}`,
        );
      }

      await aplicarConversao(ctx, produtoId, plano, agora);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*     Phase 2 — every kit map names the produto that holds the stock      */
  /* ---------------------------------------------------------------------- */

  let kitsReescritos = 0;
  let componentesFamiliaDeMuitos = 0;
  let colisoesSomadas = 0;
  let colisoesRecusadas = 0;

  if (alvos.includes('kits')) {
    const resolver = (id: string): string => unidades.get(id) ?? id;
    for (const kit of [...corpus.kits, ...kitsMintados]) {
      // A component that is a family of MANY is left alone and COUNTED. It is a
      // pre-existing hole — the picker never filtered `paiId` — and no script can
      // pick which variation a kit means.
      for (const chave of Object.keys(kit.componentesKit ?? {})) {
        if ((corpus.filhosPorPai.get(chave) ?? []).length > 1) componentesFamiliaDeMuitos += 1;
      }

      const plano = reapontarComponentesKit(kit.componentesKit as ComponentesKit | null, resolver);
      for (const colisao of plano.colisoes) {
        if (colisao.quantidadeSomada === null) {
          colisoesRecusadas += 1;
          ctx.sink.skip(
            `produtos/${kit.produtoId}`,
            'componentesKit',
            colisao.de,
            'colisao-com-limitarEstoque-divergente',
          );
        } else {
          colisoesSomadas += 1;
        }
      }
      if (!plano.mudou) continue;

      kitsReescritos += 1;
      // ⚠️ The WHOLE resulting map, not just the moved key. A summed collision is
      // the one part of this that can silently lose data, so it has to be readable
      // out of the log rather than inferred from a key list.
      ctx.sink.change(
        `produtos/${kit.produtoId}`,
        'componentesKit',
        Object.keys(kit.componentesKit ?? {}).sort(),
        plano.componentesKit,
      );
      await reescreverKit(
        ctx,
        kit.produtoId,
        plano.componentesKit,
        plano.componentesKitKeys,
        agora,
      );
    }
    await ctx.writer.flush();
  }

  /* ---------------------------------------------------------------------- */
  /*                               The report                               */
  /* ---------------------------------------------------------------------- */

  // ⚠️ Nothing here is a rounding note. Every number is either work done or work
  // LEFT — a silent cap reads as "covered everything" when it did not.
  if (alvos.includes('conversao')) {
    log(`[produto-sem-variacoes] convertidos: ${convertidos}`);
    log(`[produto-sem-variacoes] unidades movidas para o filho: ${unidadesMovidas}`);
    log(
      `[produto-sem-variacoes] unidades RESERVADAS que ficam no pai: ${unidadesQueFicamNoPai} ` +
        `— saem à mão depois que os pedidos abertos enviarem`,
    );
    log(`[produto-sem-variacoes] ponteiros filhoUnicoId estampados: ${estampados}`);
    if (conflitosDePonteiro > 0) {
      log(
        `[produto-sem-variacoes] ⚠️ ${conflitosDePonteiro} ponteiro(s) NÃO estampados — o produto ` +
          `mudou durante a escrita. Rode de novo: nada foi sobrescrito`,
      );
    }
    if (linhasSemDeposito > 0) {
      log(
        `[produto-sem-variacoes] ⚠️ ${linhasSemDeposito} linha(s) de estoque com depositoOuterRef ` +
          `irreconhecível ficaram no pai, somando ${unidadesPresas} unidade(s) — sem depósito ` +
          `não há linha canônica de destino, e essas unidades não entram em nenhum dos ` +
          `totais acima`,
      );
    }
    for (const [motivo, n] of [...pulados].sort()) {
      log(`[produto-sem-variacoes] pulados (${motivo}): ${n}`);
    }
    for (const [motivo, n] of [...semPonteiro].sort()) {
      log(`[produto-sem-variacoes] já era família, sem ponteiro novo (${motivo}): ${n}`);
    }
  }

  log(
    `[produto-sem-variacoes] ponteiros que faltavam: ${ponteirosAusentes}; ` +
      `divergentes do conjunto vivo de filhos: ${ponteirosDivergentes}`,
  );

  if (alvos.includes('kits')) {
    log(`[produto-sem-variacoes] composições reapontadas: ${kitsReescritos}`);
    log(`[produto-sem-variacoes] componentes que colidiram e foram SOMADOS: ${colisoesSomadas}`);
    if (colisoesRecusadas > 0) {
      log(
        `[produto-sem-variacoes] ⚠️ ${colisoesRecusadas} colisão(ões) RECUSADAS — os dois ` +
          `componentes discordam em limitarEstoque e não há soma correta. Ficaram como estavam; ` +
          `um humano precisa escolher`,
      );
    }
    if (componentesFamiliaDeMuitos > 0) {
      log(
        `[produto-sem-variacoes] ⚠️ ${componentesFamiliaDeMuitos} componente(s) apontam para uma ` +
          `família de VÁRIOS filhos e ficaram como estavam — nenhum script escolhe qual variação ` +
          `o kit quer`,
      );
    }
    if (!ctx.apply) {
      log(
        `[produto-sem-variacoes] ⚠️ dry-run: os filhos da fase 1 não foram criados, então os ids ` +
          `de destino acima ainda não existem no corpus. São a PREVISÃO de um --apply`,
      );
    }
  }

  // ⛔ A conversion with no kit rewrite leaves every kit naming a produto that now
  // holds no available stock — it CREATES the harm this script exists to remove,
  // from the destructive half. Exiting 0 there would report that as done.
  if (convertidos > 0 && !alvos.includes('kits')) {
    throw new Error(
      `${convertidos} produto(s) convertidos sem a fase "kits". As composições ainda apontam ` +
        `para os pais, que agora não têm estoque disponível. Rode ` +
        `\`migrate:produto-sem-variacoes --project <id> --apply --target kits\` agora.`,
    );
  }

  return {
    docsScanned: corpus.raizes.length + corpus.kits.length,
    docsChanged: convertidos + estampados + kitsReescritos,
  };
}

if (isMainModule(import.meta.url)) {
  await runMigration('produto-sem-variacoes', run);
}

export { run };
