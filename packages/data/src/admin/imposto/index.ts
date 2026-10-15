/**
 * The Imposto cascade, shared. The five-tier resolution (item stamp → produto
 * `imposto` → categoria `imposto` → operação `regras` → the operação's own
 * default) was `apps/nfe`'s alone until a marketplace publish needed the same
 * answer for Shopee's `tax_info` block. `apps/web` has no dependency edge to
 * any `apps/*`, and neither does `apps/shopee`, so a rule that two surfaces
 * need either moves here or gets written twice — and a second copy of a
 * decision this expensive drifts toward plausible while reading correct (root
 * `CLAUDE.md`, #1369).
 *
 * This is a NARROW subpath (`@delfrance/data/admin/imposto`) on purpose: a
 * Cloud-Functions-graph module importing the cascade must not drag the
 * notifications, cache, pipelines and reconcile modules in behind it. The
 * `@delfrance/data/admin` barrel does not re-export any of this.
 */
export {
  createImpostoResolver,
  type ImpostoResolver,
  type ImpostoResolverDeps,
  type ResolverBundle,
} from './resolverImposto';
export { createFirestoreImpostoResolver, lerResolverBundle } from './firestoreImpostoResolver';
export {
  criarLeitorDeImpostoPorOperacao,
  MOTIVO_LEITURA_IMPOSTO,
  type DepsLeitorDeImposto,
  type LeitorDeImpostoPorOperacao,
  type LeituraImposto,
  type MotivoLeituraImposto,
} from './leitorPorOperacao';
