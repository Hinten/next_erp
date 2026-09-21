/**
 * Firestore binding for the promoted Imposto cascade (`resolverImposto.ts`) —
 * the three reads it needs, on the Admin collection handles, plus the bundle
 * loader a non-pedido caller needs.
 *
 * ## The twin in `apps/nfe`
 *
 * `apps/nfe/lib/nfe/imposto-resolver.ts` keeps its OWN
 * `createFirestoreImpostoResolver`, reading the same three paths through raw
 * Firestore refs instead of these handles. That duplication is deliberate and
 * bounded: its test double models the nested root → doc → subcollection chain,
 * while a handle read passes the WHOLE resolved path in one call, so promoting
 * the binding too would have meant editing the 725-line cascade suite whose
 * byte-unedited greenness is the proof that the MOVE changed no behaviour. What
 * is duplicated is plumbing that contains no decision; what is shared is the
 * cascade, which is where the decisions are. The anti-drift is the source-text
 * path-parity test in the app's suite — if either side ever reads a different
 * path, it reds.
 *
 * ## Why these reads are not `parseRead`
 *
 * `parseRead` is a SOFT read: it warns and hands back the RAW document. That is
 * right for a display surface and wrong here. A doc that fails its own
 * collection schema must never reach a tier, because a lower tier answering in
 * its place is not a loud failure — it is a wrong NF-e (and now a wrong
 * `tax_info` on a marketplace listing). So each subcollection doc is
 * `safeParse`d, dropped on failure, and logged with its concrete path.
 *
 * ## Cost
 *
 * `lerResolverBundle` is TWO reads (the operação doc + its `regras`
 * subcollection) and a resolver built from it pays up to three more per produto
 * (produto doc, produto `imposto`, categoria `imposto`). The resolver memoises
 * per produto; the BUNDLE does not memoise itself. A bulk caller hoists
 * `lerResolverBundle` out of its loop and reuses one resolver — the cascade
 * inputs are fixed by `operacaoId`.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  impostoCategoriaSchema,
  impostoProdutoSchema,
  regraImpostoSchema,
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';
import type { ZodError } from 'zod';

import {
  impostoCategoriaCollection,
  impostoProdutoCollection,
  operacaoCollection,
  produtoCollection,
  regraImpostoCollection,
} from '../collections';
import {
  createImpostoResolver,
  firstIssue,
  type ImpostoResolver,
  type ResolverBundle,
} from './resolverImposto';

/**
 * A config doc that fails its OWN collection schema never reaches the cascade —
 * it is dropped from the candidate list before any tier runs, so the
 * `failed impostoSchema … falling through` warnings in the cascade can never
 * fire for it. Without this line the item silently resolves against a LOWER
 * tier (or none): not a loud failure, a wrong NF-e. Logged with the concrete
 * doc path so the offending document is directly addressable.
 */
function warnDropped(path: string, error: ZodError): void {
  console.warn(
    `[imposto-resolver] dropped '${path}': does not match its collection schema — ${firstIssue(error)} — this doc cannot participate in the cascade`,
  );
}

/**
 * Default Firestore-backed factory. Wires the read functions to the Admin
 * handles; the resolver itself is the pure cascade in `resolverImposto.ts`.
 *
 * ⚠️ The produto doc is read RAW (`snap.data()`), never validated. The cascade
 * reads `produto.NCM` and `produto.categoriaProdutoOuterRef`, and NEITHER is a
 * declared field of `produtoSchema` — both ride its `.passthrough()`. A
 * validated read would be wrong in principle, and a soft read would warn once
 * per produto for documents that are perfectly fine.
 */
export function createFirestoreImpostoResolver(
  db: Firestore,
  bundle: ResolverBundle,
): ImpostoResolver {
  return createImpostoResolver({
    bundle,
    async readProduto(produtoUid) {
      const snap = await produtoCollection.docRef(db, {}, produtoUid).get();
      return snap.exists ? (snap.data() ?? null) : null;
    },
    async readImpostoProdutoSubcoll(produtoUid) {
      const snap = await impostoProdutoCollection.ref(db, { produtoId: produtoUid }).get();
      const out: ImpostoProduto[] = [];
      for (const doc of snap.docs) {
        const parsed = impostoProdutoSchema.safeParse({ id: doc.id, ...doc.data() });
        if (parsed.success) out.push(parsed.data);
        else warnDropped(doc.ref.path, parsed.error);
      }
      return out;
    },
    async readImpostoCategoriaSubcoll(categoriaUid) {
      const snap = await impostoCategoriaCollection.ref(db, { categoriaId: categoriaUid }).get();
      const out: ImpostoCategoria[] = [];
      for (const doc of snap.docs) {
        const parsed = impostoCategoriaSchema.safeParse({ id: doc.id, ...doc.data() });
        if (parsed.success) out.push(parsed.data);
        else warnDropped(doc.ref.path, parsed.error);
      }
      return out;
    },
  });
}

/**
 * Load the cascade's fixed inputs for one operação: the operação doc itself
 * (tier 5) and its `regras` subcollection (tier 4). Resolves `null` when the
 * operação document does not exist — the caller has nothing to resolve against
 * and must say so rather than fall back to an empty bundle, which would answer
 * "no imposto" for reasons the operator cannot distinguish from "no rule
 * matched".
 *
 * ⚠️ **The operação is handed to the bundle RAW.** Tier 5 runs
 * `impostoSchema.safeParse(operacao)` itself and strips the non-Imposto
 * operação fields; parsing it with `operacaoSchema` here would drop the
 * `.passthrough()` keys that tier reads, and the tier would then fall through
 * on documents that carry a perfectly usable default.
 *
 * ⚠️ **Deliberately NOT used by `apps/nfe`.** The orchestrator builds its
 * bundle pedido-scoped, memoised across a batch and logged with the `pedidoId`.
 * Two callers, two cost models; the expensive part — the cascade — is the part
 * that is shared. Do not "unify" them.
 */
export async function lerResolverBundle(
  db: Firestore,
  operacaoId: string,
): Promise<ResolverBundle | null> {
  const operacaoSnap = await operacaoCollection.docRef(db, {}, operacaoId).get();
  if (!operacaoSnap.exists) return null;

  const regrasSnap = await regraImpostoCollection.ref(db, { operacaoId }).get();
  const regrasImposto: RegraImposto[] = [];
  for (const doc of regrasSnap.docs) {
    const parsed = regraImpostoSchema.safeParse({ id: doc.id, ...doc.data() });
    if (parsed.success) regrasImposto.push(parsed.data);
    else warnDropped(doc.ref.path, parsed.error);
  }

  return { operacaoId, regrasImposto, operacao: operacaoSnap.data() ?? null };
}
