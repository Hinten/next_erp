# Home dashboard (#1499)

`/inicio` keeps Avisos and independently loads seller sales, dispatch counts per
active legacy dispatch channel, and checkout counts. Reads are cached for 60
seconds per authenticated user. Refresh bypasses that cache; local midnight
changes calendar-dependent cache keys. Chart controls reuse the grouped counts.

Sales run in the authenticated `consultarVendasInicio` callable. An empty strict
request prevents choosing another seller. Dispatch counters and destination
presets share the predicates in `@delfrance/schemas`. Total is a distinct OR union,
including future prepared orders, with no dispatched upper bound. Checkout uses
one aggregate over the earliest of the calendar month and Monday-based week;
names are resolved only for returned users, without a top-20 cap. Unresolved
names remain in Outros usuários.

## Manual deployment dependencies

No data migration or collection permission change is required. No index tracking
issue is needed. Deployments are manual; agents must not execute these commands.
For staging, use the configured staging project. Production infrastructure belongs
to the coordinated cutover described in ADR 0013.

1. Deploy `firestore.indexes.json` and wait until all three added covering indexes
   report READY. Keep the existing integration-name and timestamp-first checkout
   collection-group indexes.
2. Build/prepare and deploy the `consultarVendasInicio` export in the `storage`
   Functions codebase, following `apps/functions/DEPLOY.md`. Confirm its configured
   region matches `NEXT_PUBLIC_FUNCTIONS_REGION` before the web release.
3. Run Query Explain against staging, then deploy the web app. Verify seller
   isolation, all eligible active channels (including zero orders), each counter's
   linked rows, and checkout totals. The web must follow the callable and ready
   indexes; an unindexed Enterprise query silently bills a full scan.

```sh
firebase deploy --project <staging-project> --config firebase.staging.json --only firestore:indexes
gcloud firestore indexes composite list --project <staging-project> --database default --format="table(name,state)"
firebase deploy --project <staging-project> --config firebase.functions.deploy.json --only functions:storage
firebase functions:list --project <staging-project>

# ADC for staging; concrete bounds come from the operator's local calendar.
# Run from the repository root. Explain prints each aggregate and all seven links.
pnpm exec tsx apps/functions/src/inicio/verifyInicioQueries.ts <staging-project> <seller-uid> <channel-id> <start-us> <end-us> <day-ms> <week-ms> <month-ms> <now-ms>

pnpm --filter @delfrance/web exec playwright test e2e/inicio-dashboard.vendas.e2e.spec.ts --project=crud-vendas
```

Retain the Explain output in the PR/release evidence. Check index selection and
scanned data for sales, the dispatch aggregate, all seven link queries, and the
checkout aggregate. The command rejects TableScan, but also inspect scan volume:
an index chosen with a broad scan is still expensive. Verify both canonical and
bare references and seeded empty channels. Pipelines cannot run in the emulator.

Offline verification covers date boundaries, overlap/unique Total, matching link
sets, auth/permission checks, average rounding, all channel types, unknown names,
chart controls, URL and memory precedence, clearing, and both query transports.
Live Explain and the seeded E2E require staging credentials and ready indexes;
offline index coverage alone does not prove the runtime planner uses an index.
