// Shared line-scanning primitives for the guards that read `.github/workflows/*`.
//
// ## Why this module exists
//
// Two guards in this directory need to know which jobs a workflow declares, and
// until now each carried its own finder. One was right and one was wrong, and the
// wrong one was wrong in a way that produced a CONFIDENT, SPECIFIC, FALSE report:
//
//     .github/workflows/ci.yml › pull_request runs `turbo run build` without FUNCTIONS_REGION
//
// `pull_request` is not a job. `functions-region-supplied.test.js` located jobs with
//
//     /^ {2}[A-Za-z0-9_-]+:\s*$/
//
// over the WHOLE file, never anchoring to `jobs:`. So `on:`'s sub-keys (`push:`,
// `pull_request:`) parsed as jobs, and the `pull_request` pseudo-job's body ran all
// the way to the first real job — swallowing the `jobs:` line and every comment
// above it. A file-level comment that merely NAMED a scanned command was then
// reported as a job running it without the required variable.
//
// That cost a debugging cycle in #1261 and would have cost the next person one too:
// the message names a job id, so the natural reaction is to go look for that job.
//
// ## Why a line scan and not a YAML parse
//
// ⚠️ `on:` is a YAML 1.1 boolean. js-yaml@3 keys that block as `true`, so a
// parser-based guard reading `doc.on` sees `undefined` for every workflow and
// passes vacuously — the exact silent-green failure these guards exist to prevent.
// A line scan cannot develop that failure mode, so both guards scan, and this
// module is the one implementation they share.
//
// ⚠️ Every caller must hand these functions LF-normalised source. `core.autocrlf=true`
// checks workflows out as CRLF on Windows while CI and the index see LF, and every
// regex here is line-anchored. Both current callers normalise in their own `read()`.

/**
 * The lines of a top-level block (`on:`, `jobs:`), exclusive of the header line.
 *
 * A top-level key is at column 0, so the block ends at the next line starting with
 * a non-whitespace character. Returns `{ header: null, body: [] }` when absent.
 */
export function topBlock(source, key) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(?:${key}|'${key}'|"${key}")\\s*:`).test(l));
  if (start === -1) return { header: null, body: [] };
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return { header: lines[start], body };
}

/**
 * `{ <job id>: <job body> }` for every job in the workflow.
 *
 * ⚠️ Anchored to the `jobs:` block — that is the whole point of this function, and
 * the defect it replaces. A key at job indent ANYWHERE else in the file (notably
 * `pull_request:` under `on:`) is not a job and must never be reported as one.
 *
 * The indent is derived from the block's first real line rather than assumed to be
 * two spaces, so a workflow indented differently still parses. Comment-only lines
 * are skipped when deriving it, since a comment may sit at any depth.
 */
export function jobBlocks(source) {
  const { body } = topBlock(source, 'jobs');
  const firstReal = body.find((l) => l.trim() && !l.trim().startsWith('#'));
  const indent = firstReal ? firstReal.match(/^\s*/)[0] : '  ';
  const idRe = new RegExp(`^${indent}([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*(?:#.*)?$`);

  const jobs = {};
  let current = null;
  for (const line of body) {
    const m = line.match(idRe);
    if (m) {
      current = m[1];
      jobs[current] = [];
    } else if (current) {
      jobs[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

/**
 * The check-run name GitHub publishes for a job: its `name:`, else its bare id.
 *
 * ⚠️ A check-run name carries NO workflow-name prefix, which is why these names
 * must be unique repo-wide and why `ci-lane-gates.test.js` asserts them.
 */
export function checkName(jobId, jobBody) {
  const m = jobBody.match(/^\s{4}name\s*:\s*(.+?)\s*$/m);
  if (!m) return jobId;
  return m[1].replace(/^['"]|['"]$/g, '');
}
