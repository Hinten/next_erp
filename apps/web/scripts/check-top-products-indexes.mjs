/* eslint-disable no-console -- Manual read-only CLI: stdout is the diagnostic interface. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  contadoresDoCabecalho,
  indicesUsados,
  parseAccessNodes,
  scansSemIdentificador,
} from '../../mercado-livre/lib/firebase/explainPlan.mjs';

// Resolve the Admin SDK's pinned Firestore dependency from its own manifest
// context; apps/web does not add a server dependency to its browser manifest.
const requireAdmin = createRequire(import.meta.resolve('firebase-admin/app'));
const pipelines = requireAdmin('@google-cloud/firestore/pipelines');

/**
 * Read-only staging cost diagnostic for the best-selling-products report.
 * Analyze executes and bills each of up to four queries. It NEVER seeds data,
 * deploys an index, widens the supplied dates, or changes database contents.
 *
 * Run from the repository root with a staging service account:
 * FIREBASE_SERVICE_ACCOUNT_PATH=<staging-sa.json> \
 *   node apps/web/scripts/check-top-products-indexes.mjs \
 *   --project <STAGING_PROJECT> --start-us <inclusive-microseconds> \
 *   --end-exclusive-us <exclusive-microseconds> [--account <integration-id>]
 *
 * Optional: --states pago,finalizado; --direction outgoing|incoming.
 * The database is literally default. The credential project must match --project.
 * Output includes the full plans and scanned-byte/read-unit counters; never
 * infer savings merely from returned row counts or the index declaration.
 * Exit 0: every requested shape proven; 1: finding; 2: empty/unrecognized plan.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

/** @param {string[]} argv */
export function parseTopProductsProbeArgs(argv) {
  const allowed = new Set([
    '--project',
    '--start-us',
    '--end-exclusive-us',
    '--account',
    '--states',
    '--direction',
  ]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!allowed.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new RangeError(
        'Expected unique --project, --start-us, --end-exclusive-us and optional ' +
          '--account/--states/--direction values.',
      );
    }
    values.set(flag, value);
  }
  const projectId = values.get('--project');
  const startUs = Number(values.get('--start-us'));
  const endExclusiveUs = Number(values.get('--end-exclusive-us'));
  if (!projectId || !/^[a-z][a-z0-9-]+$/.test(projectId) || projectId.startsWith('demo-')) {
    throw new RangeError(
      'An explicit real staging --project is required; ' +
        'demo- projects have no production query plans.',
    );
  }
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endExclusiveUs) ||
    startUs >= endExclusiveUs
  ) {
    throw new RangeError('The microsecond date bounds must be safe integers with start < end.');
  }
  const accountId = values.get('--account') ?? null;
  if (accountId !== null && (!accountId.trim() || accountId.includes('/'))) {
    throw new RangeError('--account must be one integration document ID.');
  }
  const estados = [...new Set((values.get('--states') ?? 'pago,finalizado').split(','))].sort();
  if (estados.some((state) => !state || state.trim() !== state)) {
    throw new RangeError(
      '--states must be a non-empty comma-separated list of exact order-state values.',
    );
  }
  const direction = values.get('--direction') ?? 'outgoing';
  if (direction !== 'outgoing' && direction !== 'incoming') {
    throw new RangeError('--direction must be outgoing or incoming.');
  }
  return {
    projectId,
    startUs,
    endExclusiveUs,
    accountId,
    estados,
    ehSaida: direction === 'outgoing',
  };
}

/** The Admin expression equivalent of the authenticated client query tested in e2e. */
export function buildTopProductsIndexProbePipeline(db, filters, expressions = pipelines) {
  const p = expressions;
  filters = {
    ...filters,
    estados: [...new Set(filters.estados)].sort(),
    accountIds: [...new Set(filters.accountIds)].sort(),
  };
  const predicates = [
    p.equal(p.field('ehSaida'), filters.ehSaida),
    p.greaterThanOrEqual(p.field('timestamp'), filters.startUs),
    p.lessThan(p.field('timestamp'), filters.endExclusiveUs),
  ];
  if (filters.estados.length > 0) predicates.push(p.equalAny(p.field('estado'), filters.estados));
  if (filters.accountIds.length > 0) {
    predicates.push(
      p.equalAny(
        p.field('integracaoPedidoOuterRef'),
        filters.accountIds.flatMap((id) => ['documents/integracao/' + id, 'integracao/' + id]),
      ),
    );
  }
  const items = p.field('itens').ifAbsent({}).ifNull(false);
  const groups = p.mapEntries(p.conditional(p.isType(items, 'map'), items, p.map({ NONE: [{}] })));
  const rawQuantity = p.field('item.quantidade').ifAbsent(false).ifNull(false);
  const quantity = p.conditional(p.isType(rawQuantity, 'number'), rawQuantity, p.constant(-1));
  const groupItems = p.field('itemGroups.v').ifAbsent(false).ifNull(false);
  const validQuantity = p.and(
    p.greaterThanOrEqual(quantity, 0),
    p.lessThanOrEqual(quantity, Number.MAX_VALUE),
  );
  return db
    .pipeline()
    .collection('pedidos')
    .where(p.and(...predicates))
    .select(groups.as('itemGroups'))
    .unnest(p.field('itemGroups'))
    .unnest(p.conditional(p.isType(groupItems, 'array'), groupItems, p.array([{}])).as('item'))
    .aggregate({
      groups: [p.field('itemGroups.k').as('produtoId')],
      accumulators: [
        p.sum(p.conditional(validQuantity, quantity, p.constant(0))).as('quantidade'),
        p.sum(p.conditional(validQuantity, p.constant(0), p.constant(1))).as('invalidLines'),
      ],
    });
}

/** @param {string} plan @param {string[]} expectedFields */
export function assessTopProductsPlan(plan, expectedFields) {
  const nodes = parseAccessNodes(plan);
  const indexes = indicesUsados(nodes);
  const counters = contadoresDoCabecalho(plan);
  if (!plan.trim() || nodes.length === 0) {
    return {
      status: 'unverified',
      indexes,
      counters,
      messages: ['No recognized access plan; an empty execution is not index evidence.'],
    };
  }
  const messages = [];
  for (const node of scansSemIdentificador(nodes).cheios) {
    messages.push('Identifier-less ' + node.type + ' at plan line ' + node.line + '.');
  }
  const prefix = '/pedidos (' + expectedFields.join(', ');
  const matches = nodes.filter(
    (node) =>
      node.identifier?.startsWith(prefix + ')') ||
      node.identifier?.startsWith(prefix + ', __key__ ASC)') ||
      node.identifier?.startsWith(prefix + ', __name__ ASC)'),
  );
  if (matches.length === 0) messages.push('The expected index was not used: ' + prefix + ').');
  for (const node of matches) {
    // A declared index can still be walked in full. Require every branch to
    // bound all equality fields AND the timestamp range, in index-field order.
    const boundedPath = (range, depth) =>
      node.boundedLines.includes(range.linha) &&
      (depth === expectedFields.length ||
        (range.filhas.length > 0 && range.filhas.every((child) => boundedPath(child, depth + 1))));
    if (node.faixas.length === 0 || !node.faixas.every((range) => boundedPath(range, 1))) {
      messages.push(
        'The access range does not bound every report filter including timestamp (plan line ' +
          node.line +
          ').',
      );
    }
  }
  return { status: messages.length === 0 ? 'pass' : 'fail', indexes, counters, messages };
}

/** @param {string} projectId @param {Record<string, unknown>} account */
export function validateTopProductsProbeAccount(projectId, account) {
  if (account.project_id !== projectId) {
    throw new RangeError('The service-account project_id must exactly match --project.');
  }
}

export async function runTopProductsIndexProbe(argv = process.argv.slice(2), env = process.env) {
  const options = parseTopProductsProbeArgs(argv);
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new RangeError(
      'Unset emulator hosts: emulator execution cannot establish index usage or cost.',
    );
  }
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_PROJECT_ID !== options.projectId) {
    throw new RangeError('FIREBASE_PROJECT_ID must match --project when supplied.');
  }
  if (env.FIREBASE_DATABASE_ID && env.FIREBASE_DATABASE_ID !== 'default') {
    throw new RangeError('This report targets the literal default database.');
  }
  const inline = env.FIREBASE_SERVICE_ACCOUNT;
  const path = env.FIREBASE_SERVICE_ACCOUNT_PATH ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!inline && !path) {
    throw new RangeError(
      'Provide FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT so the target project ' +
        'can be checked.',
    );
  }
  const account = JSON.parse(
    inline ?? (await readFile(isAbsolute(path) ? path : resolve(REPO_ROOT, path), 'utf8')),
  );
  validateTopProductsProbeAccount(options.projectId, account);
  const app = initializeApp(
    { projectId: options.projectId, credential: cert(account) },
    'top-products-explain-' + Date.now(),
  );
  try {
    const db = getFirestore(app, 'default');
    // Empty-state scenarios are diagnostic controls for simpler existing index
    // prefixes. They are not report selections: the UI requires non-empty states.
    const scenarios = [
      {
        label: 'direction + date',
        estados: [],
        accountIds: [],
        fields: ['ehSaida ASC', 'timestamp DESC'],
      },
      {
        label: 'direction + states + date',
        estados: options.estados,
        accountIds: [],
        fields: ['ehSaida ASC', 'estado ASC', 'timestamp DESC'],
      },
      ...(options.accountId === null
        ? []
        : [
            {
              label: 'direction + account + date',
              estados: [],
              accountIds: [options.accountId],
              fields: ['ehSaida ASC', 'integracaoPedidoOuterRef ASC', 'timestamp DESC'],
            },
            {
              label: 'direction + account + states + date',
              estados: options.estados,
              accountIds: [options.accountId],
              fields: [
                'ehSaida ASC',
                'integracaoPedidoOuterRef ASC',
                'estado ASC',
                'timestamp DESC',
              ],
            },
          ]),
    ];
    let verdict = 0;
    for (const scenario of scenarios) {
      console.log('\n=== ' + scenario.label + ' ===');
      const began = Date.now();
      const snapshot = await buildTopProductsIndexProbePipeline(db, {
        ...options,
        ...scenario,
      }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
      const plan = snapshot.explainStats?.text ?? '';
      console.log('Grouped rows:', snapshot.results.length, 'Elapsed ms:', Date.now() - began);
      console.log(
        plan ||
          '(No plan returned. Use a representative non-empty date window; ' +
            'dates are never widened automatically.)',
      );
      const assessment = assessTopProductsPlan(plan, scenario.fields);
      console.log(JSON.stringify(assessment, null, 2));
      if (assessment.status === 'fail') verdict = 1;
      else if (assessment.status === 'unverified' && verdict === 0) verdict = 2;
    }
    if (options.accountId === null) {
      console.log(
        '\nAccount-filtered shapes were not requested. Supply --account to verify their indexes.',
      );
    }
    return verdict;
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTopProductsIndexProbe();
}
