# tools/migrations/

Reserved for **destructive** data migrations introduced in Phase 6+ (denormalizations breaking the Flutter app's reads, etc.). Empty until then.

Migrations should:

1. Be idempotent (safe to re-run).
2. Take an explicit `--project` flag — never default to a production project.
3. Dry-run by default; require `--apply` to write.
4. Log every change to a timestamped file in `out/`.
