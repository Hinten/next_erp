# Repair Windows sandbox and worktree access

The `next-erp` profile is defined in this project's `.codex/config.toml`.
It grants minimal runtime reads and writes to the active workspace and temporary
directories. Workspace metadata stays read-only and sensitive paths stay denied.
The `.codex/node_modules` and `.codex/.turbo` subtrees are writable so pnpm can
install dependencies and Turbo can write task logs without making the Codex
configuration or scripts writable. Shell defaults disable Turbo telemetry so
routine checks need no analytics-domain access.
Package downloads use a network proxy that allows `registry.npmjs.org`; MXC also
requires local binding for its managed network. Other public hosts require their
own authorization. This avoids resolving unrelated mapped shares during startup.

Keep this portable configuration in the project. Machine-specific tool and linked
Git metadata permissions belong in `%USERPROFILE%\.codex\config.toml`. Neither
utility changes drive mappings, grants an entire drive, or modifies Windows ACLs.

## Host runtime and linked Git metadata

Run the host helper from a normal external PowerShell window. Its default mode
reports the proposed paths without changing files; `--apply` explicitly merges
the verified grants into the existing `next-erp` profile in the user config.
Codex requires an explicit global `default_permissions` whenever global named
permission profiles exist. A project selector alone does not satisfy that rule
for other projects. The helper refuses missing defaults and legacy sandbox
settings instead of creating a configuration that breaks another project.

```powershell
node .codex/configure-host-access.mjs
node .codex/configure-host-access.mjs --apply
```

If the global default is absent, choose it explicitly before applying any host
grants. The following opt-in selects the built-in workspace profile for projects
without their own selection; this repository keeps its project-level `next-erp`
selection. Review that effect on other projects first:

```powershell
node .codex/configure-host-access.mjs --default-permissions :workspace
node .codex/configure-host-access.mjs --apply --default-permissions :workspace
```

An existing different default is preserved and reported as a conflict. The host
helper never selects a global fallback automatically. A user-level permissions
table without a default caused another project's `failed to load workspace
requirements` error during acceptance; restoring the checked backup restored
that project. Unit tests alone do not establish Desktop configuration loading.

The helper grants read access to the existing bundled runtime dependencies and,
when present, the user's `.gitconfig`. It grants write access to this repository's
verified common Git directory so linked worktrees can update indexes, objects and
branch references. A worktree's `.git` file only points at that external metadata;
making the pointer readable does not make the target accessible. The primary
checkout and unrelated repositories receive no new access.

Host configuration backups and a checked restore command are reported by the
helper under `%USERPROFILE%\.codex\backups\host-access\`, outside the readable
workspace. Preserve the backup until restart acceptance passes. Conflicting custom
rules require review rather than being silently widened. Diagnostics report
permission paths, not Git configuration contents, credentials or remote URLs.

The same bundled dependencies subtree contains PowerShell, Git, Node, Python and
the pnpm shims. A denied executable is different from a missing installation.
Switching the integrated terminal to Git Bash does not change the agent profile
or grant access to Git's shared metadata.

## Project profile recovery

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

Only recognized historical permission sections are changed, including the earlier
registry profiles that kept dependencies or task logs read-only. Other settings, branch
names and uncommitted work are preserved. Missing, redirected or custom
configurations are reported instead of rewritten. Concurrent edits fail the
locked hash check; restoration also refuses to overwrite subsequent edits.
If a disk error interrupts a write, the original backup remains available;
inspect the file and recover it manually rather than bypassing the hash guard.

## WSL local environment setup

In the desktop local environment settings, use this Linux setup script from the
worktree root with the `next-erp-wsl` permission profile:

```bash
/bin/bash --login -c '
set -euo pipefail
mkdir -p .codex/node_modules .codex/.turbo
node .codex/setup-worktree.mjs
'
```

Install native Linux Node and Git once in the WSL distribution. On this host,
Node 24.22.0 and Git 2.55.0 have passed validation. The setup helper obtains the
exact pnpm version from `package.json`, installs with `--frozen-lockfile`, and
keeps npm and pnpm caches under the current worktree's ignored `out/` directory.
It supplies cache locations through environment variables: pnpm 11 does not
accept `--state-dir` as an install flag.

New worktrees must start from a revision containing these repaired files.
Changes left only in this checkout do not propagate automatically.

The project delivery instructions permit the connected GitHub plugin to publish
authorized changes to this repository's `codex/*` branches. Connector writes must
verify their destination, branch and expected remote head because local shell
hooks do not run for those calls. This path works independently of the shell's
registry-only network policy; native Git publishing retains its guarded command.

## Acceptance checks

On WSL, use a login Bash for Node/pnpm checks: `/bin/bash --login -c 'pnpm --version'`. The desktop executor observed during validation starts a non-login shell even when its `login` option is true, so a read grant for the standard Ubuntu `~/.profile` alone does not initialize `~/.local/bin`. This launcher requirement applies to the Node tool commands; native Git publishing keeps its exact authorized command form.

1. Apply host grants and repair one selected worktree. Inspect `/status` and
   `/debug-config` from Codex CLI in an external terminal to compare the effective
   profiles. An `X:` entry in a launcher's path list does not establish that project
   code uses the drive. Trace that entry to its actual policy layer before changing
   anything; preserve unrelated mapped shares.
2. Restart Codex manually and resume the repaired chat. Explicitly select the
   named `next-erp` permission profile in that chat and retry a message: opening
   a chat successfully does not prove that its next turn uses the repaired
   profile. A saved generic workspace policy can still carry broad root reads.
   If startup fails, use the printed recovery manifest from external PowerShell.
3. Ask Codex to run the following inside the sandbox, without broader execution:

   ```powershell
   Write-Output SANDBOX_OK
   Get-Command git | Select-Object -ExpandProperty Source
   git --version
   git rev-parse --show-toplevel --git-dir --git-common-dir
   git --no-optional-locks status --short --branch
   git cat-file -e HEAD
   node --version
   pnpm --version
   node --test .codex/setup-worktree.test.mjs
   pnpm view pnpm@11.2.2 version
   pnpm install --frozen-lockfile
   node .codex/setup-worktree.mjs
   pnpm --filter @delfrance/codex-config test
   ```

   Node must be at least 22 and pnpm must match the exact `packageManager` version
   in the root manifest (currently `11.2.2`). Setup installs with a frozen lockfile
   and routes npm/pnpm writable state into ignored `out/codex-sandbox-cache/`.
   Run ordinary installs from the repository root: the profile's cache defaults
   are command-directory relative, while setup passes absolute cache paths.
   pnpm 11 reads `pnpm_config_*` settings; `npm_config_cache` applies to npm/npx.
   A passed `node -e` probe does not verify ordinary script loading. If Git reports
   dubious ownership after file permissions work, review that exact repository's
   trust setting; permission denials do not justify a global ownership bypass.

4. Test harmless workspace writes and denials with synthetic fixtures created
   before starting the sandboxed process. Preserve real credentials and Git
   metadata. Validate Git writes during the next authorized commit; existing
   publishing approvals continue to apply.
5. Repair the remaining recognized worktrees and retain the per-worktree report.
   Until the configuration change is merged into the default branch, select the
   branch containing it when creating a new worktree. After merge and refreshing
   the remote default branch, verify new-worktree startup from that branch too.
6. Before accepting a global host overlay, reopen a project without a project
   permission selection as well as an existing unrelated project. Confirm both
   load and execute a harmless command. On this host those regression checks are
   Luratha Social Media and `fiap2_fase6_cap1`.

Repairing existing worktrees does not change the commit used for future ones.
Starting from an older `main` before the fix is merged copies the old profile
and can reproduce the same TRUENAS error. Keep the selected starting branch and
the selected named permission profile explicit during acceptance testing.

Configuration unit tests and CI do not replace the manual restart and desktop
chat-resumption checks. Host edits require the explicit helper invocation above;
the worktree recovery utility remains separate and never edits user configuration.

## Current MXC limitation

The installed desktop app forces the experimental `prefer_mxc` feature. With
minimal runtime reads, Node 22's ordinary script entrypoint loader fails when it
calls `realpath`/`lstat` on `C:\`, even though instruction reads, Node evaluation,
workspace writes and sensitive-path denials work. This was reproduced with the
actual app-bundled runtime, using `node out/.../probe.cjs` versus the same probe
passed through `node -e`.

The repair retains the strict profile and adds only verified host paths. If
ordinary scripts still fail after the runtime grant, report the remaining MXC
compatibility problem rather than granting drive-wide access or marking the fix
complete. Run recovery from a normal external PowerShell window when the current
session cannot launch its configured runtime. A passed `node -e` probe does not
establish that package-manager scripts work inside MXC.
