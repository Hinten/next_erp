import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `enviosPrecoMercadoLivre/{envioId}/relatorios/{0000|0001|…}` — the COMPLETE
 * per-item record of one "Atualizar preços" run, sharded.
 *
 * Why it exists: the job doc carries only capped SAMPLES (`skips` 200,
 * `failures` 100), records no successes beyond a counter, and stores no prices
 * at all — `enviarPrecoDraft` computes `precoAtual` on every terminal branch and
 * the job discarded it. So "download the result of the change" was unanswerable
 * from what was persisted. This is that record, and `PrecoDraftOutcome`'s own
 * docblock already anticipated it ("the caller decides how to record it — job
 * counters, or an operator-facing report row").
 *
 * ⚠️ It cannot live on the job document. `fila` alone reaches
 * `PLAN_PAGE_DRAFTS_CAP` (2000) drafts and the whole doc is re-serialised on
 * EVERY per-item checkpoint — thousands of times per run — so another array
 * there would multiply an already large write, and the 1 MiB ceiling is what the
 * existing caps exist to respect. Sharded subcollection, mirroring
 * `relatorioBalanco` (`balanco.ts`), which solved the same problem.
 *
 * ⚠️ **`linhas` is a keyed MAP, not an array, and the key is the row's IDENTITY
 * — never its outcome.** That is what makes a Cloud Tasks retry idempotent for
 * free (root `CLAUDE.md` rule 7, tier 0: make the race impossible). A retried
 * dispatch re-runs the one in-flight draft, and gate 2 turns a PUT that already
 * landed into `PRECO_ANTIGO_IGUAL`; with the outcome in the key that is a
 * DUPLICATE row carrying the replay's verdict, and with it out the replay simply
 * overwrites — which is exactly what `enviados`/`pulados` already do, so the
 * report and the counters cannot disagree. An array would be worse still:
 * `arrayUnion` dedupes by deep equality, so two rows for the same item with
 * different codes both survive.
 *
 * The message is NOT stored. Rows carry the `motivo` CODE and the reader renders
 * pt-BR through `mensagemDe` (`precoMotivos.ts`), so a wording fix applies
 * retroactively to runs already recorded — the convention `envioPrecoListingSchema`
 * already sets on the manual push's wire shape.
 *
 * Admin-only / default-deny, exactly like its parent: NOT registered in
 * `ALL_DOMAINS`, and this file deliberately exports NO `…Meta` object. Pairing a
 * schema with a meta is what `registry.test.ts`'s `isDomainSchema()` sweeps, and
 * registering it would emit a rules match block for a subcollection whose parent
 * has none — forcing `gen:rules` + `gen:rules:e2e` + two snapshot refreshes + a
 * manual rules deploy for a collection no browser can read.
 */

/** What happened to one planned send. */
export const envioPrecoResultadoSchema = z.enum(['enviado', 'pulado', 'falha', 'nao-tentado']);
export type EnvioPrecoResultado = z.infer<typeof envioPrecoResultadoSchema>;

/** Named members of {@link envioPrecoResultadoSchema}. */
export const ENVIO_PRECO_RESULTADO = {
  enviado: 'enviado',
  pulado: 'pulado',
  falha: 'falha',
  naoTentado: 'nao-tentado',
} as const satisfies Record<string, EnvioPrecoResultado>;

/**
 * Which phase produced the row. Load-bearing in the row KEY: one produto can
 * legitimately yield both a plan-time skip and a reconciliation finding, and
 * those are different facts about it.
 */
export const envioPrecoFaseSchema = z.enum(['plano', 'envio', 'reconciliacao']);
export type EnvioPrecoFase = z.infer<typeof envioPrecoFaseSchema>;

/** Named members of {@link envioPrecoFaseSchema}. */
export const ENVIO_PRECO_FASE = {
  plano: 'plano',
  envio: 'envio',
  reconciliacao: 'reconciliacao',
} as const satisfies Record<string, EnvioPrecoFase>;

/** Longest `erro` a row may carry — see {@link RELATORIO_ENVIO_PRECO_SHARD_SIZE}. */
export const RELATORIO_ENVIO_PRECO_ERRO_MAX = 300;

/**
 * One listing's outcome. Mirrors `PushPrecoListing` (the manual push's wire
 * shape) minus `mensagem` — rendered at read time — and minus `produtoNome`/`sku`,
 * which the download joins rather than storing (see the ⚠️ on `produtoId`).
 */
export const linhaRelatorioEnvioPrecoSchema = z
  .object({
    /** The family ANCHOR produto — the price source and the writeback parent. */
    produtoId: z.string().min(1),
    /**
     * ⚠️ `produtoNome`/`sku` are deliberately NOT stored here, and the download
     * route joins them instead. Denormalising them was the obvious move — the
     * plan phase already reads those documents, so widening its field mask is
     * free — but the fields would then have to reach the DRAIN loop, which runs
     * in a later dispatch and sees only `fila`. Carrying them there measured at
     * +43% per draft (176 B → 251 B), i.e. a 2000-draft page growing 344 KB →
     * 490 KB on a document rewritten after EVERY item: ~0.8 GB of extra writes
     * per run, on the hottest path in the job, to save one batched read per
     * download. The join is paid once, where it is cheap.
     */
    /** The child produto a per-variation send was priced from; null otherwise. */
    variacaoProdutoId: z.string().nullable().default(null),
    /** ML item id. Null for a plan-time skip with no listing, and for reconciliation rows. */
    anuncioId: z.string().nullable().default(null),
    /** The link doc under the anchor. Part of the row key — see the ⚠️ above. */
    linkDocId: z.string().nullable().default(null),
    resultado: envioPrecoResultadoSchema,
    fase: envioPrecoFaseSchema,
    /** The UPPER_SNAKE code; null only on `enviado`. Rendered via `mensagemDe`. */
    motivo: z.string().nullable().default(null),
    /**
     * ⚠️ Capped. `UPDATE_PRECO_ERROR` carries `err.message` verbatim and ML error
     * bodies are long; 500 uncapped rows is how a shard reaches 1 MiB and wedges
     * the job on every retry — the same reasoning as `MAX_DRAFTS_PER_FAMILY`.
     */
    erro: z.string().max(RELATORIO_ENVIO_PRECO_ERRO_MAX).nullable().default(null),
    /**
     * Reais, as `fila` stores it — **the price the plan INTENDED to send**, which
     * was actually sent only when `resultado === 'enviado'`.
     *
     * ⚠️ A `pulado`/`falha` row carries it too, on purpose: "we wanted 50 and ML
     * refused" is the useful half of a `PRECO_ANTIGO_MAIOR` or an
     * `UPDATE_PRECO_ERROR`. But that makes the field a TRAP for any reader that
     * treats non-null as "this landed" — a CSV pairing `precoAnterior → preco`
     * unconditionally would print "de R$ 90,00 para R$ 50,00" for a listing still
     * sitting at 90 and never touched, which is the exact false claim this report
     * exists to prevent. **Key the "para" column off `resultado`, never off this
     * being non-null.**
     */
    preco: z.number().nullable().default(null),
    /** What the listing carried BEFORE — the half the job used to discard. */
    precoAnterior: z.number().nullable().default(null),
    /** Entry count when ML took a bulk variations payload; else null. */
    variacoes: z.number().int().nullable().default(null),
  })
  .passthrough();
export type LinhaRelatorioEnvioPreco = z.infer<typeof linhaRelatorioEnvioPrecoSchema>;

export const relatorioEnvioPrecoSchema = z
  .object({
    /** Keyed by {@link relatorioEnvioPrecoRowKey} — identity, never outcome. */
    linhas: z.record(z.string(), linhaRelatorioEnvioPrecoSchema).default({}),
    timestamp: millisSinceEpoch('Gerado em').nullable().default(null),
  })
  .passthrough();
export type RelatorioEnvioPreco = z.infer<typeof relatorioEnvioPrecoSchema>;

/**
 * Rows per shard. A row is ~220 B typical and ~520 B worst case with `erro` at
 * its cap, so 500 lands at ~110 KB / ~260 KB — 4-9x headroom under Firestore's
 * 1 MiB document limit. `relatorioBalanco` halved legacy's 1000 for the same
 * reason; these rows carry more fields, so it stays at 500.
 */
export const RELATORIO_ENVIO_PRECO_SHARD_SIZE = 500;

/** Zero-padded so LEXICAL order is shard order — which is what lets the download page by `__name__` with no index. */
export function relatorioEnvioPrecoShardId(index: number): string {
  return String(index).padStart(4, '0');
}

/**
 * The identity of one report row, used as its key inside a shard's `linhas`.
 *
 * ⚠️ Every part is load-bearing:
 *  - `produtoId` + `variacaoProdutoId` — a child under two parent links is two rows.
 *  - `linkDocId` — `buildPrecoDrafts` loops `for (const link of row.links)` and its
 *    `emittedItemIds` dedup Set is per FAMILY ROW, not global, so the same
 *    `itemId` can legitimately appear under two families with drifted links.
 *  - `fase` — a produto can produce a plan skip AND a reconciliation finding.
 *  - `anuncioId` — distinguishes a family's members from one another.
 *
 * ⚠️ And what is deliberately ABSENT is the outcome: see the module docblock.
 *
 * Firestore map keys may not contain `/` or `.` and may not start with `__`;
 * every part here is a doc id or an ML item id, but the sanitisation is applied
 * anyway so a future caller cannot make an unwritable key by accident.
 */
export function relatorioEnvioPrecoRowKey(input: {
  produtoId: string;
  variacaoProdutoId?: string | null;
  linkDocId?: string | null;
  anuncioId?: string | null;
  fase: EnvioPrecoFase;
}): string {
  const partes = [
    input.produtoId,
    input.variacaoProdutoId ?? '',
    input.linkDocId ?? '',
    input.anuncioId ?? '',
    input.fase,
  ];
  return partes
    .map((p) => p.replace(/[/.]/g, '_'))
    .join('|')
    .replace(/^__/, 'x_');
}
