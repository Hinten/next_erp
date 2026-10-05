/**
 * Imposto resolver — the app's Firestore binding for the shared cascade.
 *
 * ⚠️ **The cascade itself moved to `@delfrance/data/admin/imposto` (#1519).**
 * A Shopee publish needs the same `Imposto` a NF-e item needs, for the
 * `tax_info` block; `apps/shopee` has no dependency edge to `apps/nfe` and none
 * is possible, so the rule either moves to a package both reach or gets written
 * twice — and a second copy of a decision this expensive drifts toward
 * plausible while reading correct (root `CLAUDE.md`, #1369). The five-tier
 * priority, the `pickByOperacao` scope preference (#222), the NCM candidate
 * chain (#398) and the "a matched doc that fails `impostoSchema` falls through
 * with a warn" contract all live there now, and the `falling through` warnings
 * the block below refers to are emitted from that module (prefixed
 * `[imposto-resolver]`).
 *
 * What stays here is 25 lines of Admin-SDK plumbing and no decision: this app
 * reads the two legacy-named subcollections through raw refs (`apps/nfe`
 * `CLAUDE.md` rule 5 / #423), while `packages/data` reads the same three paths
 * through `defineAdminCollection` handles. Two bindings for the same paths is a
 * drift risk, so it is guarded — `test/lib/nfe/imposto-resolver.paths.test.ts`
 * asserts this file's `.collection(...)` literals against the promoted handles'
 * own `resolvePath`, and reds when either side moves.
 *
 * The re-exports below keep every existing importer (`orchestrator/bundle.ts`
 * and the three test suites) pointing at this module, which is why those suites
 * are byte-unedited across the promotion — that is the proof the cascade did
 * not fork.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  impostoCategoriaSchema,
  impostoProdutoSchema,
  type ImpostoCategoria,
  type ImpostoProduto,
} from '@delfrance/schemas';
import {
  createImpostoResolver,
  type ImpostoResolver,
  type ResolverBundle,
} from '@delfrance/data/admin/imposto';
import type { ZodError } from 'zod';

export {
  createImpostoResolver,
  type ImpostoResolver,
  type ImpostoResolverDeps,
  type ResolverBundle,
} from '@delfrance/data/admin/imposto';

/** First zod issue as a `path message` fragment for single-line logs. */
function firstIssue(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'parse failed';
  const path = first.path.map(String).join('.');
  return `${path.length > 0 ? path : '(root)'} ${first.message}`;
}

/**
 * A config doc that fails its OWN collection schema never reaches the cascade —
 * it is dropped from the candidate list before any tier runs, so the
 * `failed impostoSchema … falling through` warnings above can never fire for
 * it. Without this line the item silently resolves against a LOWER tier (or
 * none): not a loud failure, a wrong NF-e. Logged with the concrete doc path
 * so the offending document is directly addressable.
 */
function warnDropped(path: string, error: ZodError): void {
  console.warn(
    `[nfe/imposto-resolver] dropped '${path}': does not match its collection schema — ${firstIssue(error)} — this doc cannot participate in the cascade`,
  );
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
        else warnDropped(doc.ref.path, parsed.error);
      }
      return out;
    },
    async readImpostoCategoriaSubcoll(categoriaUid) {
      const snap = await fs.collection('categorias').doc(categoriaUid).collection('imposto').get();
      const out: ImpostoCategoria[] = [];
      for (const doc of snap.docs) {
        const parsed = impostoCategoriaSchema.safeParse({ id: doc.id, ...doc.data() });
        if (parsed.success) out.push(parsed.data);
        else warnDropped(doc.ref.path, parsed.error);
      }
      return out;
    },
    /* eslint-enable no-restricted-syntax */
  });
}
