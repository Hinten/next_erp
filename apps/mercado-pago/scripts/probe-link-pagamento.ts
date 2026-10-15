/**
 * #367 — live probe of the Mercado Pago payment-link surface (P1..P10 of the plan).
 *
 * The link routes are built against Mercado Pago's DOCUMENTATION, and the docs are
 * silent on exactly the points the design leans on. Reading cannot settle them; only
 * a real seller account, real R$ 1,00 payments and a look at what Mercado Pago
 * STORED can:
 *
 *   P1  our exact builder output is accepted (201), the response has the keys we
 *       model, and the app's OAuth grant may WRITE /checkout/preferences (a 403 here
 *       means the registered application lacks the scope).                 `criar`
 *   P2  ONE init_point paid TWICE: two approved payments on the same link_id? This
 *       gates MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED.                 `pagamento`
 *   P3  WITHOUT a `notification_url`, does the panel webhook of #564 receive the
 *       `payment` topic for a preference made with a connected seller's token? The
 *       whole no-notification_url design depends on it. Not observable from here:
 *       create with `criar --pedido <a REAL staging pedido id>`, pay it, then read
 *       the task logs and `notificacoesMercadoPago`.                        `criar`
 *   P4  does the refetched payment carry `metadata.link_id` (snake_case), what does
 *       `description` / `payer.first_name` / `card.cardholder.name` hold?
 *                                                                       `pagamento`
 *   P5  after PUT {expires:true, expiration_date_to:<now>}, does the init_point
 *       refuse a NEW payment — and a checkout already open, and a Pix already
 *       issued? The reading half is here; the three "can I still pay?" attempts are
 *       yours, by hand.                                                `preferencia`
 *   P7  /v1/payments/search: the largest accepted `limit`, and whether the SAME
 *       search twice inside a minute answers cause code 2001.               `busca`
 *   P8  does a `payer` prefill lock the checkout fields, and is a string
 *       `phone.number` accepted? (`criar --pagador-*`)
 *   P9  cutover: can the NEW application's token read (`preferencia`), search
 *       (`busca`) and expire (`preferencia --expirar --forcar`) a preference made by
 *       the LEGACY application for the same seller?
 *   P10 are `--excluir` / `--parcelas` reflected at the checkout? (`criar`)
 *
 * P6 (does a `Z` date work?) is deliberately not probed: the app always sends an
 * explicit `-03:00` offset and the strict request schema refuses a `Z`.
 *
 *     # 1. what WOULD go out (nothing leaves the machine; the body is checked
 *     #    against the strict request schema)
 *     pnpm --filter @delfrance/mercado-pago-app probe:link-pagamento criar \
 *       --project <id> --metodo <metodo_pgto id>
 *     # 2. create ONE R$ 1,00 preference for real
 *     ...                                 criar --project <id> --metodo <id> --executar
 *     # 3. pay its init_point by hand (twice, for P2), then read what MP recorded
 *     ...                                 pagamento --project <id> --metodo <id> \
 *       --payment <payment id> --payment <payment id>
 *     # 4. read it, then expire it and read it back
 *     ...                                 preferencia --project <id> --metodo <id> \
 *       --preferencia <preference id> --expirar --executar
 *     # 5. the search
 *     ...                                 busca --project <id> --metodo <id> \
 *       --referencia <external_reference> --repetir
 *
 * ⚠️ **Run it ONLY with Lucas's go — agents never run it** (root `CLAUDE.md` rule 8).
 * It needs a connected seller and real R$ 1,00 payments made by hand: payments made
 * with test credentials send no notifications, and the webhook pipeline drops
 * `live_mode=false`. Whatever it creates on the seller's account is real.
 *
 * `--project` is REQUIRED, never inferred, and is CHECKED against the service
 * account: a credential issued for another project makes the script refuse rather
 * than talk to a database it was not pointed at (same discipline as
 * `tools/migrations`). It is a dry run by default — `--executar` is what POSTs a
 * preference or PUTs an expiry. The subcommands that only READ (`pagamento`,
 * `busca`, and `preferencia` without `--expirar`) run without it.
 *
 * ⚠️ **It writes no ERP data**, with one exception it cannot avoid: reading the
 * access token goes through `resolveAccessToken`, which REFRESHES an expiring
 * credential and persists MP's rotated refresh token into
 * `metodo_pgto/{id}/credenciais` — exactly what the backend itself would do. A probe
 * that bypassed it would burn the grant instead.
 *
 * ⚠️ **The payment a probe preference receives is REAL to the webhook.** Without
 * `--pedido` the `external_reference` is a made-up id (`probe-<ms>`): the
 * notification arrives, there is no pedido to reconcile, and what the pipeline does
 * with it is precisely what P3 wants to see. With `--pedido <real id>` the payment
 * WILL be reconciled into that pedido — use a staging pedido you can throw away.
 *
 * ⛔ `preferencia --expirar` refuses a preference WITHOUT `metadata.link_id`: it was
 * not made by this feature's builder, so it is probably a live LEGACY customer link,
 * and expiring it kills it for good. `--forcar` is the deliberate P9 opt-in.
 *
 * Output prints presence booleans and the derived FIRST name only — never a full
 * name, an e-mail, a CPF or a phone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import {
  dataCivilNoFuso,
  fimDoDiaNoFuso,
  nowMillis,
  somarDiasCivis,
} from '@delfrance/core/datetime';
import { formatReais } from '@delfrance/core/money';
import { linkPgtoMercadoPagoCollection } from '@delfrance/data/admin/collections';
import {
  DEFAULT_API_BASE_URL,
  type MercadoPagoApi,
  MercadoPagoError,
  MercadoPagoHttpError,
  type MpPayment,
  type MpPreference,
  type MpPreferenceRequest,
  type PreferenceInput,
  buildPreferenceRequest,
  createMercadoPagoApi,
  mpCauseCodes,
  mpPreferenceRequestSchema,
  mpPreferenceSchema,
} from '@delfrance/integrations-mercado-pago';
import {
  FUSO_FISCAL,
  LIMITES_LINK_PAGAMENTO,
  type TipoPagamentoMp,
  extrairPrimeiroNome,
  linkPagamentoIdSchema,
  pedidoIdLinkSchema,
  tipoPagamentoMpSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '../lib/firebase/admin';
import { expirePatch } from '../lib/payments/links/expirar';
import {
  MercadoPagoConfigError,
  MercadoPagoContaNotConfiguredError,
  type MercadoPagoContext,
  loadMercadoPagoContext,
} from '../lib/payments/mercadoPago';

/** What the probe preference charges. Fixed on purpose: this must never be a real sale. */
const VALOR_PROBE = 1;
/** The title becomes `Pedido #PROBE — Teste`, unmistakable in the seller's panel. */
const NUMERO_PROBE = 'PROBE';
const NOME_PROBE = 'Teste';

/** Longest slice of an MP error body / raw value that is echoed to the terminal. */
const LIMITE_LOG = 600;

/** The keys `mpPreferenceSchema` models — anything else in a response is reported. */
const CHAVES_MODELADAS_PREFERENCIA: ReadonlySet<string> = new Set([
  'id',
  'init_point',
  'sandbox_init_point',
  'date_created',
  'expires',
  'expiration_date_to',
  'date_of_expiration',
  'external_reference',
  'metadata',
]);

/** What a known `cause.code` means for this feature, printed beside the raw code. */
const DICAS_POR_CAUSA: Readonly<Record<string, string>> = {
  '2001': 'a MESMA requisição repetida em menos de 1 min (o sync do app responde 429)',
  '1000': 'o `limit` pedido excede o máximo aceito pelo Mercado Pago — reduza --limite',
  '9062': 'o intervalo de datas da busca precisa ser menor que 365 dias',
};

function log(message: string): void {
  // eslint-disable-next-line no-console -- CLI output
  console.log(message);
}

class ProbeArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeArgError';
  }
}

/* --------------------------------- arguments -------------------------------- */

const COMANDOS = ['criar', 'pagamento', 'preferencia', 'busca'] as const;
type Comando = (typeof COMANDOS)[number];

/** Flags that take no value. Everything else takes exactly one (`--payment` may repeat). */
const FLAGS_SEM_VALOR: ReadonlySet<string> = new Set(['executar', 'forcar', 'expirar', 'repetir']);

/**
 * The flags each subcommand accepts. A flag outside its subcommand THROWS instead
 * of being ignored: a silently ignored `--executar` on a read-only subcommand is an
 * operator believing something was sent.
 */
const FLAGS_POR_COMANDO: Readonly<Record<Comando, ReadonlySet<string>>> = {
  criar: new Set([
    'project',
    'metodo',
    'executar',
    'pedido',
    'excluir',
    'parcelas',
    'pagador-nome',
    'pagador-email',
    'pagador-telefone',
  ]),
  pagamento: new Set(['project', 'metodo', 'payment']),
  preferencia: new Set(['project', 'metodo', 'preferencia', 'expirar', 'executar', 'forcar']),
  busca: new Set(['project', 'metodo', 'referencia', 'limite', 'repetir']),
};

interface Comum {
  projectId: string;
  metodoId: string;
}

/** The typed-by-hand payer of P8. Sent to Mercado Pago only, never echoed. */
interface PagadorProbe {
  nome: string | null;
  email: string | null;
  telefone: string | null;
}

interface ArgsCriar {
  comando: 'criar';
  executar: boolean;
  pedidoId: string | null;
  excluir: TipoPagamentoMp[];
  parcelas: number | null;
  pagador: PagadorProbe | null;
}
interface ArgsPagamento {
  comando: 'pagamento';
  pagamentos: string[];
}
interface ArgsPreferencia {
  comando: 'preferencia';
  preferenciaId: string;
  expirar: boolean;
  executar: boolean;
  forcar: boolean;
}
interface ArgsBusca {
  comando: 'busca';
  referencia: string;
  limite: number;
  repetir: boolean;
}

type Args = Comum & (ArgsCriar | ArgsPagamento | ArgsPreferencia | ArgsBusca);

/**
 * A flag takes no value, and saying so is a SAFETY control: `--executar=false` must
 * not turn the send ON (the ML probe's `--executar=false` bug). The `--flag value`
 * spelling is refused by the positional check in {@link parseArgs}.
 */
function semValor(nome: string, inline: string | undefined): void {
  if (inline !== undefined) {
    throw new ProbeArgError(
      `--${nome} é uma flag e não aceita valor (recebi "--${nome}=${inline}"). ` +
        `Para NÃO usá-la, OMITA a flag.`,
    );
  }
}

function unico(valores: ReadonlyMap<string, string[]>, nome: string): string | null {
  const lista = valores.get(nome);
  if (lista === undefined) return null;
  if (lista.length > 1) throw new ProbeArgError(`--${nome} foi repetido; passe uma vez só.`);
  return lista[0] ?? null;
}

/** `null` when the flag was not given; a THROW when it was given and is not a fit integer. */
function inteiro(nome: string, bruto: string | null, min: number, max: number): number | null {
  if (bruto === null) return null;
  const valor = /^\d+$/.test(bruto) ? Number(bruto) : Number.NaN;
  if (!Number.isInteger(valor) || valor < min || valor > max) {
    throw new ProbeArgError(`--${nome} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return valor;
}

function parseExcluir(bruto: string | null): TipoPagamentoMp[] {
  if (bruto === null) return [];
  const tipos = bruto
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => parte !== '');
  const aceitos = tipoPagamentoMpSchema.options.join(', ');
  const validos: TipoPagamentoMp[] = [];
  for (const parte of tipos) {
    const lido = tipoPagamentoMpSchema.safeParse(parte);
    if (!lido.success) {
      throw new ProbeArgError(`--excluir: tipo desconhecido "${parte}". Aceitos: ${aceitos}.`);
    }
    if (!validos.includes(lido.data)) validos.push(lido.data);
  }
  if (validos.length > 3) {
    throw new ProbeArgError('--excluir aceita no máximo 3 tipos: um meio de pagamento sobra.');
  }
  return validos;
}

function parseArgs(argv: readonly string[]): Args {
  const [bruto, ...resto] = argv;
  const comando = COMANDOS.find((candidato) => candidato === bruto);
  if (comando === undefined) {
    throw new ProbeArgError(`Informe o subcomando: ${COMANDOS.join(' | ')}.`);
  }

  const permitidas = FLAGS_POR_COMANDO[comando];
  const valores = new Map<string, string[]>();
  const ligadas = new Set<string>();

  for (let i = 0; i < resto.length; i += 1) {
    const arg = resto[i]!;
    // ⛔ THROW, never skip: skipping is what let `--executar false` read as a bare
    // flag plus an ignored token, i.e. a live send from a dry-run intent.
    if (!arg.startsWith('--')) throw new ProbeArgError(`Argumento inesperado: ${arg}`);
    const eq = arg.indexOf('=');
    const nome = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!permitidas.has(nome)) {
      throw new ProbeArgError(`--${nome} não existe (ou não vale) no subcomando "${comando}".`);
    }
    if (FLAGS_SEM_VALOR.has(nome)) {
      semValor(nome, inline);
      ligadas.add(nome);
      continue;
    }
    const valor = inline ?? resto[i + 1];
    if (valor === undefined || valor.startsWith('--')) {
      throw new ProbeArgError(`--${nome} exige um valor.`);
    }
    if (inline === undefined) i += 1;
    valores.set(nome, [...(valores.get(nome) ?? []), valor]);
  }

  const projectId = unico(valores, 'project')?.trim();
  if (!projectId) {
    throw new ProbeArgError('--project é obrigatório e nunca é inferido do ambiente.');
  }
  const metodoId = unico(valores, 'metodo')?.trim();
  if (!metodoId) throw new ProbeArgError('--metodo <id do metodo_pgto> é obrigatório.');
  const comum: Comum = { projectId, metodoId };

  switch (comando) {
    case 'criar': {
      const pedido = unico(valores, 'pedido');
      let pedidoId: string | null = null;
      if (pedido !== null) {
        const lido = pedidoIdLinkSchema.safeParse(pedido);
        if (!lido.success) {
          throw new ProbeArgError(
            '--pedido deve ter de 1 a 64 caracteres [A-Za-z0-9_-] (vira o external_reference).',
          );
        }
        pedidoId = lido.data;
      }
      const parcelas = inteiro('parcelas', unico(valores, 'parcelas'), 1, 36);
      const nome = unico(valores, 'pagador-nome');
      const email = unico(valores, 'pagador-email');
      const telefone = unico(valores, 'pagador-telefone');
      const semPagador = nome === null && email === null && telefone === null;
      const pagador: PagadorProbe | null = semPagador ? null : { nome, email, telefone };
      const excluir = parseExcluir(unico(valores, 'excluir'));
      const executar = ligadas.has('executar');
      return { ...comum, comando: 'criar', executar, pedidoId, excluir, parcelas, pagador };
    }
    case 'pagamento': {
      const ids = valores.get('payment') ?? [];
      if (ids.length === 0) {
        throw new ProbeArgError('--payment <id> é obrigatório (repita para P2).');
      }
      for (const id of ids) {
        if (!/^\d{1,20}$/.test(id)) {
          throw new ProbeArgError(`--payment "${id}" não é um id numérico de pagamento.`);
        }
      }
      return { ...comum, comando: 'pagamento', pagamentos: [...new Set(ids)] };
    }
    case 'preferencia': {
      const preferenciaId = unico(valores, 'preferencia');
      if (preferenciaId === null || !/^[A-Za-z0-9_-]{1,128}$/.test(preferenciaId)) {
        throw new ProbeArgError('--preferencia <id da preferência> é obrigatório.');
      }
      const expirar = ligadas.has('expirar');
      const executar = ligadas.has('executar');
      const forcar = ligadas.has('forcar');
      if (!expirar && (executar || forcar)) {
        throw new ProbeArgError(
          '--executar e --forcar só valem com --expirar (sem ele o subcomando apenas LÊ).',
        );
      }
      return { ...comum, comando: 'preferencia', preferenciaId, expirar, executar, forcar };
    }
    case 'busca': {
      const referenciaBruta = unico(valores, 'referencia');
      const referencia = pedidoIdLinkSchema.safeParse(referenciaBruta);
      if (!referencia.success) {
        throw new ProbeArgError(
          '--referencia <external_reference> é obrigatório (1..64 caracteres [A-Za-z0-9_-]).',
        );
      }
      const limite = inteiro('limite', unico(valores, 'limite'), 1, 1000) ?? 100;
      const repetir = ligadas.has('repetir');
      return { ...comum, comando: 'busca', referencia: referencia.data, limite, repetir };
    }
  }
}

/* ---------------------------- --project vs credential ---------------------------- */

const serviceAccountSchema = z.object({ project_id: z.string().min(1) });

/** Same lookup as `lib/firebase/admin.ts`: cwd first, then the repo root two levels up. */
function resolveCredentialPath(inputPath: string): string {
  const fromCwd = resolve(inputPath);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(process.cwd(), '..', '..', inputPath);
  if (existsSync(fromRoot)) return fromRoot;
  throw new ProbeArgError(
    `Service account não encontrada em "${inputPath}". Tentei: "${fromCwd}" e "${fromRoot}".`,
  );
}

/**
 * The project the SERVICE ACCOUNT was issued for. It reads the same source, in the
 * same order, as `getAdminApp()` (inline JSON, then the path) so the check is about
 * the credential the app will actually use. No service account at all is a refusal
 * too: falling back to application-default credentials would leave the target
 * project to whatever the shell happens to be logged into.
 */
function projetoDaServiceAccount(): string {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  let bruto: string;
  if (inline) bruto = inline;
  else if (caminho) bruto = readFileSync(resolveCredentialPath(caminho), 'utf-8');
  else {
    throw new ProbeArgError(
      'Sem service account: defina FIREBASE_SERVICE_ACCOUNT ou FIREBASE_SERVICE_ACCOUNT_PATH ' +
        '(.env.local). O probe não usa credenciais ambiente.',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(bruto);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new ProbeArgError('A service account não é um JSON válido.');
  }
  const lido = serviceAccountSchema.safeParse(json);
  if (!lido.success) throw new ProbeArgError('A service account não traz `project_id`.');
  return lido.data.project_id;
}

/* ---------------------------------- helpers ---------------------------------- */

function sn(valor: boolean): string {
  return valor ? 'sim' : 'não';
}

/** Walk `raiz` by object keys / array indexes; `undefined` when any step is missing. */
function lerCaminho(raiz: unknown, caminho: ReadonlyArray<string | number>): unknown {
  let atual: unknown = raiz;
  for (const passo of caminho) {
    if (atual === null || typeof atual !== 'object') return undefined;
    if (Array.isArray(atual) !== (typeof passo === 'number')) return undefined;
    atual = Reflect.get(atual, passo);
  }
  return atual;
}

/** A non-blank string, or `null`. */
function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** The keys of a plain object (sorted), `[]` for anything else. */
function chavesDe(valor: unknown): string[] {
  if (valor === null || typeof valor !== 'object') return [];
  return Object.keys(valor).sort();
}

function presente(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  return typeof valor !== 'string' || valor.trim() !== '';
}

/** The distinct field paths of a Zod failure — PATHS only, never a value. */
function caminhosInvalidos(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
  const caminhos = issues.map((issue) => issue.path.map(String).join('.') || '(raiz)');
  return [...new Set(caminhos)].join(', ');
}

/** A short, printable form of a value that may be long. */
function resumir(valor: unknown): string {
  if (valor === undefined) return '(vazio)';
  const bruto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  return bruto.length > LIMITE_LOG ? `${bruto.slice(0, LIMITE_LOG)}…` : bruto;
}

/** The body as it would go out, with every payer field hidden (PII). */
function corpoParaLog(corpo: MpPreferenceRequest): string {
  const { payer, ...resto } = corpo;
  if (payer === undefined) return JSON.stringify(resto, null, 2);
  const oculto = Object.fromEntries(Object.keys(payer).map((chave) => [chave, '<oculto>']));
  return JSON.stringify({ ...resto, payer: oculto }, null, 2);
}

function inteiroPositivo(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isInteger(valor) && valor > 0 ? valor : null;
  if (typeof valor === 'string' && /^\d+$/.test(valor)) return Number(valor);
  return null;
}

/**
 * Report a Mercado Pago HTTP refusal as a RESULT (it is half of what a probe exists
 * to learn) and say it was handled. Returns `false` for anything else so the caller
 * rethrows it. `esperado` is for the refusal a probe PROVOKES on purpose (the second
 * identical search of P7): it is still printed, but does not turn the exit code red.
 */
function relatarErroHttp(err: unknown, onde: string, esperado = false): boolean {
  if (!(err instanceof MercadoPagoHttpError)) return false;
  const causas = mpCauseCodes(err);
  log(`  FALHA  ${onde}: HTTP ${err.status}`);
  log(`    mensagem  : ${err.message}`);
  if (causas.length > 0) {
    log(`    cause.code: ${causas.join(', ')}`);
    for (const causa of causas) {
      const dica = DICAS_POR_CAUSA[causa];
      if (dica !== undefined) log(`      ${causa} = ${dica}`);
    }
  }
  log(`    corpo     : ${resumir(err.body)}`);
  if (err.status === 403) {
    log('    403 = o token desta aplicação não pode fazer isto. Duas hipóteses:');
    log('      P1: a aplicação do #564 não tem escopo de ESCRITA em /checkout/preferences;');
    log('      P9: o recurso pertence a OUTRA aplicação (a legada).');
  }
  if (!esperado) process.exitCode = 1;
  return true;
}

/* -------------------------------- the session -------------------------------- */

interface Sessao {
  projectId: string;
  db: Firestore;
  ctx: MercadoPagoContext;
  /** The seller's Mercado Pago user id (`metodo_pgto.user_id`); the webhook's collector key. */
  userId: number | null;
  agoraMs: number;
  /** Resolves the access token (may refresh it — see the docblock) and builds the client. */
  abrirApi(): Promise<{ api: MercadoPagoApi; token: string }>;
}

/* ------------------------------ preference reading ------------------------------ */

type LeituraPreferencia =
  | { ok: true; preferencia: MpPreference }
  | { ok: false; status: number | null; motivo: string };

/**
 * `GET /checkout/preferences/{id}`, straight over `fetch`. The package client has no
 * such method ON PURPOSE — the app never reads a preference back — but a probe needs
 * an INDEPENDENT read: the answer to P5 is what Mercado Pago STORED, not what the
 * PUT's own response claims. The body is parsed with the real response schema, never
 * cast.
 */
async function lerPreferencia(token: string, preferenciaId: string): Promise<LeituraPreferencia> {
  const url = `${DEFAULT_API_BASE_URL}/checkout/preferences/${encodeURIComponent(preferenciaId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return { ok: false, status: null, motivo: `falha de rede: ${err.message}` };
  }

  const bruto = await res.text();
  let corpo: unknown = null;
  if (bruto.length > 0) {
    try {
      corpo = JSON.parse(bruto);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return { ok: false, status: res.status, motivo: 'resposta não-JSON' };
    }
  }
  if (!res.ok) return { ok: false, status: res.status, motivo: resumir(corpo) };

  const lido = mpPreferenceSchema.safeParse(corpo);
  if (!lido.success) {
    const campos = caminhosInvalidos(lido.error.issues);
    const motivo = `resposta fora do schema modelado. Campos inválidos: ${campos}`;
    return { ok: false, status: res.status, motivo };
  }
  return { ok: true, preferencia: lido.data };
}

/** One optional field of a preference, JSON-printed (`null` when absent). */
function campoDaPreferencia(p: MpPreference, chave: string): string {
  return JSON.stringify(lerCaminho(p, [chave]) ?? null);
}

function imprimirPreferencia(rotulo: string, p: MpPreference): void {
  const chaves = Object.keys(p).sort();
  const extras = chaves.filter((chave) => !CHAVES_MODELADAS_PREFERENCIA.has(chave));
  const temLinkId = presente(lerCaminho(p, ['metadata', 'link_id']));
  log(`  ${rotulo}`);
  log(`    id=${p.id}  external_reference=${campoDaPreferencia(p, 'external_reference')}`);
  log(`    metadata.link_id presente: ${sn(temLinkId)}`);
  log(`    expires=${campoDaPreferencia(p, 'expires')}`);
  log(`    expiration_date_to=${campoDaPreferencia(p, 'expiration_date_to')}`);
  log(`    date_of_expiration=${campoDaPreferencia(p, 'date_of_expiration')}`);
  log(`    preference_expired=${campoDaPreferencia(p, 'preference_expired')}`);
  log(`    chaves da resposta   : ${chaves.join(', ')}`);
  log(`    chaves NÃO modeladas : ${extras.length > 0 ? extras.join(', ') : '(nenhuma)'}`);
}

/* ---------------------------------- `criar` ---------------------------------- */

async function comandoCriar(s: Sessao, args: ArgsCriar): Promise<void> {
  const pedidoId = args.pedidoId ?? `probe-${String(s.agoraMs)}`;
  // The real id shape: the link doc id, minted locally (no write).
  const linkId = linkPgtoMercadoPagoCollection.newDocId(s.db, { pedidoId });
  if (!linkPagamentoIdSchema.safeParse(linkId).success) {
    throw new Error('O id gerado não tem o formato de linkPagamentoIdSchema.');
  }

  // The default expiry of the feature, computed the way the route computes it.
  const hoje = dataCivilNoFuso(s.agoraMs, FUSO_FISCAL);
  const expiraEm = somarDiasCivis(hoje, LIMITES_LINK_PAGAMENTO.expiracaoDiasPadrao);
  const expiraEmMs = expiraEm === null ? null : fimDoDiaNoFuso(expiraEm, FUSO_FISCAL);
  if (expiraEmMs === null) throw new Error('Não consegui calcular a data de expiração.');

  const entrada: PreferenceInput = {
    pedidoId,
    numeroPedido: NUMERO_PROBE,
    linkId,
    valor: VALOR_PROBE,
    nomePagador: NOME_PROBE,
    expiraEmMs,
    fuso: FUSO_FISCAL,
    tiposExcluidos: args.excluir,
    parcelasMaximas: args.parcelas,
    pagador: pagadorDaPreferencia(args.pagador),
  };
  const corpo = buildPreferenceRequest(entrada);

  log('');
  log(`  external_reference : ${pedidoId}`);
  if (args.pedidoId === null) {
    log('    FICTÍCIO: não existe pedido com esse id (use --pedido para reconciliar de verdade).');
  } else {
    log('    pedido REAL: o webhook vai reconciliar o pagamento NELE.');
  }
  log(`  metadata.link_id   : ${linkId}`);
  log(`  valor              : ${formatReais(VALOR_PROBE)}`);
  log(`  expira em          : ${corpo.expiration_date_to}`);
  log('  corpo que iria ao Mercado Pago (dados do pagador ocultos):');
  log(corpoParaLog(corpo));

  const valido = mpPreferenceRequestSchema.safeParse(corpo);
  if (!valido.success) {
    log('  FALHA  o corpo NÃO passa o schema estrito de requests.ts.');
    log(`    campos: ${caminhosInvalidos(valido.error.issues)}`);
    process.exitCode = 1;
    return;
  }
  log('  OK     o corpo passa o schema ESTRITO de requests.ts');

  if (s.ctx.conta.hasLinkPagamento !== true) {
    log('  ATENÇÃO  esta conta tem hasLinkPagamento != true: a rota criar a recusaria');
    log('    (metodoSemLink). O POST abaixo testa só o lado do Mercado Pago.');
  }
  if (!args.executar) {
    log('  (dry-run — NADA foi enviado ao Mercado Pago; passe --executar)');
    return;
  }

  const { api } = await s.abrirApi();
  let preferencia: MpPreference;
  try {
    preferencia = await api.createPreference(corpo);
  } catch (err) {
    if (!relatarErroHttp(err, 'POST /checkout/preferences')) throw err;
    return;
  }
  log('');
  imprimirPreferencia('preferência CRIADA (resposta do POST):', preferencia);
  log(`    init_point: ${preferencia.init_point}`);

  const base = `--project ${s.projectId} --metodo ${s.ctx.metodoId}`;
  log('');
  log('  Próximos passos (registre cada veredito no #367):');
  log('    P2  pague o init_point DUAS vezes (dois pagadores, ou cartão + Pix), R$ 1,00 cada;');
  log('    P3  confira, nos logs da task e em notificacoesMercadoPago, se a notificação chegou;');
  log(`    P4  pagamento ${base} --payment <id do pagamento>`);
  log(`    P5  preferencia ${base} --preferencia ${preferencia.id} --expirar --executar`);
}

/** The typed-by-hand P8 payer as the builder takes it (never a CPF, never foreign). */
function pagadorDaPreferencia(pagador: PagadorProbe | null): PreferenceInput['pagador'] {
  if (pagador === null) return null;
  return { ...pagador, cpfCnpj: null, estrangeiro: false };
}

/* -------------------------------- `pagamento` -------------------------------- */

interface PagamentoLido {
  id: string;
  aprovado: boolean;
  externalReference: string | null;
  linkId: string | null;
  orderId: string | null;
}

function idDoPedidoMercante(valor: unknown): string | null {
  if (typeof valor === 'string' && valor !== '') return valor;
  if (typeof valor === 'number') return String(valor);
  return null;
}

async function lerPagamento(
  api: MercadoPagoApi,
  userId: number | null,
  id: string,
): Promise<PagamentoLido | null> {
  let pagamento: MpPayment;
  try {
    pagamento = await api.getPayment(id);
  } catch (err) {
    if (!relatarErroHttp(err, `GET /v1/payments/${id}`)) throw err;
    return null;
  }

  const status = texto(pagamento.status);
  const linkId = texto(lerCaminho(pagamento, ['metadata', 'link_id']));
  const itemId = texto(lerCaminho(pagamento, ['additional_info', 'items', 0, 'id']));
  const descricao = texto(pagamento.description);
  const primeiroNome = texto(lerCaminho(pagamento, ['payer', 'first_name']));
  const titular = texto(lerCaminho(pagamento, ['card', 'cardholder', 'name']));
  const email = texto(lerCaminho(pagamento, ['payer', 'email']));
  const orderId = idDoPedidoMercante(lerCaminho(pagamento, ['order', 'id']));
  const coletor = inteiroPositivo(pagamento.collector_id);
  const externalReference = texto(pagamento.external_reference);
  const coletorConfere =
    coletor === null || userId === null ? 'indeterminado' : sn(coletor === userId);
  const linkIdValido = linkPagamentoIdSchema.safeParse(linkId).success;

  log('');
  log(`  pagamento ${id}`);
  log(`    status=${status ?? '?'}  status_detail=${texto(pagamento.status_detail) ?? '?'}`);
  log(`    live_mode=${String(pagamento.live_mode ?? '?')}`);
  log(`    payment_type_id=${texto(pagamento.payment_type_id) ?? '?'}`);
  log(`    payment_method_id=${texto(pagamento.payment_method_id) ?? '?'}`);
  log(`    transaction_amount=${String(pagamento.transaction_amount ?? '?')}`);
  log(`    external_reference=${JSON.stringify(externalReference)}`);
  log(`    collector_id == metodo_pgto.user_id: ${coletorConfere}`);
  log('      (P3/P9: o coletor é a conta que o webhook usa para achar o metodo_pgto)');
  log(`    P4  metadata: chaves=[${chavesDe(lerCaminho(pagamento, ['metadata'])).join(', ')}]`);
  log(`    P4  metadata.link_id presente=${sn(linkId !== null)}`);
  log(`        formato de linkPagamentoIdSchema=${sn(linkIdValido)}`);
  log(`    P4  additional_info.items[0].id presente=${sn(itemId !== null)}`);
  if (itemId !== null) {
    log(`        igual ao link_id=${sn(itemId === linkId)}`);
    log(`        igual ao external_reference=${sn(itemId === externalReference)}`);
  }
  log(`    P4  description presente=${sn(descricao !== null)}`);
  log(`        começa com "Pedido"=${sn(descricao?.startsWith('Pedido') ?? false)}`);
  log(`    P4  payer.first_name presente=${sn(primeiroNome !== null)}`);
  log(`        primeiro nome derivado=${JSON.stringify(extrairPrimeiroNome(primeiroNome))}`);
  log(`    P4  card.cardholder.name presente=${sn(titular !== null)}`);
  log(`        primeiro nome derivado=${JSON.stringify(extrairPrimeiroNome(titular))}`);
  log('    P4  nome que a tela mostraria (payer.first_name, senão o titular):');
  log(`        ${JSON.stringify(extrairPrimeiroNome(primeiroNome, titular))}`);
  log(`    P4  payer.email presente=${sn(email !== null)}  (o valor não é impresso)`);
  log(`    P2  order.id (merchant order)=${JSON.stringify(orderId)}`);

  return { id, aprovado: status === 'approved', externalReference, linkId, orderId };
}

/** P2: what several payments on ONE init_point tell us. */
function veredictoP2(lidos: readonly PagamentoLido[]): void {
  log('');
  log('  P2 — o mesmo init_point pago mais de uma vez');
  if (lidos.length < 2) {
    log('    Passe --payment duas (ou mais) vezes, uma por pagamento feito NO MESMO link.');
    return;
  }
  const links = new Set(lidos.map((l) => l.linkId ?? '(ausente)'));
  const referencias = new Set(lidos.map((l) => l.externalReference ?? '(ausente)'));
  const ordens = new Set(lidos.map((l) => l.orderId ?? '(ausente)'));
  const todosAprovados = lidos.every((l) => l.aprovado);
  log(`    pagamentos lidos      : ${lidos.length}  todos aprovados: ${sn(todosAprovados)}`);
  log(`    metadata.link_id      : ${[...links].join(' | ')}`);
  log(`    external_reference    : ${[...referencias].join(' | ')}`);
  log(`    merchant order (id)   : ${[...ordens].join(' | ')}`);
  if (todosAprovados && links.size === 1 && !links.has('(ausente)')) {
    log(`    LEITURA: ${lidos.length} pagamentos APROVADOS no mesmo link_id.`);
    log('      O Mercado Pago aceita pagar o mesmo init_point mais de uma vez: o modo');
    log('      compartilhado é viável, e o auto-close por quota é o que impede o excesso.');
  } else {
    log('    LEITURA: inconclusiva — falta pagamento aprovado, ou o link_id não veio/não');
    log('      coincide. NÃO habilite MERCADO_PAGO_LINK_COMPARTILHADO_ENABLED com base nisto.');
  }
}

async function comandoPagamento(s: Sessao, args: ArgsPagamento): Promise<void> {
  const { api } = await s.abrirApi();
  const lidos: PagamentoLido[] = [];
  for (const id of args.pagamentos) {
    const lido = await lerPagamento(api, s.userId, id);
    if (lido !== null) lidos.push(lido);
  }
  veredictoP2(lidos);
}

/* ------------------------------- `preferencia` ------------------------------- */

async function comandoPreferencia(s: Sessao, args: ArgsPreferencia): Promise<void> {
  const { api, token } = await s.abrirApi();
  const id = args.preferenciaId;

  const antes = await lerPreferencia(token, id);
  log('');
  if (!antes.ok) {
    const resposta = antes.status === null ? 'sem resposta' : `HTTP ${antes.status}`;
    log(`  FALHA  GET /checkout/preferences/${id}: ${resposta}`);
    log(`    ${antes.motivo}`);
    if (antes.status === 403 || antes.status === 404) {
      log('    P9: se a preferência é de OUTRA aplicação (a legada), o token novo não a enxerga.');
    }
    process.exitCode = 1;
    return;
  }
  imprimirPreferencia('estado ATUAL (GET /checkout/preferences/{id}):', antes.preferencia);
  const criadaPeloBuilder = presente(lerCaminho(antes.preferencia, ['metadata', 'link_id']));
  log(`    criada pelo builder desta feature (tem metadata.link_id): ${sn(criadaPeloBuilder)}`);

  if (!args.expirar) {
    log('  (somente leitura — passe --expirar [--executar] para o PUT de expiração)');
    return;
  }

  const patch = expirePatch(s.agoraMs);
  log('');
  log(`  PUT /checkout/preferences/${id}  ${JSON.stringify(patch)}`);
  if (!criadaPeloBuilder && !args.forcar) {
    log('  RECUSADO  a preferência não tem metadata.link_id: não foi feita por esta feature.');
    log('    É provavelmente um link LEGADO de cliente, e expirá-lo o mata de vez.');
    log('    Passe --forcar se o teste é justamente esse (P9).');
    process.exitCode = 1;
    return;
  }
  if (!args.executar) {
    log('  (dry-run — nada foi enviado; passe --executar)');
    return;
  }

  try {
    imprimirPreferencia('resposta do PUT:', await api.updatePreference(id, patch));
  } catch (err) {
    if (!relatarErroHttp(err, `PUT /checkout/preferences/${id}`)) throw err;
    return;
  }

  // ⚠️ Never trust the PUT's own answer: re-read and report what Mercado Pago STORED.
  const depois = await lerPreferencia(token, id);
  log('');
  if (!depois.ok) {
    log(`  FALHA  a releitura falhou: ${depois.motivo}`);
    process.exitCode = 1;
    return;
  }
  const guardada = depois.preferencia;
  imprimirPreferencia('o que o Mercado Pago GUARDOU (releitura):', guardada);
  log(`    expires guardado == true: ${sn(lerCaminho(guardada, ['expires']) === true)}`);
  log(`    expiration_date_to enviado : ${patch.expiration_date_to}`);
  log(`    expiration_date_to guardado: ${campoDaPreferencia(guardada, 'expiration_date_to')}`);
  log('');
  log('  P5 — agora, MANUALMENTE, com a preferência expirada:');
  log('    a) abra o init_point numa aba nova e tente pagar: deve ser recusado;');
  log('    b) se um checkout já estava ABERTO antes do PUT, tente concluí-lo;');
  log('    c) se um Pix já tinha sido GERADO antes do PUT, tente pagá-lo.');
  log('  Anote os três resultados no #367 e no docblock de `expirePatch`: decidem se');
  log('  cancelar e o auto-close realmente impedem um pagamento a mais.');
}

/* ---------------------------------- `busca` ---------------------------------- */

async function comandoBusca(s: Sessao, args: ArgsBusca): Promise<void> {
  const { api } = await s.abrirApi();
  const repeticoes = args.repetir ? 2 : 1;
  for (let n = 1; n <= repeticoes; n += 1) {
    log('');
    log(`  busca ${n}/${repeticoes}: external_reference=${args.referencia} limit=${args.limite}`);
    try {
      const resposta = await api.searchPayments({
        externalReference: args.referencia,
        offset: 0,
        limit: args.limite,
      });
      const itens = resposta.results ?? [];
      const doPedido = itens.filter((item) => item.external_reference === args.referencia);
      const total = String(resposta.paging?.total ?? '?');
      const limite = String(resposta.paging?.limit ?? '?');
      log(`    paging: total=${total} limit=${limite}`);
      log(`    results: ${itens.length}  (com external_reference igual: ${doPedido.length})`);
      const ids = itens.slice(0, 20).map((item) => item.id);
      log(`    ids: ${ids.join(', ')}${itens.length > 20 ? ', …' : ''}`);
    } catch (err) {
      // The SECOND identical search is expected to be refused (cause 2001): a result.
      if (!relatarErroHttp(err, 'GET /v1/payments/search', n > 1)) throw err;
    }
  }
  log('');
  log('  P7: o cliente sempre envia begin_date=NOW-360DAYS; aceito = sem erro 9062 acima.');
}

/* ----------------------------------- main ----------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ⛔ The credential must be the one issued for --project. Checked BEFORE anything
  // is initialised, so a mismatch cannot even open a Firestore handle.
  const projetoDaCredencial = projetoDaServiceAccount();
  if (projetoDaCredencial !== args.projectId) {
    throw new ProbeArgError(
      `A service account é do projeto "${projetoDaCredencial}", mas --project é ` +
        `"${args.projectId}". Recuso rodar com uma credencial emitida para outro projeto.`,
    );
  }
  process.env.FIREBASE_PROJECT_ID = args.projectId;

  const db = getAdminFirestore();
  const ctx = await loadMercadoPagoContext(db, args.metodoId);
  const userId = inteiroPositivo(ctx.conta.user_id);
  const temLink = ctx.conta.hasLinkPagamento === true;

  log(`[probe:link-pagamento] ${args.comando} project=${args.projectId} metodo=${args.metodoId}`);
  log(`  conta: user_id=${userId ?? '(ausente)'} hasLinkPagamento=${String(temLink)}`);
  log('  Ler o token pode RENOVAR a credencial da conta (o refresh do Mercado Pago rotaciona o');
  log('  refresh_token e o app o grava em metodo_pgto/.../credenciais): é a única escrita no');
  log('  Firestore que este script causa, e é a mesma que o backend faria.');

  const sessao: Sessao = {
    projectId: args.projectId,
    db,
    ctx,
    userId,
    agoraMs: nowMillis(),
    abrirApi: async () => {
      const token = await ctx.resolveAccessToken();
      return { api: createMercadoPagoApi({ getAccessToken: async () => token }), token };
    },
  };

  switch (args.comando) {
    case 'criar':
      await comandoCriar(sessao, args);
      break;
    case 'pagamento':
      await comandoPagamento(sessao, args);
      break;
    case 'preferencia':
      await comandoPreferencia(sessao, args);
      break;
    case 'busca':
      await comandoBusca(sessao, args);
      break;
  }
}

try {
  await main();
} catch (err) {
  if (
    err instanceof ProbeArgError ||
    err instanceof MercadoPagoContaNotConfiguredError ||
    err instanceof MercadoPagoConfigError
  ) {
    log(`FALHA  ${err.message}`);
    process.exitCode = 2;
  } else if (err instanceof MercadoPagoError) {
    log(`FALHA  ${err.name}: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
