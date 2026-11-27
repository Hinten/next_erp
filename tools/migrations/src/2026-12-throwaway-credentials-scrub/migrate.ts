/* eslint-disable no-console -- CLI script: stdout is the interface */
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FieldValue } from 'firebase-admin/firestore';

import { TARGET_DATABASE_ID, credentialCollectionIds } from '@delfrance/legacy-mirror/mirror';
import { projectBoundDb } from '../admin';
import { isMainModule } from '../runner';
import { credentialDocuments, fieldsToScrub, parseScrubArgs } from './transform';

/**
 * Delete every legacy credential from a THROWAWAY test project — see transform.ts
 * and `throwaway-credentials-scrub.README.md`. Run it after the seed import and
 * before deploying anything to that project.
 *
 * Cost: one collection-group scan per credential subcollection id (a handful of
 * small groups) and one scan of `integracao`, plus one delete per credential.
 */
async function main(): Promise<void> {
  const args = parseScrubArgs(process.argv.slice(2));
  const db = projectBoundDb({
    projectId: args.projectId,
    serviceAccountPath: args.serviceAccountPath,
    appName: 'throwaway-credentials-scrub',
    databaseId: TARGET_DATABASE_ID,
  });

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolve(
    outDir,
    `${stamp}-throwaway-credentials-scrub${args.apply ? '' : '-dryrun'}.jsonl`,
  );
  const log = createWriteStream(logPath, { flags: 'a' });

  let documents = 0;
  for (const id of credentialCollectionIds()) {
    // Keys only: the scan needs the paths, never the secrets themselves.
    const snap = await db.collectionGroup(id).select().get();
    for (const path of credentialDocuments(snap.docs.map((d) => d.ref.path))) {
      documents += 1;
      log.write(`${JSON.stringify({ kind: args.apply ? 'deleted' : 'would-delete', path })}\n`);
      // recursiveDelete: a credential document's own subcollections go with it.
      if (args.apply) await db.recursiveDelete(db.doc(path));
    }
  }

  let fields = 0;
  const integracoes = await db.collection('integracao').get();
  for (const doc of integracoes.docs) {
    const drop = fieldsToScrub(doc.ref.path, doc.data());
    if (drop.length === 0) continue;
    fields += drop.length;
    log.write(
      `${JSON.stringify({ kind: args.apply ? 'scrubbed' : 'would-scrub', path: doc.ref.path, fields: drop })}\n`,
    );
    if (args.apply) {
      await doc.ref.update(Object.fromEntries(drop.map((f) => [f, FieldValue.delete()])));
    }
  }

  log.end();
  console.log(
    `${args.apply ? '' : 'dry-run: '}${documents} credential document(s), ` +
      `${fields} credential field(s) on integracao docs${args.apply ? ' removed' : ' found'}.`,
  );
  if (!args.apply) console.log('Nothing was written. Re-run with --apply.');
  console.log(`log: ${logPath}`);
}

if (isMainModule(import.meta.url)) {
  await main();
}
