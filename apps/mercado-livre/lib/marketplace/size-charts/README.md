# size-charts — grades de tamanho

ML's size-chart catalog: choosing a chart at publish time and keeping the
seller's charts in sync.

- `sizeChart.ts` — pure chart selection and row matching at publish time.
  Consumed by `anuncios/publish.ts` and `anuncios/publishCore.ts`.
- `sizeChartSync.ts` — chart CRUD sync to ML, per integração.
- `sizeChartDelete.ts` — the `DELETE /catalog/charts/{id}` half of the CRUD.

## Sending a locally saved chart (#1799)

The editor persists the draft immediately with its existing full-chart guard.
`POST size-charts/sync` then takes `operationId` (UUID), `chartIndex` and `chart`
(the committed full snapshot), plus the account and tabela IDs. Siblings are
never implicit send targets. Existing charts are diffed against an uncached
`GET /catalog/charts/{id}`, not against the just-saved desired document.

Rows join by ML ID; new rows join by their immutable main-attribute value.
Response order is irrelevant. Only writable attributes participate in the diff;
ERP bindings and computed SIZE do not. Numeric spelling folds only the decimal
separator, including before a unit. Leading/trailing zeros remain distinct.

Admin-only `tabMedi/{id}/mlChartSync/{account}` reserves one operation for this
resource. Its `mlChartSyncOperations/{operationId}` records the immutable desired
snapshot, projected local version, remote baseline, pending step and receipts.
These leaves have no collection metadata or client rules. Neither generated
ruleset changes and no corpus migration is needed.

Before each mutation the worker rechecks ownership and the complete projected
chart. Each provider receipt is committed before interpretation, then IDs and
computed values are written only if that chart still matches. The transaction
rebuilds siblings from its own read and uses literal FieldPath segments. A newer
local edit wins: the receipt survives, the newer content stays, and the send
reports a conflict. Delete and verification share the same reservation.

The I/O budget is 120 seconds, individual requests abort after at most 20 seconds,
and transport retries are disabled. The 240-second lease cannot overlap a
previous worker's mutation window. A process crash retains the pending step;
retry the same operation after its safe lease deadline.

`GET size-charts/sync` returns only the current/last operation's desired and
projected chart under integration-write permission. The editor uses this to
resume a lost response without saving stale IDs. Validation errors retain all
operator input and are returned as `status: validation`; only `completed` with
no errors closes the editor with success.

Unknown POST outcomes are never automatically re-posted. A pending row creation
is reconciled against a fresh chart read and must have one unique main-value
match. A pending chart creation uses a receipt's known ID, or the operator's
`recoveryChartId`; account ownership, chart identity and content are verified.
When there is no unique confirmed result, keep the operation reserved and show
`CHART_UNCONFIRMED`. Do not clear the journal to bypass this condition. A conflict
receipt that requires manual reconciliation stays available in the Admin-only
operation document; review its remote IDs against the newer local draft before
changing that reservation.

`sizeChartSend.test.ts` exercises the real HTTP adapter with captured calls;
`sizeChartOperation.firestore.test.ts` tests real emulator contention. The joined
regression belongs to `tools/test-fixtures/src/mlChartSend.test.ts` and runs the
actual browser save followed by the backend sync. Its Turbo inputs explicitly
include both source surfaces, so edits invalidate the cache in the always-run
tooling test lane without introducing an app-to-app production dependency.
