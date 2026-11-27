# legacy-mirror-replay

`src/2026-12-legacy-mirror-replay/` — closes the gap the seed import leaves behind
the one-way mirror (ADR 0013, amendment 2026-11-26;
[`apps/legacy-mirror/functions/DEPLOY.md`](../../apps/legacy-mirror/functions/DEPLOY.md)).

> ⚠️ **Human-run, inside the migration runbook (#1208).** It reads the LEGACY
> production project and writes the NEW one. Agents never run it.

## Why it exists

The mirror is deployed **before** the export's `--snapshot-time` T0, so every
legacy change after T0 already has a watermark in `_mirrorWatermarks`. The
managed import then writes every document as it was at T0, **over** the newer
versions the mirror had copied, and never touches the watermarks. Those
documents are now older than their watermark says.

The replay re-applies exactly those paths, the watermarks stamped strictly after
T0, through the mirror's own `mirrorPath`. It re-reads the current legacy
document and uses the same guard, so:

- it is safe while the mirror is live (whichever copy is newer wins);
- running it twice is harmless (the second run re-applies equal stamps);
- nothing changed at or before T0 is touched, so its cost follows the changes
  made during the export and import, not the size of the database.

It is not a full diff and does not need one: deletes after T0 also have
watermarks (stamped with the read time of the absence), so they are replayed too.

## Run

Two service accounts, each matched against its own project:

```bash
# Dry-run: lists the paths it would replay, writes nothing.
pnpm --filter @delfrance/migrations migrate:legacy-mirror-replay \
  --source-project <LEGACY> --source-service-account <legacy-sa.json> \
  --project <NEW> --service-account <new-sa.json> \
  --since 2026-12-17T03:00:00Z --credentials deny   # the mirror's own policy

# The same, with --apply, AFTER the import has finished.
pnpm --filter @delfrance/migrations migrate:legacy-mirror-replay ... --apply
```

`--credentials` must be the `LEGACY_MIRROR_CREDENTIALS` the mirror runs with
(`deny` for a test project, `copy` for the real migration). A replay under the
other policy would undo what the mirror decided.

`--since` is the export's `--snapshot-time`, a whole minute with an explicit zone.
An offset-less time is refused, because it would be read in the machine's zone.

## Verify

```bash
pnpm --filter @delfrance/migrations migrate:legacy-mirror-replay \
  --source-project <LEGACY> --source-service-account <legacy-sa.json> \
  --project <NEW> --service-account <new-sa.json> \
  --verify --groups nfev4,estoques,historicoEstoque,pagamentos,enderecos
```

It counts every root collection on both sides plus each collection group named
in `--groups`, and exits 1 if any differ. `_mirrorWatermarks` is left out.

- Run it after the replay, and again on cutover day once the mirror has drained.
- While legacy is still being written, small differences are expected, because
  the two counts are not taken at the same instant. Only the post-freeze run has
  to match exactly.
- Cost: on Standard a `count()` bills one read per 1,000 index entries. On
  Enterprise it scans the collection, so a 10 GiB database costs well under $1 per
  full verify.

## Log

`out/<stamp>-legacy-mirror-replay[-dryrun].jsonl`: one line per path —
`would-replay`, `applied`, or `skipped` (a newer version was already there).
