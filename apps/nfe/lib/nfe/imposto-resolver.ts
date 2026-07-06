/**
 * Imposto resolver — bridges Firestore-stored Imposto rules into the
 * tribute engine's strongly-typed `Imposto`. Mirrors Flutter's resolver
 * chain (`.old/packages/produtos/lib/src/models.dart:2848` and friends).
 *
 * Cascade priority (item-stamped → produto-specific → categoria-specific
 * → operação-rule):
 *
 *   1. `pedido.itens[i].imposto` (already on the item — Phase A only this
 *       branch existed). When present and valid, it wins.
 *   2. `produtos/{produtoUid}/imposto/*` doc matching the active operação
 *       (scope key = Flutter's typo `impostoOpercaoOuterRef`, null = any).
 *   3. `categorias/{categoriaUid}/imposto/*` doc matching the active
 *       operação (scope key = the legacy `impostoCategoriaOperacaoOuterRef`).
 *       `categoriaUid` is read from the produto doc's
 *       `categoriaProdutoOuterRef`. Both tiers read the legacy Flutter wire
 *       verbatim — shared database, no migration (#423).
 *   4. First `regraImposto` whose `produtos`, `categorias`, or `ncms`
 *       arrays OR-match the item's produtoUid / categoriaUid / NCM.
 *       Array entries are matched by trailing path segment (bare uid,
 *       `produtos/<uid>` and `documents/...` shapes all work) and NCMs
 *       digits-only (`normalizeNCM`) — a formatted `6109.10.00` produto
 *       NCM still hits an 8-digit rule entry (#398). The NCM compared is
 *       the one from the closest tier candidate that carried one (invalid
 *       item stamp → impostoProduto → impostoCategoria), falling back to
 *       `produto.NCM` — Flutter matched the *resolved* imposto's NCM.
 *
 * A matched doc that fails the engine `impostoSchema` falls through to
 * the next tier with a warn (#398 — it used to be silent, making an
 * exact-scoped match's failure indistinguishable from absence).
 *
 * Per-produtoUid memoization: a pedido with the same produto appearing
 * twice only hits Firestore once. The cache lives in the resolver
 * closure. The cascade inputs are fixed by `bundle` (operacaoId +
 * regrasImposto), so one resolver may be shared across every pedido on
 * the same operação (the batch path does this); discard it once those
 * inputs change.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  impostoCategoriaSchema,
  impostoProdutoSchema,
  normalizeNCM,
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';
import { impostoSchema, type Imposto } from '@delfrance/integrations-nfe';
import type { ZodError } from 'zod';

/**
 * Narrow view of PedidoBundle that the resolver needs. Lets the
 * resolver stay decoupled from the full orchestrator bundle shape.
 */
export interface ResolverBundle {
  readonly operacaoId: string;
  readonly regrasImposto: readonly RegraImposto[];
  /**
   * The operação doc's own tax config — the **last-resort default tier**. When
   * no item-stamp / produto / categoria / regra matches, the resolver builds an
   * Imposto from the operação's `origem` + `cfop` + `configuracao*` fields. This
   * restores the full Flutter resolver chain (item → produto → categoria →
   * regra → operação): without it, an item that matches no rule fails emission
   * with `NFeMissingImpostoError`. Optional + parsed leniently (an operação
   * without a usable default — e.g. no `origem` — simply doesn't fire the tier).
   */
  readonly operacao?: Record<string, unknown> | null;
}

export interface ImpostoResolverDeps {
  readonly bundle: ResolverBundle;
  /** Read a produto doc; null when the doc doesn't exist. */
  readProduto(produtoUid: string): Promise<Record<string, unknown> | null>;
  /** Read every doc under `produtos/{produtoUid}/imposto`. */
  readImpostoProdutoSubcoll(produtoUid: string): Promise<readonly ImpostoProduto[]>;
  /** Read every doc under `categorias/{categoriaUid}/imposto` (legacy wire name). */
  readImpostoCategoriaSubcoll(categoriaUid: string): Promise<readonly ImpostoCategoria[]>;
}

export interface ImpostoResolver {
  /**
   * Resolve the Imposto for one pedido item. `itemImposto` is the raw
   * `pedido.itens[i].imposto` value (may be null/undefined). Returns
   * null when no rule applies — the orchestrator surfaces that as
   * `NFeMissingImpostoError`.
   */
  resolve(produtoUid: string, itemImposto: unknown): Promise<Imposto | null>;
}

/** Sentinel for "we've tried and got nothing." Kept distinct from `undefined`. */
const NO_MATCH = Symbol('no-match');

interface CachedResult {
  /** Resolved Imposto, or NO_MATCH if we've already tried and failed. */
  readonly value: Imposto | typeof NO_MATCH;
}

/**
 * Build a resolver from injectable read functions. Pure — no Firestore
 * dep; suitable for unit tests with hand-rolled fakes. The orchestrator
 * uses `createFirestoreImpostoResolver` below to wire the real reads.
 */
export function createImpostoResolver(deps: ImpostoResolverDeps): ImpostoResolver {
  const cache = new Map<string, CachedResult>();

  async function resolveImpl(produtoUid: string, itemImposto: unknown): Promise<Imposto | null> {
    // 1. item-stamped imposto wins when valid.
    let stampNcm: string | null = null;
    if (itemImposto != null) {
      const parsed = impostoSchema.safeParse(itemImposto);
      if (parsed.success) return parsed.data;
      // Invalid stamp falls through to the cascade — operator
      // probably wrote a partial blob expecting the resolver to fill in.
      // (`preResolveImpostos` logs it with the pedido context.) Its NCM,
      // when present, still keys the regra tier below — Flutter matched
      // the *resolved* imposto's NCM, and the stamp is the closest tier.
      stampNcm = normalizeNCM(readNCM(itemImposto));
    }

    // The stamp NCM can steer the regra tier, so it participates in the memo
    // key — two items of the same produto carrying different (invalid) stamped
    // NCMs must not share a cached result.
    const cacheKey = stampNcm == null ? produtoUid : `${produtoUid} ${stampNcm}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached.value === NO_MATCH ? null : cached.value;

    // 2. impostoProduto match (scoped to active operacao). impostoProduto uses
    // Flutter's typo wire key `impostoOpercaoOuterRef`.
    let candidateNcm = stampNcm;
    const impostoProdutos = await deps.readImpostoProdutoSubcoll(produtoUid);
    const produtoMatch = pickByOperacao(
      impostoProdutos,
      (d) => d.impostoOpercaoOuterRef,
      deps.bundle.operacaoId,
    );
    if (produtoMatch) {
      const parsed = impostoSchema.safeParse(produtoMatch);
      if (parsed.success) {
        cache.set(cacheKey, { value: parsed.data });
        return parsed.data;
      }
      candidateNcm ??= normalizeNCM(produtoMatch.NCM);
      console.warn(
        `[nfe/imposto-resolver] produto '${produtoUid}': impostoProduto '${produtoMatch.id ?? '?'}' matched operação '${deps.bundle.operacaoId}' but failed impostoSchema — ${firstIssue(parsed.error)} — falling through`,
      );
    }

    // 3. impostoCategoria — need produto's categoriaUid first.
    const produto = await deps.readProduto(produtoUid);
    const categoriaUid = parseCategoriaUid(produto);
    if (categoriaUid) {
      const impostoCategorias = await deps.readImpostoCategoriaSubcoll(categoriaUid);
      const categoriaMatch = pickByOperacao(
        impostoCategorias,
        (d) => d.impostoCategoriaOperacaoOuterRef,
        deps.bundle.operacaoId,
      );
      if (categoriaMatch) {
        const parsed = impostoSchema.safeParse(categoriaMatch);
        if (parsed.success) {
          cache.set(cacheKey, { value: parsed.data });
          return parsed.data;
        }
        candidateNcm ??= normalizeNCM(categoriaMatch.NCM);
        console.warn(
          `[nfe/imposto-resolver] produto '${produtoUid}': impostoCategoria '${categoriaMatch.id ?? '?'}' (categoria '${categoriaUid}') matched operação '${deps.bundle.operacaoId}' but failed impostoSchema — ${firstIssue(parsed.error)} — falling through`,
        );
      }
    }

    // 4. regraImposto — OR-match on produtos / categorias / ncms. Entries are
    // matched by trailing path segment and NCMs digits-only (#398): bare uids,
    // `produtos/<uid>` / `documents/...` paths and formatted NCMs all work.
    // The NCM compared prefers the closest tier candidate (stamp → produto →
    // categoria) over the produto doc's own NCM — Flutter parity.
    const ncm = candidateNcm ?? normalizeNCM(parseNCM(produto));
    for (const regra of deps.bundle.regrasImposto) {
      const matches =
        regra.produtos.some((p) => trailingSegment(p) === produtoUid) ||
        (categoriaUid != null &&
          regra.categorias.some((c) => trailingSegment(c) === categoriaUid)) ||
        (ncm != null && regra.ncms.some((n) => normalizeNCM(n) === ncm));
      if (!matches) continue;
      // Legacy `regras` docs carry an UPPERCASE `CFOP` — fold it into the
      // engine's lowercase `cfop` (a lowercase value, when present, wins).
      const parsed = impostoSchema.safeParse({ ...regra, cfop: regra.cfop ?? regra.CFOP });
      if (parsed.success) {
        cache.set(cacheKey, { value: parsed.data });
        return parsed.data;
      }
      console.warn(
        `[nfe/imposto-resolver] produto '${produtoUid}': regraImposto '${regra.id ?? '?'}' matched (operação '${deps.bundle.operacaoId}') but failed impostoSchema — ${firstIssue(parsed.error)} — falling through`,
      );
    }

    // 5. operação default — the operação doc's own tax config (Flutter parity:
    // the last tier of the resolver chain). Strips the non-Imposto operação
    // fields (nome, tipo, …) via `impostoSchema`; falls through when the
    // operação carries no usable default (e.g. missing `origem`).
    const operacao = deps.bundle.operacao;
    if (operacao) {
      const parsed = impostoSchema.safeParse(operacao);
      if (parsed.success) {
        cache.set(cacheKey, { value: parsed.data });
        return parsed.data;
      }
      // debug, not warn: an operação with no usable default is an EXPECTED
      // fall-through (the tier's own contract) — a warn here would fire for
      // every unresolvable item on perfectly normal setups.
      console.debug(
        `[nfe/imposto-resolver] produto '${produtoUid}': operação '${deps.bundle.operacaoId}' carries no usable default Imposto — ${firstIssue(parsed.error)}; no imposto resolved`,
      );
    }

    cache.set(cacheKey, { value: NO_MATCH });
    return null;
  }

  return { resolve: resolveImpl };
}

/**
 * Pick the imposto whose scope matches the active operação.
 *
 * Scope semantics: a `null` scope ref applies to **every** operação (the default
 * fallback); otherwise the trailing segment of the doc path must equal the
 * active `operacaoId` (Flutter parity — the Dart side stores these as
 * DocumentReferences that serialise to paths).
 *
 * An **exact** per-operação match always wins over a null-scoped default. Without
 * that preference, a default entry appearing earlier in the array would shadow a
 * per-operação override — #222, "fiscal data not respecting the selected
 * operação" (a `.find()` that accepts both would return whichever comes first).
 */
function pickByOperacao<T>(
  docs: readonly T[],
  scopeOf: (d: T) => string | null,
  operacaoId: string,
): T | undefined {
  const exact = docs.find((d) => {
    const ref = scopeOf(d);
    if (ref == null) return false;
    return trailingSegment(ref) === operacaoId;
  });
  return exact ?? docs.find((d) => scopeOf(d) == null);
}

/**
 * Last non-empty segment of a path-or-id — `documents/produtos/p1`,
 * `produtos/p1` and `p1` all yield `p1`. The legacy Flutter writers stored
 * ids in all three shapes (#398), so every id comparison in the cascade
 * goes through here.
 */
function trailingSegment(pathOrId: string): string | null {
  const seg = pathOrId
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .pop();
  return seg != null && seg.length > 0 ? seg : null;
}

/** First zod issue as a `path message` fragment for single-line logs. */
function firstIssue(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'parse failed';
  const path = first.path.map(String).join('.');
  return `${path.length > 0 ? path : '(root)'} ${first.message}`;
}

/** NCM off a raw (unparsed) imposto-ish blob; null unless a string. */
function readNCM(blob: unknown): string | null {
  if (blob != null && typeof blob === 'object' && 'NCM' in blob) {
    const v = (blob as { NCM?: unknown }).NCM;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

function parseCategoriaUid(produto: Record<string, unknown> | null): string | null {
  if (!produto) return null;
  const ref = produto.categoriaProdutoOuterRef;
  if (typeof ref === 'string') {
    return ref.split('/').pop() ?? null;
  }
  if (ref && typeof ref === 'object' && 'path' in ref) {
    const p = (ref as { path?: unknown }).path;
    return typeof p === 'string' ? (p.split('/').pop() ?? null) : null;
  }
  return null;
}

function parseNCM(produto: Record<string, unknown> | null): string | null {
  if (!produto) return null;
  return typeof produto.NCM === 'string' ? produto.NCM : null;
}

/**
 * Default Firestore-backed factory. Wires the read functions to the
 * Admin SDK; the resolver itself is the pure cascade above.
 */
export function createFirestoreImpostoResolver(
  fs: Firestore,
  bundle: ResolverBundle,
): ImpostoResolver {
  return createImpostoResolver({
    bundle,
    /* eslint-disable no-restricted-syntax -- read-only: produtos / categorias
       docs and their `imposto` tax subcollections (legacy Flutter wire names).
       Writes to these collections go through validated handles elsewhere. */
    async readProduto(produtoUid) {
      const snap = await fs.collection('produtos').doc(produtoUid).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    async readImpostoProdutoSubcoll(produtoUid) {
      const snap = await fs.collection('produtos').doc(produtoUid).collection('imposto').get();
      const out: ImpostoProduto[] = [];
      for (const doc of snap.docs) {
        const parsed = impostoProdutoSchema.safeParse({ id: doc.id, ...doc.data() });
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
    async readImpostoCategoriaSubcoll(categoriaUid) {
      const snap = await fs.collection('categorias').doc(categoriaUid).collection('imposto').get();
      const out: ImpostoCategoria[] = [];
      for (const doc of snap.docs) {
        const parsed = impostoCategoriaSchema.safeParse({ id: doc.id, ...doc.data() });
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
    /* eslint-enable no-restricted-syntax */
  });
}
