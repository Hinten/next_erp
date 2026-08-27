# mass-import — "importar todos os anúncios"

The resumable bulk job that walks a seller's whole catalogue through
`importacao/`. Separate from that theme because the _job_ concerns — a durable
`running` job doc, keyset paging, cancellation, self-re-enqueue — are
independent of what one import does.

- `massImport.ts` — the job core: the job doc, the keyset scan, and
  `finalizeMassImportJob`. ⚠️ That transaction is **class B**: `status` has two
  uncoordinated writers (the task handler finalising, and `importar-todos/cancelar`
  stamping `cancelled`), so `status` and `integracaoId` are both re-derived from
  the `tx.get` snapshot and a concurrent winner turns the call into a no-op.
- `mlMassImportTasks.ts` — the `onTaskDispatched` scheduler that self-re-enqueues
  the job. Lives here rather than in a shared `tasks/` folder because it is a
  single-consumer wrapper over `massImport.ts`.
