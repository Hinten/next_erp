# Coordinated access administration (#559)

## Decision

Cargo and authenticated-user writes share one global reservation in
`accessControl/current`. Commands and their final diagnostics are retained in
`accessOperations/{operationId}`; neither collection is client writable. Cargos
and usuarios are server-owned in the schema-generated rules, including for
superusers. The WhatsApp external-contact writer remains outside this reservation:
it creates externally identified contacts and updates names, never authenticated
accounts' authorization fields.

The API verifies revoked tokens and intersects their permission mask with the
actor's current eligibility and cargos. Each command is bound to its actor,
target, content and opaque snapshot version. Concurrent commands receive 409 with
the active operation ID. Repeating an identical command returns its original
operation; an ID reused with different content is rejected.

`packages/schemas` owns the eligibility policy. Inactive users, ordinary
non-collaborators and disabled Auth accounts receive zero permissions. Active
superusers do not need a collaborator link. External contacts never reach Auth;
missing Auth accounts and missing cargos contribute no permissions. Email does
not determine eligibility. Only authorization fields are parsed when reading
holders, so unrelated legacy fields cannot prevent revocation. Invalid
authorization fields reject explicitly.

The shared writer preserves unrelated claims, replaces `permissions`, `su` and
all `d_*` projections together, removes revoked domain projections, checks the
1000-byte payload limit and skips already-correct accounts. Recomputing a marked
superuser requires a superuser actor, including when revoking an inactive account.

## State machine and recovery

Validation pages contain at most 100 root usuarios referencing the cargo, ordered
by document ID with no tenant, active or collaborator filter. Auth reads are
batched and cargo reads deduplicated per page. Every holder's complete prospective
mask must fit the accepted authorization ceiling. No Auth write occurs during
validation. An empty terminal page then performs a short transaction that rechecks
the actor, reservation and target version before changing the cargo/user and
switching to `applying`. Rejections release the reservation without source changes.

Application slices contain at most 20 holders and write Auth sequentially. A
checkpoint advances only after every processed holder succeeded. Replayed writes
that already match are counted as unchanged; counters describe checkpointed
outcomes, not a count of every RPC across retries. Cargo deletion leaves user
references intact and recomputes remaining cargos. Accepted authorization is
preserved after commit, so self-demotion does not interrupt propagation.

The task queue dispatches one invocation at a time. Each slice additionally owns
a transactional lease: 120-second function timeout, 180-second dispatch deadline,
240-second lease. No new Auth RPC/write starts after 80 seconds. This margin also
covers the pinned Admin SDK's 25-second RPC timeout and four retries, including a
request already in flight at the function deadline. Revisit these constants if
upgrading the Auth SDK's retry behavior. Every checkpoint checks operation ID,
lease owner, phase and expected cursor; expired or duplicate workers cannot advance
state. Five consecutive unsuccessful attempts park a committed operation as
`failed`, retaining the global reservation. The original actor can resume using the accepted authorization; another actor must currently cover the original ceiling; there is no discard/force-success operation.

A Firestore creation trigger dispatches the persisted operation. A five-minute
watchdog reads only the control document and its referenced operation, redispatching
pending work whose lease expired and which has not progressed for a minute. This
also recovers a failed enqueue. Manual retry is picked up by that watchdog within
five minutes. Successful slices enqueue their successor. Diagnostics contain
codes and target IDs, never passwords, tokens or provider error payloads.

User creation reserves a deterministic UID derived from actor and operation ID.
The password exists only in the HTTP request and Auth create call. The worker
waits for the Auth account before validating/committing the usuario document.
A lost HTTP response is reconciled by UID; an account that was never provisioned
causes precommit rejection after the bounded provisioning window. Provisioning
may leave an Auth account with no permissions if later validation rejects; it
never grants the proposed permissions early.

## HTTP and UI

- `GET/POST/PATCH/DELETE /api/admin/cargos[/id]`: versioned editor/read and commands.
- `GET/PATCH /api/admin/users/[uid]`: equivalent versioned user editor.
- `POST /api/admin/users` and `POST /api/admin/users/[uid]/claims`: coordinated
  creation and manual recomputation; both return `operationId` and `targetId`.
- `GET /api/admin/access-operations/[id]`: durable state and bounded counters.
- `POST /api/admin/access-operations/[id]/retry`: resume a failed committed operation.

202 means accepted, not saved. User creation returns 201 when Auth provisioning
has returned, with claims still pending. 401/403 distinguish invalid authentication
from denied authorization; 409 reports stale versions, reused IDs or the global
reservation. Async rejections appear in operation status. The original actor can
still read their operation after self-demotion.

The UI retains the operation ID in localStorage scoped to actor and editor. The
standalone operation page survives cargo deletion. Rejected/conflicting saves
retain entered values. Completion reloads the server version. ID-token changes
update the presented permissions, but already-issued tokens are not revoked by
this feature; existing sessions do not lose access immediately.

## Activation order (human-operated; not executed by this change)

Activate during a coordinated maintenance window with access administration
paused: (1) provision the declared Enterprise `usuarios.cargos` array index,
(2) activate the integrations backend and storage-codebase worker, trigger, queue
and watchdog with their existing service-account invocation policy, (3) activate
the matching web client, (4) activate both environments' appropriate generated
rules, then verify and reopen access administration. Staging uses its staging
rules; production must never receive `firestore.e2e.rules`.

The old web client writes directly and cannot remain an authorization writer
once coordination starts. Keep administration paused throughout activation and
rollback; never release a pending reservation merely to roll back a deployment.
No deployment, index creation, production data mutation or migration-window issue
is performed by this PR. Any addition to the curated cutover tracker needs a
separate explicit approval.

## Verification boundaries

Holder pagination explicitly orders by document ID. Its declared index therefore
contains both `cargos CONTAINS` and `__name__ ASCENDING`; this is an explicit query
field, not a copied Standard-edition implicit suffix. Enterprise does not append
that field automatically ([query interface differences](https://docs.cloud.google.com/firestore/native/docs/query-data/understanding-core-pipelines)).
The declaration is covered by a regression test; deployment and measurement of
the actual Enterprise query plan remain part of coordinated activation.

Stored authorization fields are parsed independently of presentation fields.
Malformed flags, role references or masks stop the operation and identify the
affected holder; they are never silently skipped or interpreted as truthy values.
Editor reads tolerate unrelated legacy presentation data, using a shared browser
and server decoder. Commands still require valid write schemas; commit preserves
stored audit values and extra fields without full-parsing the old document.

A slice that runs out of time before making progress is retried automatically
under the existing finite attempt limit. Repeated timeouts eventually require
manual recovery while retaining the reservation and cursor.

Unit tests exercise multiple pages/slices, full-holder authorization, replay,
lease ownership, idempotency, partial failures and eligibility. The storage lane's
named Firestore emulator validates actual transactions and queries; Auth and task
transport remain test seams (there is no Cloud Tasks emulator in that lane).
Emulated creation triggers deliberately do not enqueue real Cloud Tasks. Generated
rules are tested separately in the existing rules emulator lane, including denied
superuser writes. Browser component tests cover operation states and token renewal;
the staging Playwright flow runs the branch HTTP backend and delivers only its own accepted operations to the real worker core from the test runner, using staging Auth and Firestore. Its actor fixture has both source authorization and claims; parallel runs honor the global reservation and retry only explicit busy conflicts. Production task scheduling has no test mode.
The emulator cannot verify Enterprise index billing or production IAM/deployment.
