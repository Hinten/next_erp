import type { z } from 'zod';
import type { DomainSchema } from '@delfrance/schemas';
import { resolvePermissions, type ClaimCheck } from './claims-map';
import { clausesForSchema } from './constraints';

/**
 * Assembles the ruleset body: the `p()` claim helper, whitelisted field
 * validators, one flat match block per DomainSchema, hand-written extra
 * blocks, and one collection-group read block per subcollection leaf.
 *
 * Everything is sorted (validators by name, blocks by path, group blocks by
 * leaf) so output is deterministic — the committed firestore.rules diff and
 * the snapshot test are the review artifacts for any schema change.
 */
export interface ExtraMatchBlock {
  path: string;
  body: ReadonlyArray<string>;
}

const SEGMENT_LITERAL = /^[A-Za-z0-9_-]+$/;
const SEGMENT_PLACEHOLDER = /^\{[A-Za-z][A-Za-z0-9]*\}$/;

export function emitRules(
  domains: ReadonlyArray<DomainSchema<z.ZodTypeAny>>,
  extraBlocks: ReadonlyArray<ExtraMatchBlock>,
  validatorWhitelist: ReadonlySet<string>,
): string {
  validatePaths(domains);

  const validators = new Map<string, string[]>(); // name -> clause exprs
  const flatBlocks: string[][] = [];
  const groupReads = new Map<string, ClaimCheck[]>(); // leaf -> read checks (union)
  const topLevel = new Set<string>(); // single-segment collection names

  // Extra blocks are hand-written top-level collections (e.g. grupoEconomico);
  // count their first segment so a leaf can never silently collide with them.
  for (const extra of extraBlocks) topLevel.add(extra.path.split('/')[0]!);

  for (const domain of [...domains].sort(byPath)) {
    const { collectionPath } = domain.meta;
    const perms = resolvePermissions(domain.meta);
    const serverOwned = domain.meta.serverOwned ?? false;

    if (serverOwned && validatorWhitelist.has(collectionPath)) {
      throw new Error(
        `${collectionPath}: serverOwned collections cannot be validator-whitelisted — ` +
          `Admin SDK writes bypass rules entirely, so a field validator would never run.`,
      );
    }
    if (serverOwned && (domain.meta.serverOwnedFields?.length ?? 0) > 0) {
      throw new Error(
        `${collectionPath}: serverOwned is exclusive with serverOwnedFields — the whole ` +
          `collection is already client-write-denied, a per-field guard is meaningless.`,
      );
    }

    let validatorName: string | null = null;
    if (!serverOwned && validatorWhitelist.has(collectionPath)) {
      validatorName = `v_${collectionPath
        .split('/')
        .filter((s) => !s.startsWith('{'))
        .join('_')}`;
      const clauses = clausesForSchema(domain.schema);
      if (clauses.length === 0) {
        throw new Error(`${collectionPath}: whitelisted for validation but emitted no clauses`);
      }
      validators.set(
        validatorName,
        clauses.map((cl) => cl.expr),
      );
    }

    flatBlocks.push(
      matchBlock(
        collectionPath,
        perms,
        validatorName,
        domain.meta.serverOwnedFields ?? [],
        serverOwned,
      ),
    );

    if (collectionPath.includes('/') && !domain.meta.noCollectionGroupRead) {
      const leaf = collectionPath.split('/').at(-1)!;
      // Distinct collections may share a subcollection leaf name — the
      // legacy-aligned `produtos/{id}/imposto` + `categorias/{id}/imposto`
      // both end in `imposto`. A `{path=**}/<leaf>` group block cannot tell
      // the parents apart, so its read check is the UNION of every owning
      // collection's read claim: holding ANY of them group-reads ALL docs
      // under that leaf name. Deliberate, read-only widening (writes only
      // exist on the flat per-parent blocks above); claims are deduped here
      // and sorted at emission for deterministic output.
      const checks = groupReads.get(leaf) ?? [];
      if (!checks.some((c) => c.claim === perms.read.claim && c.k === perms.read.k)) {
        checks.push(perms.read);
      }
      groupReads.set(leaf, checks);
    } else if (!collectionPath.includes('/')) {
      topLevel.add(collectionPath);
    }
  }

  // rules_version '2' recursive wildcards match an empty prefix, so a
  // `match /{path=**}/<leaf>/{docId}` group-read block ALSO matches a top-level
  // collection literally named <leaf> — granting it the leaf's read bit. Today
  // no leaf collides; make that structural so a future colliding top-level
  // collection fails generation instead of silently widening reads on deploy.
  for (const leaf of groupReads.keys()) {
    if (topLevel.has(leaf)) {
      throw new Error(
        `collection-group leaf '${leaf}' collides with a top-level collection of the same name; ` +
          `the recursive '{path=**}/${leaf}' read block would also grant reads on /${leaf}/{docId}. ` +
          `Rename one of them before this can be deployed.`,
      );
    }
  }

  const lines: string[] = [];
  lines.push("rules_version = '2';");
  lines.push('service cloud.firestore {');
  lines.push('  match /databases/{database}/documents {');
  lines.push('    // Claim bit test without bitwise operators (rules CEL has none):');
  lines.push('    // d_* claims are small ints, k is 1 (read), 2 (write) or 4 (delete).');
  lines.push('    function p(d, k) {');
  lines.push('      return request.auth != null && (request.auth.token.get(d, 0) / k) % 2 == 1;');
  lines.push('    }');
  lines.push('');
  lines.push('    // Break-glass super user: the dedicated `su` claim short-circuits the');
  lines.push('    // permission + tenancy checks below (field validators still apply). Minted');
  lines.push('    // server-side only for usuario.isSuperUser accounts — never self-grantable.');
  lines.push('    function isSuperUser() {');
  lines.push("      return request.auth != null && request.auth.token.get('su', false) == true;");
  lines.push('    }');

  for (const name of [...validators.keys()].sort()) {
    const clauses = validators.get(name)!;
    lines.push('');
    lines.push(`    // d = incoming document, c = touched keys (keys() on create,`);
    lines.push(`    // diff().affectedKeys() on update — legacy docs stay updatable).`);
    lines.push(`    function ${name}(d, c) {`);
    lines.push(`      return ${clauses.join('\n        && ')};`);
    lines.push('    }');
  }

  for (const block of flatBlocks) {
    lines.push('');
    lines.push(...block);
  }

  for (const extra of [...extraBlocks].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push('');
    lines.push(`    match /${extra.path} {`);
    for (const bodyLine of extra.body) lines.push(`      ${bodyLine}`);
    lines.push('    }');
  }

  if (groupReads.size > 0) {
    lines.push('');
    lines.push('    // Collection-group reads (client groupQuery / collectionGroup).');
    lines.push('    // A leaf shared by several collections carries the UNION of their');
    lines.push('    // read claims (see the dedupe note in emitRules).');
    for (const leaf of [...groupReads.keys()].sort()) {
      const checks = [...groupReads.get(leaf)!].sort(
        (a, b) => a.claim.localeCompare(b.claim) || a.k - b.k,
      );
      const ors = checks.map((c) => `p('${c.claim}', ${c.k})`).join(' || ');
      lines.push(`    match /{path=**}/${leaf}/{docId} {`);
      lines.push(`      allow read: if isSuperUser() || ${ors};`);
      lines.push('    }');
    }
  }

  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

function matchBlock(
  collectionPath: string,
  perms: { read: ClaimCheck; write: ClaimCheck; delete: ClaimCheck },
  validatorName: string | null,
  serverOwnedFields: ReadonlyArray<string>,
  serverOwned: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`    match /${collectionPath}/{docId} {`);
  lines.push(`      allow read: if isSuperUser() || p('${perms.read.claim}', ${perms.read.k});`);

  if (serverOwned) {
    // Written EXCLUSIVELY by the Admin SDK (a trigger, never a client) — no
    // su bypass, unlike the per-field serverOwnedFields guard below.
    lines.push('      // Server-owned collection — Admin SDK only, no su bypass.');
    lines.push('      allow create, update, delete: if false;');
    lines.push('    }');
    return lines;
  }

  // Super user bypasses the write-permission check; the field validator (when
  // present) is ANDed OUTSIDE the bypass, so even a super user writes valid data.
  const w = `(isSuperUser() || p('${perms.write.claim}', ${perms.write.k}))`;

  // Server-owned fields (meta.serverOwnedFields): clients may CREATE them only
  // as null (the client parse fills `.default(null)`) and may never touch them
  // on UPDATE — only the Admin SDK (rules-bypassing) writes real values. Like
  // the validators, ANDed OUTSIDE the su bypass.
  const owned = [...serverOwnedFields].sort();
  const ownedList = owned.map((f) => `'${f}'`).join(', ');
  const createGuard = owned
    .map(
      (f) =>
        `(!request.resource.data.keys().hasAny(['${f}']) || request.resource.data.get('${f}', null) == null)`,
    )
    .join(' && ');
  const updateGuard =
    owned.length > 0
      ? `!request.resource.data.diff(resource.data).affectedKeys().hasAny([${ownedList}])`
      : '';

  if (validatorName) {
    const createExtra = createGuard ? ` && ${createGuard}` : '';
    const updateExtra = updateGuard ? ` && ${updateGuard}` : '';
    lines.push(
      `      allow create: if ${w} && ${validatorName}(request.resource.data, request.resource.data.keys())${createExtra};`,
    );
    lines.push(
      `      allow update: if ${w} && ${validatorName}(request.resource.data, request.resource.data.diff(resource.data).affectedKeys())${updateExtra};`,
    );
  } else if (owned.length > 0) {
    lines.push(`      allow create: if ${w} && ${createGuard};`);
    lines.push(`      allow update: if ${w} && ${updateGuard};`);
  } else {
    lines.push(
      `      allow create, update: if isSuperUser() || p('${perms.write.claim}', ${perms.write.k});`,
    );
  }
  lines.push(
    `      allow delete: if isSuperUser() || p('${perms.delete.claim}', ${perms.delete.k});`,
  );
  lines.push('    }');
  return lines;
}

function validatePaths(domains: ReadonlyArray<DomainSchema<z.ZodTypeAny>>): void {
  const seen = new Set<string>();
  for (const { meta } of domains) {
    const path = meta.collectionPath;
    if (seen.has(path)) throw new Error(`duplicate collectionPath: ${path}`);
    seen.add(path);
    for (const segment of path.split('/')) {
      if (segment === '{docId}') {
        throw new Error(`${path}: '{docId}' is reserved for the generated document wildcard`);
      }
      if (!SEGMENT_LITERAL.test(segment) && !SEGMENT_PLACEHOLDER.test(segment)) {
        throw new Error(`${path}: segment '${segment}' is not a literal or {placeholder}`);
      }
    }
  }
}

function byPath(a: DomainSchema<z.ZodTypeAny>, b: DomainSchema<z.ZodTypeAny>): number {
  return a.meta.collectionPath.localeCompare(b.meta.collectionPath);
}
