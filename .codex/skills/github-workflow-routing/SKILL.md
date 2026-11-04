---
name: github-workflow-routing
description: Route GitHub-hosted issues, pull requests, reviews, Actions/CI, and remote repository metadata through the connected GitHub plugin, and follow pull requests created by Codex through bounded CI and review-fix cycles. Do not use for purely local Git operations.
metadata:
  short-description: Route GitHub work and finish PR feedback loops
---

# GitHub Workflow Routing

Use the connected GitHub plugin as the source of truth for server-side GitHub state.

## Route GitHub tasks

- Apply this workflow to GitHub issues, pull requests, review threads, Actions or CI, and other remote repository metadata. A bare reference such as `#607` counts when the current repository has a GitHub remote.
- Resolve the repository from an explicit user reference first; otherwise read the current repository's `origin` and normalize its HTTPS or SSH GitHub URL.
- Use available `github.*` tools before web search, browser automation, `curl`, or the `gh` CLI. If the tools are not visible, look up the installed GitHub plugin before concluding it is unavailable.
- Treat a successful GitHub tool call as proof that the connection is available. Do not infer absence solely from a canonical plugin-ID permission lookup reporting `not_installed`; verify by plugin name or an actual GitHub tool call.
- Fall back only after the connector is absent or an actual connector call fails. State the failure and the fallback used.
- Use local Git for working-tree state, local diffs, commits, and branches. Do not invoke the plugin for a purely local Git request.
- Do not repeat a successful connector lookup through a second source unless verification is materially necessary.

## Publish authorized project changes

This project's `.codex/config.toml` permits publication through the connected
GitHub plugin for the authorized task. Shell hooks do not run for connector
writes: check the exact repository and `codex/*` task branch in the tool
arguments, publish only the reviewed local changes on the intended parent tree,
and use the expected remote head when updating an existing ref. Keep unrelated
refs and files unchanged. Use the guarded exact command in the project config
when publishing through native Git.

## WSL execution and Windows desktop troubleshooting

The desktop app can run on Windows while this repository's agent executes in
WSL. Use native Linux tools and paths for local Git in that case. A failed local
command does not establish that the GitHub plugin connection is unavailable;
check the connector separately before falling back.

For Node-based local checks in this project's WSL environment, use
`/bin/bash --login -c` as required by `.codex/config.toml`. Native Git publication
uses the exact authorized command documented there, run on its own. Check the native
Git version and the failing subcommand before adding compatibility workarounds;
`git worktree list --porcelain -z` requires support from the installed Git.
A worktree's `.git` pointer and its shared Git directory need separate filesystem
grants. A more specific read-only mount for the worktree metadata can still
block writes beneath a writable common directory; use bounded approval for the
authorized Git writes instead of broadening filesystem grants. The host access
procedure is documented in `.codex/README.md`.

A registry-only network profile can allow the GitHub plugin while blocking
native Git transport to `github.com`. Use the authorized connector path in that
case. A local transport denial does not require expanding the sandbox's network
allowlist for connector publication.

Do not assume Windows PowerShell interop is available inside a sandboxed WSL
process. If a host repair requires external Windows PowerShell, prepare the
reviewable repair and follow the documented host procedure.

If the GitHub plugin itself fails while the desktop runs on Windows, the known
`error decoding response body` failure may warrant rechecking Norton's HTTPS
scanning and the `https://chatgpt.com` exclusion. This exception followed by a
normal Codex restart restored access on 2026-10-01 while Codex remained
non-elevated. Verify recovery with an actual GitHub plugin call; local WSL shell,
Git, or permission failures alone do not implicate Norton.

## Complete pull requests created by Codex

When the user asks Codex to create a pull request, treat bounded follow-through on that same pull request as part of the task:

1. Attach the created pull request to the current task when that capability is available.
2. Monitor every required CI check until it passes or a stopping condition below is reached. While CI is running, also refresh reviews, review threads, and actionable comments.
3. If a failure is caused by the pull request, inspect the evidence, reproduce it when practical, implement an in-scope fix, verify it, push the update, and resume monitoring.
4. If a failure is unrelated, do not change unrelated code. Report the failing check and the evidence that separates it from the pull request.
5. Rerun a possibly flaky failure at most once, only to classify it. Report both the original failure and the rerun result; a repeated failure is reproducible.
6. For a valid review finding, implement and verify the fix, push it, reply in the review thread with the disposition and fixing commit, and resolve the thread only when fully addressed.
7. For invalid, ambiguous, or out-of-scope feedback, reply with evidence. Leave the thread unresolved when reviewer input is still required.
8. After required CI becomes green, perform one final refresh of reviews and threads. If nothing actionable remains, finish without waiting indefinitely for future human feedback.

A request to create a pull request authorizes in-scope fixes needed to make that pull request pass CI and address its review findings. It does not authorize merging the pull request, marking a draft ready, expanding scope, or changing unrelated code. Those actions still require explicit user authorization.

## Stop safely

- Never use unbounded polling, watchers, retries, or review/fix cycles.
- Use each workflow job's declared timeout as the primary bound. When it expires, make one final status check and report the blocker.
- Stop after three consecutive failures to reach GitHub or another required service.
- Stop after three attempted fixes for the same CI failure or review finding without materially new evidence.
- Observable progress or materially new evidence resets only the corresponding consecutive-failure counter.
- On stopping, report the current pull-request state, the evidence, and the attempts already made.
