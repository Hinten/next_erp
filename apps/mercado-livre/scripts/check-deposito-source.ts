/**
 * #802 — pre-flip verification of the Mercado Livre stock DEPÓSITO SOURCE.
 *
 * The legacy Flutter periodic sender read stock from ONE hardcoded depósito for
 * every conta and every channel (`canal_de_vendas/lib/functions.dart:61-65`,
 * `getEstoquesBigQuery(depositoUid: 'ME7jOOTexx3OYLPgMtTR', …)`). This port reads
 * `integracao.depositoOuterRef` PER CONTA — the decision recorded in
 * `functions/DEPLOY.md`. So the moment `MERCADO_LIVRE_STOCK_SYNC_ENABLED` flips,
 * every conta whose depósito is not the legacy one publishes DIFFERENT
 * quantities, and ML keeps them: there is no rollback.
 *
 * This script answers, before the flip, the three things #802 asks:
 *   1. what depósito does each active ML conta actually point at,
 *   2. is any of them broken in a way that would publish garbage, and
 *   3. how big is the quantity change going to be.
 *
 *   # the enumeration + health check (cheap; always run this)
 *   pnpm --filter @delfrance/mercado-livre-app check:deposito-source --project <id>
 *   # ...plus a sampled estimate of the quantity delta at the flip
 *   pnpm --filter @delfrance/mercado-livre-app check:deposito-source --project <id> --delta
 *
 * It NEVER writes. `--project` is REQUIRED and never inferred — the same
 * discipline as `tools/migrations` and `backfill-int-frete.ts` — so a stray
 * `FIREBASE_PROJECT_ID` can't point it at production by accident.
 *
 * ⚠️ **Cost.** Firestore Enterprise bills DATA SCANNED, so a verification script
 * must not be a full scan. Phase 1 rides the same `integracao(tipo, ativo)` index
 * the sweep's own enumeration uses. Phase 2 never queries estoques at all: the
 * estoque doc id is deterministic (`makeEstoqueUid` = `est-<produtoId>-<depositoId>`,
 * the id scheme Flutter writes too), so both sides of the comparison are fetched
 * with a field-masked `getAll` — a pure KEY read, no index and nothing scanned.
 * Only the anchor sample is a query, and it is `limit`-bounded and served by the
 * declared `produtos(paiId, publicado, integracoesComProduto, __name__)` index.
 */
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  INTEGRACAO_TIPO,
  depositoMeta,
  estoqueDisponivel,
  idFromRef,
  makeEstoqueUid,
  parseRef,
} from '@delfrance/schemas';
import {
  depositoCollection,
  estoqueCollection,
  integracaoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';

import { getAdminFirestore } from '../lib/firebase/admin';

/**
 * The depósito the legacy sender hardcoded. It is a comparison BASELINE, never a
 * fallback — nothing in the port reads it, and this script is the only place in
 * the repo the constant survives at all.
 */
const LEGACY_DEPOSITO_ID = 'ME7jOOTexx3OYLPgMtTR';

/** Anchors sampled per conta for the `--delta` estimate. */
const DEFAULT_SAMPLE = 50;

/** `getAll` refs per batch — the delta pass fetches two per sampled anchor. */
const GETALL_CHUNK = 100;

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI progress output
  console.log(message);
}

class CheckArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckArgError';
  }
}

interface Args {
  projectId: string;
  legacyDepositoId: string;
  delta: boolean;
  sample: number;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let legacyDepositoId = LEGACY_DEPOSITO_ID;
  let delta = false;
  let sample = DEFAULT_SAMPLE;

  function valueOf(arg: string, inline: string | undefined, next: string | undefined): string {
    if (inline !== undefined) return inline;
    if (next === undefined || next.startsWith('--')) {
      throw new CheckArgError(`${arg} requires a value.`);
    }
    return next;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === '--delta') {
      delta = true;
    } else if (name === '--project') {
      projectId = valueOf(name, inline, argv[i + 1]);
      if (inline === undefined) i += 1;
    } else if (name === '--legacy-deposito') {
      legacyDepositoId = valueOf(name, inline, argv[i + 1]);
      if (inline === undefined) i += 1;
    } else if (name === '--sample') {
      const raw = valueOf(name, inline, argv[i + 1]);
      if (inline === undefined) i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new CheckArgError(`--sample must be a positive integer (got "${raw}").`);
      }
      sample = parsed;
    } else {
      throw new CheckArgError(`Unknown argument: ${arg}`);
    }
  }

  if (!projectId || projectId.trim().length === 0) {
    throw new CheckArgError(
      '--project <id> is required. This check refuses to guess the target project.',
    );
  }
  return { projectId: projectId.trim(), legacyDepositoId: legacyDepositoId.trim(), delta, sample };
}

/* ------------------------------ phase 1: health ----------------------------- */

/**
 * Ordered by severity. The first two are *defects* — they make the flip publish
 * something nobody intended — and drive the non-zero exit. `difere` is the
 * EXPECTED state for a conta the decision applies to, not a problem.
 */
type Verdict = 'sem-deposito' | 'inexistente' | 'difere' | 'ok';

interface ContaCheck {
  integracaoId: string;
  nome: string;
  /** The stored value, verbatim — both `documents/`-prefixed and bare forms occur. */
  raw: string | null;
  depositoId: string;
  verdict: Verdict;
  /** Extra context for the operator (e.g. a ref pointing at the wrong collection). */
  detalhe: string | null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  'sem-deposito': 'SEM DEPÓSITO',
  inexistente: 'DEPÓSITO INEXISTENTE',
  difere: 'DIFERE DO LEGADO',
  ok: 'OK',
};

const VERDICT_MEANING: Record<Verdict, string> = {
  'sem-deposito':
    'o sweep PULA a conta inteira (recordContaError) — nenhum estoque é enviado ao ML',
  inexistente:
    'o filtro depositoOuterRef não casa com nada ⇒ o sweep publica QUANTIDADE 0 em todos os anúncios da conta',
  difere: 'quantidades mudam no flip — é a decisão do #802, mas não é reversível',
  ok: 'aponta para o mesmo depósito que o sender legado usava',
};

/**
 * Classify ONE conta. Mirrors the sweep's own resolution
 * (`estoqueSweep.ts` — raw field, `idFromRef`, empty ⇒ skip) and then adds the
 * one check the sweep does NOT make: that the depósito document exists.
 *
 * That gap is the reason this script exists in its current shape. `idFromRef`
 * returns the last path segment of anything, so a malformed non-empty ref
 * (`'lixo'`, a ref left pointing at a deleted depósito, a ref naming the wrong
 * collection) yields a non-empty `depositoId`, sails past the sweep's
 * `=== ''` guard, matches no estoque, and publishes 0 across the conta.
 */
async function checkConta(
  db: Firestore,
  integracaoId: string,
  data: Record<string, unknown>,
  legacyDepositoId: string,
): Promise<ContaCheck> {
  const nomeRaw = data.nome;
  const nome = typeof nomeRaw === 'string' && nomeRaw !== '' ? nomeRaw : '(sem nome)';
  const refRaw = data.depositoOuterRef;
  const raw = typeof refRaw === 'string' && refRaw !== '' ? refRaw : null;

  if (raw == null) {
    return {
      integracaoId,
      nome,
      raw: null,
      depositoId: '',
      verdict: 'sem-deposito',
      detalhe: null,
    };
  }

  const depositoId = idFromRef(raw);
  if (depositoId === '') {
    return { integracaoId, nome, raw, depositoId: '', verdict: 'sem-deposito', detalhe: null };
  }

  // A ref naming another collection still yields an id, so say so explicitly —
  // otherwise "inexistente" reads like a deleted depósito rather than a typo.
  const { collection } = parseRef(raw);
  const detalhe =
    collection !== '' && collection !== depositoMeta.collectionPath
      ? `ref aponta para a coleção "${collection}", não "${depositoMeta.collectionPath}"`
      : null;

  const snap = await depositoCollection.docRef(db, {}, depositoId).get();
  if (!snap.exists) {
    return { integracaoId, nome, raw, depositoId, verdict: 'inexistente', detalhe };
  }

  return {
    integracaoId,
    nome,
    raw,
    depositoId,
    verdict: depositoId === legacyDepositoId ? 'ok' : 'difere',
    detalhe,
  };
}

/* ------------------------------- phase 2: delta ----------------------------- */

interface DeltaResumo {
  amostrados: number;
  diferentes: number;
  /** Sampled anchors that had stock at the legacy depósito and have none at the new one. */
  zerados: number;
  medianaAbs: number;
  piorAbs: number;
  piorAnchorId: string | null;
}

/** `quantidade − max(0, quantidadeReservada)`, tolerant of a masked/absent doc. */
function disponivelDe(snap: DocumentSnapshot): number {
  if (!snap.exists) return 0;
  const data = snap.data() ?? {};
  const quantidade = typeof data.quantidade === 'number' ? data.quantidade : 0;
  // An absent reservation and a zero one are the same number here — `reservaEfetiva`
  // (inside `estoqueDisponivel`) floors at 0 either way.
  const reservada = typeof data.quantidadeReservada === 'number' ? data.quantidadeReservada : 0;
  return estoqueDisponivel({ quantidade, quantidadeReservada: reservada });
}

function mediana(valores: readonly number[]): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 1
    ? ordenados[meio]!
    : (ordenados[meio - 1]! + ordenados[meio]!) / 2;
}

/**
 * Sample this conta's linked anchors and compare `disponivel` at the conta's
 * depósito against the legacy one — the quantity change the flip will publish.
 *
 * The anchor predicate is the sweep's S1 (`paiId == null`, `publicado == true`,
 * `integracoesComProduto` array-contains the conta), so the sample is drawn from
 * exactly the population the sweep sends. It is `limit`-bounded, and the estoque
 * reads are keyed — see the cost note in the module doc.
 *
 * "No estoque doc" counts as 0 deliberately: that is what the sweep itself
 * publishes for a family with no estoque at the depósito.
 */
async function estimarDelta(
  db: Firestore,
  integracaoId: string,
  depositoId: string,
  legacyDepositoId: string,
  sample: number,
): Promise<DeltaResumo> {
  // ⚠️ No `publicado == true` (#1087) — this samples the SWEEP's anchor set and
  // the sweep no longer filters on it, so keeping the term here would estimate
  // the delta over a strictly smaller population than the one that ships. It
  // also rides the same `produtos(paiId, integracoesComProduto, …)` prefix now;
  // the four-field `publicado` composite is deleted.
  const anchors = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', null)
    .where('integracoesComProduto', 'array-contains', integracaoId)
    .limit(sample)
    .get();

  const anchorIds = anchors.docs.map((d) => d.id);
  if (anchorIds.length === 0) {
    return {
      amostrados: 0,
      diferentes: 0,
      zerados: 0,
      medianaAbs: 0,
      piorAbs: 0,
      piorAnchorId: null,
    };
  }

  const refs: DocumentReference[] = [];
  for (const produtoId of anchorIds) {
    refs.push(
      estoqueCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId)),
      estoqueCollection.docRef(db, { produtoId }, makeEstoqueUid(produtoId, legacyDepositoId)),
    );
  }

  const snaps: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += GETALL_CHUNK) {
    const chunk = refs.slice(i, i + GETALL_CHUNK);
    snaps.push(
      ...(await db.getAll(...chunk, { fieldMask: ['quantidade', 'quantidadeReservada'] })),
    );
  }

  const absDeltas: number[] = [];
  let diferentes = 0;
  let zerados = 0;
  let piorAbs = 0;
  let piorAnchorId: string | null = null;

  for (let i = 0; i < anchorIds.length; i += 1) {
    const novo = disponivelDe(snaps[i * 2]!);
    const legado = disponivelDe(snaps[i * 2 + 1]!);
    const delta = novo - legado;
    if (delta === 0) continue;

    diferentes += 1;
    if (legado > 0 && novo <= 0) zerados += 1;
    const abs = Math.abs(delta);
    absDeltas.push(abs);
    if (abs > piorAbs) {
      piorAbs = abs;
      piorAnchorId = anchorIds[i]!;
    }
  }

  return {
    amostrados: anchorIds.length,
    diferentes,
    zerados,
    medianaAbs: mediana(absDeltas),
    piorAbs,
    piorAnchorId,
  };
}

/* ---------------------------------- main ------------------------------------ */

async function main(): Promise<void> {
  const { projectId, legacyDepositoId, delta, sample } = parseArgs(process.argv.slice(2));
  // getAdminFirestore() resolves the project from env; pin it to the explicit
  // flag so the credentials and the target can't drift apart.
  process.env.FIREBASE_PROJECT_ID = projectId;
  const db = getAdminFirestore();

  log(`[check:deposito-source] project=${projectId} legado=${legacyDepositoId}`);
  log('');

  // The sweep's own enumeration (estoqueSweep.ts) — same filters, same index.
  const snap = await integracaoCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_TIPO.mercadoLivre)
    .where('ativo', '==', true)
    .get();

  if (snap.empty) {
    log('Nenhuma integração Mercado Livre ATIVA neste projeto — nada a verificar.');
    return;
  }

  const checks: ContaCheck[] = [];
  for (const doc of snap.docs) {
    checks.push(
      await checkConta(db, doc.id, doc.data() as Record<string, unknown>, legacyDepositoId),
    );
  }

  log(`${checks.length} integração(ões) Mercado Livre ativa(s):`);
  log('');
  for (const check of checks) {
    log(`  ${check.integracaoId}  ${check.nome}`);
    log(`    depositoOuterRef : ${check.raw ?? '(ausente)'}`);
    log(`    depósito         : ${check.depositoId || '(não resolvido)'}`);
    log(
      `    veredito         : ${VERDICT_LABEL[check.verdict]} — ${VERDICT_MEANING[check.verdict]}`,
    );
    if (check.detalhe) log(`    ⚠️                : ${check.detalhe}`);

    if (delta && check.verdict === 'difere') {
      const resumo = await estimarDelta(
        db,
        check.integracaoId,
        check.depositoId,
        legacyDepositoId,
        sample,
      );
      if (resumo.amostrados === 0) {
        log('    delta            : nenhum anúncio ancorado nesta conta — nada a estimar');
      } else {
        log(
          `    delta            : ${resumo.diferentes}/${resumo.amostrados} anúncios amostrados mudam ` +
            `(mediana |Δ| ${resumo.medianaAbs}, pior |Δ| ${resumo.piorAbs}` +
            `${resumo.piorAnchorId ? ` em produtos/${resumo.piorAnchorId}` : ''})`,
        );
        log(
          `                       ${resumo.zerados} passam de >0 para 0 — esses SAEM DE VENDA no ML`,
        );
      }
    }
    log('');
  }

  const contagem = new Map<Verdict, number>();
  for (const check of checks) contagem.set(check.verdict, (contagem.get(check.verdict) ?? 0) + 1);
  const resumo = (['sem-deposito', 'inexistente', 'difere', 'ok'] as const)
    .filter((v) => contagem.has(v))
    .map((v) => `${VERDICT_LABEL[v]}=${contagem.get(v)}`)
    .join(' · ');
  log(`[check:deposito-source] ${resumo}`);

  if (delta) {
    log(
      '⚠️ A estimativa é AMOSTRADA (--sample) e usa o id determinístico do estoque; ' +
        'trate-a como ordem de grandeza, não como contagem exata.',
    );
  } else {
    log('Rode de novo com --delta para estimar a mudança de quantidade antes do flip.');
  }

  const defeitos = (contagem.get('sem-deposito') ?? 0) + (contagem.get('inexistente') ?? 0);
  if (defeitos > 0) {
    log('');
    log(
      `❌ ${defeitos} conta(s) em estado que NÃO deve chegar ao flip. ` +
        'Corrija o depósito da conta em Canais de venda antes de ligar ' +
        'MERCADO_LIVRE_STOCK_SYNC_ENABLED.',
    );
    process.exitCode = 1;
  }
}

await main();
