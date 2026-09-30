---
name: github-workflow-routing
description: Route GitHub-hosted issues, pull requests, reviews, Actions/CI, and remote repository metadata through the connected GitHub plugin, and follow pull requests created by Codex through bounded CI and review-fix cycles. Do not use for purely local Git operations.
metadata:
  short-description: Route GitHub work and finish PR feedback loops
---

# GitHub Workflow Routing

Prefer the connected GitHub plugin for server-side GitHub state. Use the CLI fallback below when the connector is unavailable.

## Route GitHub tasks

- Apply this workflow to GitHub issues, pull requests, review threads, Actions or CI, and other remote repository metadata. A bare reference such as `#607` counts when the current repository has a GitHub remote.
- Resolve the repository from an explicit user reference first; otherwise read the current repository's `origin` and normalize its HTTPS or SSH GitHub URL.
- Use available `github.*` tools before web search, browser automation, `curl`, or the `gh` CLI. If the tools are not visible, look up the installed GitHub plugin before concluding it is unavailable.
- Treat a successful GitHub tool call as proof that the connection is available. Do not infer absence solely from a canonical plugin-ID permission lookup reporting `not_installed`; verify by plugin name or an actual GitHub tool call.
- Fall back only after the connector is absent or an actual connector call fails. State the failure and the fallback used.
- Use local Git for working-tree state, local diffs, commits, and branches. Do not invoke the plugin for a purely local Git request.
- Do not repeat a successful connector lookup through a second source unless verification is materially necessary.

## Windows connector failure and CLI fallback

An installed, connected GitHub plugin can still expose no callable tools when
Codex's `codex_apps` MCP service fails to initialize. On 2026-09-30, the desktop
logs reported `server=codex_apps`, `status=failed`, and
`error decoding response body` during the initialize request across multiple
chats. Restarting Windows and signing out and back in did not recover it.
This identifies the failed connector startup; the underlying response-decoding
cause remains unconfirmed.

When tools are missing, inspect available plugin discovery or permission tools
and, if needed, matching startup errors in the latest desktop log under
`%LOCALAPPDATA%\Codex\Logs\YYYY\MM\DD`. Inspect only relevant lines and redact
credentials before sharing evidence. A tool appearing in a catalog is not proof
that a call can execute. State the connector failure, then continue the
authorized GitHub task through `gh` and local Git.

- Try a scoped read such as
  `gh pr view <number> --repo <owner/repo> --json number,url,state`.
- If sandboxed `gh` reports `Access is denied` for its configuration, or remote
  Git reports `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`,
  retry the scoped command through `exec_command` with
  `sandbox_permissions: "require_escalated"` and a task-specific justification.
  On this Windows host, sandboxed commands ran as `CodexSandboxOffline`; approved
  commands ran as the signed-in Windows user and could use the existing GitHub
  authentication. If the retry still fails, use `whoami` to verify the execution
  identity and report the actual error. Honor any approval rejection.
- Reuse the existing user authentication through the approved command path.
  Do not copy tokens into the repository, expose credential-file contents, or
  broaden filesystem ACLs to make the sandbox read credentials.
- For authorized publication of an existing local commit, use `git push` to
  preserve its SHA, then `gh pr create --draft` when a draft is requested. Use
  `--body-file` for a multiline description. Read CI with `gh pr checks` or
  targeted `gh api` calls, and attach any created PR to the current chat.
- A successful read and repository `push` permission establish a usable CLI
  path; they do not prove a push or PR creation was executed. Publish only when
  the user's task authorizes it. Diagnostic tasks remain read-only.

The fallback changes the tool used, not the task's scope or approval policy.
Apply the same CI/review follow-through and stopping conditions below. If no
permitted execution path works, report the blocker and the relevant startup
error rather than repeatedly requesting a restart or sign-in.

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
