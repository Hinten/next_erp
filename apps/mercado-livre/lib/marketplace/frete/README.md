# frete — int_frete ⇆ ML account reconciliation

This theme joins freight configuration and the Mercado Livre account. The
broader freight domain lives in `apps/melhor-envio` and
`packages/integrations/freight-br`; see the `freight-integrations` skill.

- `intFreteSync.ts` binds `@delfrance/data/admin/frete` to Mercado Livre,
  including the tolerant matcher for a bare `integracao/<id>` back-reference.
  The trigger and backfill use the same current-state reconciler (#1888);
  order import uses its lookup.
- `backfillIntFrete.ts` enumerates account IDs with the existing
  `integracao(tipo, nome)` index, deduplicates IDs across pages, and reconciles
  each account once. Its dry-run re-reads the account, performs the same
  canonical/tolerant lookup and deterministic-path fallback, then invokes the
  shared pure planner. A preview is advisory under concurrent changes.

The reconciler reads the current account and freight document inside one
transaction (rule 7 class A). Retries and out-of-order events converge on that
state. Mirrored fields are account-authoritative; `ultimaModificacao` is
display metadata stamped from the account snapshot's `readTime`, never an
event watermark. Updates and deactivation preserve operator-owned freight
configuration.

New records use `mercadoLivre-<accountId>`, so concurrent first reconciliations
contend on one path. Existing canonical or bare-reference records are adopted
before that path is considered, preserving their IDs and historical order
references. Equal `dataCadastro` candidates select the lexically lower ID.

The authoritative production backfill belongs to cutover Phase 2b, after
import and index readiness; the Functions deployment follows in Phase 3.
Import fires no Cloud Functions triggers, and an earlier production pass is
superseded by legacy writes until the cutover. Humans perform both operations;
[#1905](https://github.com/Hinten/next_erp/issues/1905) records the operation
under [#1208](https://github.com/Hinten/next_erp/issues/1208). See
`functions/DEPLOY.md` for the commands and verification.
