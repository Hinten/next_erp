import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { migrationDb } from '../admin';
import { isMainModule, MigrationArgError, parseArgs, type MigrationArgs } from '../runner';
import { decodeFirestore, encodeFirestore } from './codec';
import { executePlan, validatePlan, verifyPlan, type MigrationStore } from './execute';
import {
  fingerprint,
  planWhatsappMigration,
  WhatsappMigrationError,
  type MigrationDecisions,
  type Raw,
  type SourceDocument,
  type WhatsappMigrationPlan,
} from './transform';

interface Options extends MigrationArgs {
  manifest?: string;
  decisions?: string;
  verify: boolean;
  finalize: boolean;
  writersStopped: boolean;
}

/** Keep package-wide project/credential guards and reject unknown local flags. */
export function parseWhatsappArgs(argv: string[]): Options {
  const shared: string[] = [];
  let manifest: string | undefined;
  let decisions: string | undefined;
  let verify = false;
  let finalize = false;
  let writersStopped = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--manifest' || arg === '--decisions') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new MigrationArgError(`${arg} requires a path`);
      if (arg === '--manifest') manifest = value;
      else decisions = value;
    } else if (arg === '--verify') verify = true;
    else if (arg === '--finalize') finalize = true;
    else if (arg === '--writers-stopped') writersStopped = true;
    else shared.push(arg);
  }
  const parsed = parseArgs(shared);
  if (parsed.targets.length)
    throw new MigrationArgError('--target is not supported by this migration');
  if ((parsed.apply || verify || finalize) && !manifest)
    throw new MigrationArgError('--manifest is required for apply/verify/finalize');
  if (parsed.apply && !writersStopped)
    throw new MigrationArgError('--apply requires --writers-stopped after the operational freeze');
  if (finalize && !parsed.apply) throw new MigrationArgError('--finalize requires --apply');
  if (verify && parsed.apply)
    throw new MigrationArgError('--verify and --apply are separate operations');
  if (manifest && decisions)
    throw new MigrationArgError(
      'Decisions belong in inventory generation, never modify a running manifest',
    );
  if (parsed.reportOnly && manifest)
    throw new MigrationArgError('--report-only and --manifest are separate operations');
  return { ...parsed, manifest, decisions, verify, finalize, writersStopped };
}

const PAGE_SIZE = 300;

/** listDocuments also finds missing parents carrying legacy orphan subcollections. */
async function walkDocument(ref: DocumentReference): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  const snap = await ref.get();
  if (snap.exists) out.push({ path: ref.path, data: encodeFirestore(snap.data()) as Raw });
  for (const collection of await ref.listCollections()) {
    for (const child of await collection.listDocuments()) out.push(...(await walkDocument(child)));
  }
  return out;
}

async function readRoot(db: Firestore, name: string): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = db.collection(name).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs)
      out.push({ path: doc.ref.path, data: encodeFirestore(doc.data()) as Raw });
    if (page.size < PAGE_SIZE) return out;
    cursor = page.docs.at(-1);
  }
}

/** Deliberately restricted roots: never walk integration credential subcollections. */
export async function inventory(db: Firestore): Promise<SourceDocument[]> {
  const out: SourceDocument[] = [];
  for (const root of [
    'clientes',
    'integracao',
    'usuarios',
    'user',
    'whatsappConversas',
    'whatsappIdentidades',
    'whatsappMensagens',
  ]) {
    out.push(...(await readRoot(db, root)));
  }
  for (const root of ['chat', 'whatsappConversaAliases']) {
    for (const ref of await db.collection(root).listDocuments())
      out.push(...(await walkDocument(ref)));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function firestoreStore(db: Firestore): MigrationStore {
  return {
    read: async (path) => {
      const snap = await db.doc(path).get();
      return snap.exists
        ? { data: encodeFirestore(snap.data()) as Raw, version: snap.updateTime }
        : null;
    },
    create: async (path, data) => {
      await db.doc(path).create(decodeFirestore(data, db) as Raw);
    },
    replace: async (path, data, version) => {
      if (!(version instanceof Timestamp))
        throw new WhatsappMigrationError('Precondição updateTime ausente');
      const ref = db.doc(path);
      const current = await ref.get();
      if (!current.updateTime?.isEqual(version))
        throw new WhatsappMigrationError(`Documento mudou: ${path}`);
      const decoded = decodeFirestore(data, db) as Raw;
      const fields = [...new Set([...Object.keys(current.data() ?? {}), ...Object.keys(decoded)])];
      const first = fields.shift();
      if (!first) return;
      const value = (key: string): unknown => (key in decoded ? decoded[key] : FieldValue.delete());
      // FieldPath protects legacy keys containing dots/slashes; a native
      // precondition protects the replacement without delete/create triggers.
      await ref.update(
        new FieldPath(first),
        value(first),
        ...fields.flatMap((key) => [new FieldPath(key), value(key)]),
        { lastUpdateTime: version },
      );
    },
    remove: async (path, version) => {
      if (!(version instanceof Timestamp))
        throw new WhatsappMigrationError('Precondição updateTime ausente');
      await db.doc(path).delete({ lastUpdateTime: version });
    },
    descendantPaths: async (root) =>
      (await walkDocument(db.doc(root))).map((d) => d.path).filter((p) => p !== root),
  };
}

interface ManifestEnvelope {
  fingerprint: string;
  plan: WhatsappMigrationPlan;
}

export function readManifest(path: string, projectId: string): WhatsappMigrationPlan {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ManifestEnvelope;
  if (!parsed.plan || parsed.fingerprint !== fingerprint(parsed.plan)) {
    throw new WhatsappMigrationError(
      'Fingerprint do manifesto não confere; gerar novamente a partir das decisões',
    );
  }
  validatePlan(parsed.plan, projectId, true);
  return parsed.plan;
}

/** Never launched by agents against real data. See the cutover runbook. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseWhatsappArgs(argv);
  const db = migrationDb(args.projectId, args.serviceAccountPath);
  const output = resolve(process.cwd(), 'out');
  mkdirSync(output, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolve(
    output,
    `${stamp}-whatsapp-contato-cliente${args.apply ? '' : '-dryrun'}.jsonl`,
  );
  const log = (record: unknown): void => appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  if (!args.manifest) {
    const decisions = args.decisions
      ? (JSON.parse(readFileSync(resolve(args.decisions), 'utf8')) as MigrationDecisions)
      : {};
    const docs = await inventory(db);
    const plan = planWhatsappMigration(args.projectId, docs, decisions);
    for (const item of plan.pending) log({ kind: 'pending', ...item });
    for (const item of plan.conflicts) log({ kind: 'conflict', ...item });
    for (const item of plan.writes)
      log({
        kind: 'would-write',
        path: item.path,
        before: fingerprint(item.before),
        after: fingerprint(item.after),
      });
    for (const path of plan.deletes) log({ kind: 'would-delete-after-verification', path });
    if (!args.reportOnly) {
      const manifestPath = resolve(output, `${stamp}-whatsapp-contato-cliente.manifest.json`);
      writeFileSync(
        manifestPath,
        JSON.stringify({ fingerprint: fingerprint(plan), plan }, null, 2),
        { flag: 'wx' },
      );
      // eslint-disable-next-line no-console -- operator runbook output
      console.log(`Manifesto: ${manifestPath}`);
    }
    // eslint-disable-next-line no-console -- operator runbook output
    console.log(
      JSON.stringify({
        scanned: docs.length,
        writes: plan.writes.length,
        deletes: plan.deletes.length,
        pending: plan.pending.length,
        conflicts: plan.conflicts.length,
        log: logPath,
      }),
    );
    return;
  }
  const manifestPath = resolve(args.manifest);
  const plan = readManifest(manifestPath, args.projectId);
  const store = firestoreStore(db);
  const checkpointPath = `${manifestPath}.checkpoint.json`;
  if (existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { fingerprint: string };
    if (checkpoint.fingerprint !== fingerprint(plan))
      throw new WhatsappMigrationError('Checkpoint de outro manifesto');
  }
  if (args.verify) {
    await verifyPlan(store, plan);
    log({ kind: 'verified', path: manifestPath, fingerprint: fingerprint(plan) });
    return;
  }
  const result = await executePlan(store, plan, {
    apply: args.apply,
    finalize: args.finalize,
    log,
  });
  if (args.apply)
    writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          fingerprint: fingerprint(plan),
          phase: args.finalize ? 'finalized' : 'copied-and-verified',
        },
        null,
        2,
      ),
    );
  // eslint-disable-next-line no-console -- operator runbook output
  console.log(JSON.stringify({ ...result, finalized: args.apply && args.finalize, log: logPath }));
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
