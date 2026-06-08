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
 *       (`impostoOperacaoOuterRef === bundle.operacaoId` or null).
 *   3. `categorias/{categoriaUid}/impostocategoria/*` doc matching the
 *       active operação. `categoriaUid` is read from the produto doc's
 *       `categoriaProdutoOuterRef`.
 *   4. First `regraImposto` whose `produtos`, `categorias`, or `ncms`
 *       arrays OR-match the item's produtoUid / categoriaUid / produto.NCM.
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
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';
import { impostoSchema, type Imposto } from '@delfrance/integrations-nfe';

/**
 * Narrow view of PedidoBundle that the resolver needs. Lets the
 * resolver stay decoupled from the full orchestrator bundle shape.
 */
export interface ResolverBundle {
  readonly operacaoId: string;
  readonly regrasImposto: readonly RegraImposto[];
}

export interface ImpostoResolverDeps {
  readonly bundle: ResolverBundle;
  /** Read a produto doc; null when the doc doesn't exist. */
  readProduto(produtoUid: string): Promise<Record<string, unknown> | null>;
  /** Read every doc under `produtos/{produtoUid}/imposto`. */
  readImpostoProdutoSubcoll(produtoUid: string): Promise<readonly ImpostoProduto[]>;
  /** Read every doc under `categorias/{categoriaUid}/impostocategoria`. */
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
    if (itemImposto != null) {
      const parsed = impostoSchema.safeParse(itemImposto);
      if (parsed.success) return parsed.data;
      // Invalid stamp falls through to the cascade — operator
      // probably wrote a partial blob expecting the resolver to fill in.
    }

    const cached = cache.get(produtoUid);
    if (cached) return cached.value === NO_MATCH ? null : cached.value;

    // 2. impostoProduto match (scoped to active operacao).
    const impostoProdutos = await deps.readImpostoProdutoSubcoll(produtoUid);
    const produtoMatch = impostoProdutos.find((d) =>
      operacaoMatches(d.impostoOperacaoOuterRef, deps.bundle.operacaoId),
    );
    if (produtoMatch) {
      const parsed = impostoSchema.safeParse(produtoMatch);
      if (parsed.success) {
        cache.set(produtoUid, { value: parsed.data });
        return parsed.data;
      }
    }

    // 3. impostoCategoria — need produto's categoriaUid first.
    const produto = await deps.readProduto(produtoUid);
    const categoriaUid = parseCategoriaUid(produto);
    if (categoriaUid) {
      const impostoCategorias = await deps.readImpostoCategoriaSubcoll(categoriaUid);
      const categoriaMatch = impostoCategorias.find((d) =>
        operacaoMatches(d.impostoOperacaoOuterRef, deps.bundle.operacaoId),
      );
      if (categoriaMatch) {
        const parsed = impostoSchema.safeParse(categoriaMatch);
        if (parsed.success) {
          cache.set(produtoUid, { value: parsed.data });
          return parsed.data;
        }
      }
    }

    // 4. regraImposto — OR-match on produtos / categorias / ncms.
    const ncm = parseNCM(produto);
    for (const regra of deps.bundle.regrasImposto) {
      const matches =
        regra.produtos.includes(produtoUid) ||
        (categoriaUid != null && regra.categorias.includes(categoriaUid)) ||
        (ncm != null && regra.ncms.includes(ncm));
      if (!matches) continue;
      const parsed = impostoSchema.safeParse(regra);
      if (parsed.success) {
        cache.set(produtoUid, { value: parsed.data });
        return parsed.data;
      }
    }

    cache.set(produtoUid, { value: NO_MATCH });
    return null;
  }

  return { resolve: resolveImpl };
}

/**
 * `impostoOperacaoOuterRef === null` → applies to every operação (default
 * fallback). Otherwise the trailing segment of the doc path must match
 * `bundle.operacaoId` (Flutter parity — the Dart side stores these as
 * DocumentReferences that serialise to paths).
 */
function operacaoMatches(ref: string | null, activeOperacaoId: string): boolean {
  if (ref == null) return true;
  const trimmed = ref.replace(/^\/+|\/+$/g, '');
  const last = trimmed.split('/').pop();
  return last === activeOperacaoId;
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
       docs and their legacy `imposto` / `impostocategoria` subcollections.
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
      const snap = await fs
        .collection('categorias')
        .doc(categoriaUid)
        .collection('impostocategoria')
        .get();
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
