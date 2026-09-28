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
