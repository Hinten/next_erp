/**
 * #1087 §8 — **read the notification lanes, which have no UI at all.**
 *
 * `notificacoesMercadoLivre` is a failures-only collection: a notification that
 * processed cleanly writes nothing, so every document here is a `failed`,
 * `parked` or `deferred` one. Nothing in apps/web renders it, which means the
 * resilience half of the live run — the deferred lane (#808), the replay dedup
 * (#807), the `items_prices` no-op (#803), the `missed_feeds` backstop (#812) —
 * is otherwise only visible by hand in the Firestore console.
 *
 *   pnpm --filter @delfrance/mercado-livre-app dump:notificacoes --project <id>
 *   # one lane only, or one seller only
 *   … --status deferred          … --userId 123456789
 *   # what a topic is doing, at a glance
 *   … --topic questions
 *
 * ⚠️ **Strictly read-only.** No ML call, no token, no write. Reading a document
 * is all it does — in particular it never re-drives or resolves anything, so it
 * cannot perturb the run it is observing.
 *
 * ⚠️ `--project` is REQUIRED and never inferred.
 *
 * ⚠️ **Cost.** Firestore Enterprise bills DATA SCANNED. The `--status` filter
 * rides the declared `(status, processedAt)` index and `--userId` the
 * `(status, user_id)` one — the same two the sweep and the re-drive use. An
 * unfiltered call is a bounded scan of a failures-only collection, which is
 * small by construction; `--limit` bounds it anyway.
 */
import { notificacaoMercadoLivreCollection } from '@delfrance/data/admin/collections';
import type { Query } from 'firebase-admin/firestore';

import { getAdminFirestore } from '../lib/firebase/admin';
import { TOPIC_DISPOSITION } from '../lib/marketplace/notificacoes/notificacao';

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class DumpArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DumpArgError';
  }
}

/** The three lanes a document can sit in — `notificationResilienceFields`. */
const STATUSES = ['failed', 'parked', 'deferred'] as const;
type Status = (typeof STATUSES)[number];

function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v);
}

interface Args {
  projectId: string;
  status: Status | null;
  topic: string | null;
  userId: string | null;
  limit: number;
  json: boolean;
}

function valueOf(name: string, inline: string | undefined, next: string | undefined): string {
  const raw = inline ?? next;
  if (raw == null || raw.startsWith('--')) {
    throw new DumpArgError(`--${name} exige um valor.`);
  }
  return raw;
}

function parseArgs(argv: readonly string[]): Args {
  let projectId: string | undefined;
  let status: Status | null = null;
  let topic: string | null = null;
  let userId: string | null = null;
  let limit = 100;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case 'project':
        projectId = valueOf(name, inline, argv[i + 1]);
        break;
      case 'status': {
        const raw = valueOf(name, inline, argv[i + 1]);
        if (!isStatus(raw)) {
          throw new DumpArgError(`--status deve ser um de: ${STATUSES.join(', ')}`);
        }
        status = raw;
        break;
      }
      case 'topic':
        topic = valueOf(name, inline, argv[i + 1]);
        break;
      case 'userId': {
        // `user_id` is a NUMBER in Firestore, so this is coerced before the
        // `where`. A non-numeric value would become NaN and make the query throw
        // deep inside the SDK — fail here, with a message that names the flag.
        const raw = valueOf(name, inline, argv[i + 1]);
        if (!/^\d+$/.test(raw.trim())) {
          throw new DumpArgError(`--userId deve ser um inteiro (o user_id numérico do ML): ${raw}`);
        }
        userId = raw.trim();
        break;
      }
      case 'limit': {
        const parsed = Number(valueOf(name, inline, argv[i + 1]));
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
          throw new DumpArgError('--limit deve ser um inteiro entre 1 e 1000.');
        }
        limit = parsed;
        break;
      }
      case 'json':
        json = true;
        break;
      default:
        throw new DumpArgError(`Opção desconhecida: --${name}`);
    }
  }

  if (!projectId?.trim()) throw new DumpArgError('--project é obrigatório.');
  return { projectId: projectId.trim(), status, topic, userId, limit, json };
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 72 ? `${v.slice(0, 69)}…` : v;
  return JSON.stringify(v);
}

/** ms or µs since epoch, whichever the field turned out to be. */
function when(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const ms = v > 1e14 ? Math.round(v / 1000) : v;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function main(): Promise<void> {
  const { projectId, status, topic, userId, limit, json } = parseArgs(process.argv.slice(2));
  process.env.FIREBASE_PROJECT_ID = projectId;

  const db = getAdminFirestore();

  let query: Query = notificacaoMercadoLivreCollection.ref(db, {});
  if (status != null) query = query.where('status', '==', status);
  if (userId != null) query = query.where('user_id', '==', Number(userId));
  const snap = await query.limit(limit).get();

  const docs = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    // `topic` is filtered in code on purpose: adding it to the query would need
    // a third composite index for a diagnostic that reads a small collection.
    .filter((d) => topic == null || d.data.topic === topic);

  const filtros = [
    status ? `status=${status}` : null,
    topic ? `topic=${topic}` : null,
    userId ? `user_id=${userId}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  log(`[dump:notificacoes] project=${projectId} ${filtros}`.trimEnd());
  log(`  ${docs.length} documento(s)${snap.size === limit ? ` (limite ${limit} atingido)` : ''}`);

  if (json) {
    log(JSON.stringify(docs, null, 2));
    return;
  }

  const porStatus = new Map<string, number>();
  const porTopic = new Map<string, number>();

  for (const { id, data } of docs) {
    const st = String(data.status ?? '—');
    const tp = String(data.topic ?? '—');
    porStatus.set(st, (porStatus.get(st) ?? 0) + 1);
    porTopic.set(tp, (porTopic.get(tp) ?? 0) + 1);

    log('');
    log(`  ${id}`);
    log(
      `    status=${st}  topic=${tp}  tentativas=${fmt(data.tentativas)}` +
        `  user_id=${fmt(data.user_id)}  processedAt=${when(data.processedAt)}`,
    );
    log(`    resource=${fmt(data.resource)}`);
    if (data.erro != null) log(`    erro=${fmt(data.erro)}`);
    if (data.id == null) {
      // #807: three producers hand the store a payload ML gave no id for, and
      // the doc id is then derived as `<topic>:<resource>`. A null `id` FIELD is
      // correct there — it records that ML issued none, it is not a defect.
      log('    (sem id do ML — doc id derivado de topic:resource, #807)');
    }
  }

  if (docs.length === 0) {
    log('');
    log('  Nada aqui. Numa coleção só-de-falhas isso é o resultado BOM —');
    log('  mas confirme que as notificações realmente chegaram (logs do receiver),');
    log('  senão "vazio" só quer dizer que nada foi entregue.');
    return;
  }

  log('');
  log('## Resumo');
  for (const [k, v] of [...porStatus].sort()) log(`  status ${k.padEnd(10)} ${v}`);
  for (const [k, v] of [...porTopic].sort()) log(`  topic  ${k.padEnd(10)} ${v}`);

  // ⚠️ Derivado de TOPIC_DISPOSITION, nunca de um literal (#1129). Este check
  // existia só para `items_prices` — e #1129 foi exatamente esta classe de bug
  // num OUTRO tópico: ML manda `stock-locations`, a tabela só conhecia
  // `stock-location`, e cada entrega parqueava um documento. O resumo acima
  // listaria esses docs, mas nada os apontaria como ERRADOS. Um tópico `ack`
  // é, por definição, aquele que não persiste nada; ler a tabela faz este
  // diagnóstico cobrir também o próximo nome que divergir.
  //
  // Só `parked`: um doc `deferred` de tópico ack é legítimo (vendedor ainda
  // não conectado, #808 — a conta é resolvida ANTES do despacho por tópico),
  // e sinalizá-lo aqui seria ruído.
  const topicosAck = new Set(
    Object.entries(TOPIC_DISPOSITION)
      .filter(([, disposicao]) => disposicao === 'ack')
      .map(([topico]) => topico),
  );
  const parkedInertes = docs.filter(
    (d) =>
      d.data.status === 'parked' &&
      typeof d.data.topic === 'string' &&
      topicosAck.has(d.data.topic),
  );
  if (parkedInertes.length > 0) {
    const nomes = [...new Set(parkedInertes.map((d) => String(d.data.topic)))].sort().join(', ');
    log('');
    log(
      `  ❌ ${parkedInertes.length} documento(s) parqueados de tópico(s) ack-only: ${nomes}. ` +
        'Um tópico `ack` NÃO deve persistir nada. Se o nome não estiver em ' +
        'TOPIC_DISPOSITION, ML mudou/variou a grafia e cada entrega parqueia (#1129).',
    );
  }

  // ⚠️ O check acima NÃO pegou #1322, e o motivo é instrutivo: ele parte dos
  // tópicos `ack` da tabela, então só enxerga um nome que ESTÁ nela. Quando ML
  // migrou claims para o modelo de subtópicos, `post_purchase` estava AUSENTE
  // da tabela inteira — cada entrega ia para `unknown-topic` e parqueava, e o
  // resumo listava os documentos sem apontar nada como errado. Claims,
  // mediações e mensagens de pós-venda deixaram de ser ingeridas por completo,
  // e isso só apareceu porque um humano leu este dump linha a linha.
  //
  // O sinal é o INVERSO do anterior: **um tópico desconhecido parqueando
  // repetidamente**. Um único doc pode ser ruído (ML inventou um tópico que
  // não nos interessa); vários da mesma grafia é uma migração de nome que a
  // tabela ainda não conhece — exatamente o custo que a distinção
  // `ack`/`park` do #813 existe para tornar visível.
  const parkedDesconhecidos = new Map<string, number>();
  for (const d of docs) {
    const topico = d.data.topic;
    if (d.data.status !== 'parked' || typeof topico !== 'string') continue;
    if (topico in TOPIC_DISPOSITION) continue;
    parkedDesconhecidos.set(topico, (parkedDesconhecidos.get(topico) ?? 0) + 1);
  }
  if (parkedDesconhecidos.size > 0) {
    log('');
    for (const [topico, n] of [...parkedDesconhecidos].sort((a, b) => b[1] - a[1])) {
      log(
        `  ❌ tópico DESCONHECIDO '${topico}' parqueou ${n} documento(s) — ausente de ` +
          'TOPIC_DISPOSITION. Se repete, ML passou a entregar sob um nome novo e o ' +
          'handler correspondente não roda para NINGUÉM (#1322: `claims` → `post_purchase`).',
      );
    }
  }
}

await main();
