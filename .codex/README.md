# Recover Windows worktree startup

The `next-erp` profile is defined in this project's `.codex/config.toml`.
It grants minimal runtime reads and writes to the active workspace and temporary
directories. Metadata stays read-only and sensitive paths stay denied. This
avoids resolving unrelated mapped shares during MXC startup.

Keep this configuration in the project. Recovery does not replace the global
`%USERPROFILE%\.codex\config.toml`, change drive mappings, or modify Windows ACLs.

Run the following commands from the primary checkout in normal PowerShell. Node
and Git are required; installed project dependencies are not. Apply and restore
use native Windows file locking. Read-only inventory also works on other platforms.

```powershell
# Inspect every registered worktree without changing files.
node .codex/repair-worktree-config.mjs

# Repair one explicitly selected worktree. Repeat --worktree for more targets.
node .codex/repair-worktree-config.mjs --apply --worktree "C:\Users\Lucas\.codex\worktrees\d042\next_erp"

# Restore using the absolute manifest path printed by the repair command.
node .codex/repair-worktree-config.mjs --restore "C:\path\to\manifest.json"
```

Each repair stores original bytes and SHA-256 hashes under the primary
checkout's gitignored `out/codex-sandbox-repair/<run-id>/`. Keep the backup and
manifest together until restart and chat-resumption checks pass. Rollback can
run from an external PowerShell window even if Codex cannot open.

Only the recognized old permission sections are changed. Other settings, branch
names and uncommitted work are preserved. Missing, redirected or custom
configurations are reported instead of rewritten. Concurrent edits fail the
locked hash check; restoration also refuses to overwrite subsequent edits.
If a disk error interrupts a write, the original backup remains available;
inspect the file and recover it manually rather than bypassing the hash guard.

## Acceptance checks

1. Repair one worktree first. Confirm instructions load, Node runs and a harmless
   workspace file can be created and removed with the actual Windows sandbox.
   Execute the probe with `node -e` (see the MXC limitation below); testing only
   `node --version` does not verify filesystem operations.
2. Test denials using synthetic fixtures, without reading real credentials or
   modifying real Git metadata. The unreachable mapped share must remain outside
   the effective sandbox paths.
3. Restart Codex manually and resume the repaired chat. Explicitly select the
   named `next-erp` permission profile in that chat and retry a message: opening
   a chat successfully does not prove that its next turn uses the repaired
   profile. A saved generic workspace policy can still carry broad root reads.
   If startup fails, use the printed recovery manifest from external PowerShell.
4. Repair the remaining recognized worktrees and retain the per-worktree report.
5. Until the validated fix reaches `main`, explicitly start new worktrees from
   `codex/fix-sandbox-read-scope`. After the owner merges the PR and `origin/main`
   is refreshed, verify creation from the default branch as well.

Repairing existing worktrees does not change the commit used for future ones.
Starting from an older `main` before the fix is merged copies the old profile
and can reproduce the same TRUENAS error. Keep the selected starting branch and
the selected named permission profile explicit during acceptance testing.

Configuration unit tests and CI do not replace the manual restart and desktop
chat-resumption checks. Automatic global-state edits and automatic app restarts
are not part of this repair.

## Current MXC limitation

The installed desktop app forces the experimental `prefer_mxc` feature. With
minimal runtime reads, Node 22's ordinary script entrypoint loader fails when it
calls `realpath`/`lstat` on `C:\`, even though instruction reads, Node evaluation,
workspace writes and sensitive-path denials work. This was reproduced with the
actual app-bundled runtime, using `node out/.../probe.cjs` versus the same probe
passed through `node -e`.

The project-only repair deliberately retains the strict profile. It does not
grant drive-wide access or change the app's global MXC preference. Run this
recovery utility from a normal external PowerShell window, outside the Codex
sandbox. Ordinary Node script commands inside MXC may still require an approved
execution outside the sandbox until that runtime limitation is fixed. A passed
`node -e` probe does not establish that package-manager scripts work inside MXC.
