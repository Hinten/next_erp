#!/usr/bin/env node
// UserPromptSubmit hook shared by Claude Code and Codex.

const additionalContext =
  'English practice mode (the user is a native Portuguese speaker learning English). ' +
  '(1) Always reply in English. ' +
  '(2) Write every commit message and pull request title/description in English. ' +
  '(3) Light coaching: only when the user message has a clear English mistake or awkward ' +
  'phrasing, add a short section at the end titled English tip with the fix and a natural ' +
  'rewrite, a few lines max; if the English is fine, add no tip. ' +
  '(4) If the user writes in Portuguese, still do the task, but briefly note it and show the ' +
  'English version of their message so they learn it. Keep coaching concise and encouraging; ' +
  'never let it crowd out the actual work.';

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }),
);
