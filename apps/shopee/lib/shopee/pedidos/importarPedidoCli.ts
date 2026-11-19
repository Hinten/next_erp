/**
 * The pure half of `scripts/importar-pedido.ts` — argument parsing, the
 * **redacted** summary shape, its renderer and the error describer.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`vitest.config.ts`:
 * `{app,lib,functions}/**\/*.test.ts`), so logic written in a script file can
 * never be tested. Same reasoning, same shape as
 * `apps/mercado-livre/lib/marketplace/pedidos/pedidoMoneyAudit.ts`, which its
 * own `inspect-pedido.ts` says out loud. The script keeps the I/O and nothing
 * else.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle** — the
 * `lib/shopee/testing/fakeDb.ts` and `lib/shopee/fixtures/` precedent. Nothing
 * here reads `process.env`, opens a client or touches Firestore.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * Neither summary builder below copies an input object. Every field of
 * {@link ResumoPedidoShopee} is named and constructed one at a time, so a field
 * that is not listed cannot appear in the output — including a field a future
 * schema change adds to the pedido, and including everything a Shopee buyer
 * authored. A denylist would have the opposite property: it protects the fields
 * somebody remembered.
 *
 * Three fields deserve their own sentence:
 *
 *  - **`observacoesInternas` is reduced to its LENGTH.** It is composed from
 *    the seller's own `note` and the BUYER's `message_to_seller`, and a buyer
 *    who types their address into the message box is not a hypothetical. The
 *    character count is enough to answer "did the field arrive".
 *  - **`capturaComprador` rides VERBATIM**, because it structurally cannot
 *    carry a value: `comprador.ts` writes `<campo>:<veredito>` pairs — field
 *    NAMES and verdicts — and never the value it judged.
 *  - **`nomeDeVenda` is omitted from the item rows** although it is not buyer
 *    data. The importer's own one-line log excludes the product title for the
 *    same reason (a log stream and a terminal transcript both get pasted into
 *    issues), and `sku` + `mktplaceId` identify the line unambiguously.
 *
 * ⚠️ **ONE deliberate exception, and it is fenced three ways.** The TEST buyer
 * mode (`--importar-cliente`) exists so a human can SEE what the sandbox sends,
 * so {@link valoresEnviadosPelaShopee} prints `recipient_address` verbatim — to
 * STDERR only (the script never routes it to stdout or `--json`), only in buyer
 * mode, and only with the sandbox override on and a real region the mode
 * accepts (two uppercase letters, not `BR`), where the buyer is a sandbox
 * fixture. Everything else that mode prints is a verdict,
 * a name or a count: never the CPF, the name, the street or the CEP digits.
 */
import { formatReais } from '@delfrance/core/money';
import { microsToMillis } from '@delfrance/core/datetime';
import {
  CAPTURA_COMPRADOR_ESTADO,
  ENDERECO_FALLBACKS,
  FORMA_PAGAMENTO_LABELS,
  STATUS_PAGAMENTO_LABELS,
  idFromRef,
  idFromRefOrNull,
  normalizeNome,
  sanitizeCep,
  toDocPathOrNull,
  valorUtilizavel,
  type CapturaCompradorEstado,
  type EnderecoBuildOutcome,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
} from '@delfrance/integrations-shopee';

import {
  SimulacaoCompradorRecusadaError,
  regiaoEstrangeiraParaSimulacao,
  type CapturaComprador,
  type EnderecoShopee,
  type PortoesEnderecoShopee,
  type SimulacaoCompradorShopee,
} from './comprador';
// Types only — erased, so `--help` still loads none of the importer's graph.
import type {
  PreparoPedidoShopee,
  ResultadoImportacaoPedidoShopee,
  SimulacaoAplicadaShopee,
} from './importarPedido';
import { vazio, type PedidoMapeadoShopee } from './orderMapping';
import { ALVO_STATUS_PAGAMENTO_SHOPEE, type PagamentosMapeadosShopee } from './pagamentoMapping';

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv`
 * itself, so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — including inside this string.
 */
export const USO_IMPORTAR_PEDIDO = `
Importa UMA order da Shopee para um pedido do ERP, pelo caminho real do step 5.

  pnpm --filter @delfrance/shopee-app importar:pedido \\
    --integracao <integracaoId> --order-sn <orderSn> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --order-sn <sn>     a order da Shopee (ex.: 220810QSK8S7BX)

Opções
  --dry-run           lê e mapeia, NÃO grava nada. É o PADRÃO.
  --live              GRAVA: roda o importador de verdade (pedido, cliente,
                      endereço e incidentes), depois relê o pedido.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.

Modo comprador de TESTE — só no sandbox, só numa order de região não-BR
  --importar-cliente  simula um comprador brasileiro: o CPF que a Shopee mandar,
                      se utilizável, senão um CPF de teste; cria e vincula o
                      cliente. Com --live, exige --project e uma conta de
                      serviço emitida para esse projeto.
  --importar-endereco também grava o endereço (exige --importar-cliente).
  --nome-teste <nome> troca SÓ o nome do destinatário (exige --importar-cliente).
  --cep-teste <cep>   troca SÓ o CEP, 8 dígitos sem traço (exige
                      --importar-cliente).

O dry-run continua CHAMANDO a Shopee (get_order_detail + get_escrow_detail) e
lendo o Firestore — ele não grava. Ver apps/shopee/scripts/README.md.
`.trim();

/** A malformed command line. Never a Shopee or a Firestore failure. */
export class ArgumentoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentoInvalidoError';
  }
}

export interface ArgsImportarPedido {
  readonly integracaoId: string;
  readonly orderSn: string;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  readonly json: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
  /**
   * The TEST buyer mode (`--importar-cliente` and its dependents). ABSENT —
   * not `null` — on every normal command line, so the args of a run that never
   * named it are byte-identical to what they were before the mode existed.
   */
  readonly comprador?: SimulacaoCompradorShopee;
}

/** `--cep-teste`: the 8 digits `enderecoSchema.cep` stores, and nothing else. */
const CEP_TESTE = /^\d{8}$/;

export type ComandoImportarPedido =
  | { readonly kind: 'ajuda' }
  | { readonly kind: 'importar'; readonly args: ArgsImportarPedido };

/**
 * A boolean flag is its own spelling and nothing else: `--live=false` would
 * otherwise read as `--live` (the switch matches the text before `=`) and RUN
 * LIVE. Any inline value is refused — a contradiction, like `--live --dry-run`.
 */
function semValor(nome: string, inline: string | undefined): true {
  if (inline !== undefined) throw new ArgumentoInvalidoError(`${nome} não aceita valor.`);
  return true;
}

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` on its own
 * exits 0 instead of complaining about the two required flags. The script's
 * side of that bargain is to return before it opens the admin app.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the
 * readers of the command line would expect the other.
 */
export function parseArgsImportarPedido(argv: readonly string[]): ComandoImportarPedido {
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'ajuda' };

  let integracaoId: string | undefined;
  let orderSn: string | undefined;
  let projectId: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let json = false;
  let importarCliente = false;
  let importarEndereco = false;
  let nomeTeste: string | undefined;
  let cepTeste: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--integracao':
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--order-sn':
        orderSn = valorDe('order-sn', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = semValor(nome, inline);
        break;
      case '--dry-run':
        dryRunExplicito = semValor(nome, inline);
        break;
      case '--json':
        json = semValor(nome, inline);
        break;
      case '--importar-cliente':
        importarCliente = semValor(nome, inline);
        break;
      case '--importar-endereco':
        importarEndereco = semValor(nome, inline);
        break;
      case '--nome-teste':
        nomeTeste = valorDe('nome-teste', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--cep-teste':
        cepTeste = valorDe('cep-teste', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }
  // A dependent flag alone is a contradiction too: it would be silently inert.
  if (!importarCliente) {
    for (const [presente, flag] of [
      [importarEndereco, '--importar-endereco'],
      [nomeTeste !== undefined, '--nome-teste'],
      [cepTeste !== undefined, '--cep-teste'],
    ] as const) {
      if (presente) throw new ArgumentoInvalidoError(`${flag} exige --importar-cliente.`);
    }
  }
  if (cepTeste !== undefined && !CEP_TESTE.test(cepTeste)) {
    throw new ArgumentoInvalidoError('--cep-teste exige exatamente 8 dígitos, sem traço.');
  }
  if (integracaoId == null) {
    throw new ArgumentoInvalidoError('--integracao <integracaoId> é obrigatório.');
  }
  if (orderSn == null) throw new ArgumentoInvalidoError('--order-sn <orderSn> é obrigatório.');

  return {
    kind: 'importar',
    args: {
      integracaoId,
      orderSn,
      live,
      json,
      projectId: projectId ?? null,
      ...(importarCliente
        ? {
            comprador: {
              nomeTeste: nomeTeste ?? null,
              cepTeste: cepTeste ?? null,
              importarEndereco,
            },
          }
        : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                      the TEST buyer mode — the guards                       */
/* -------------------------------------------------------------------------- */

// The sandbox guard and the refusal class live beside the simulation in
// `comprador.ts` (the importer re-checks with the same function); re-exported
// so the script's one static import stays this module.
export { SimulacaoCompradorRecusadaError, exigirSandboxParaSimulacao } from './comprador';

/**
 * The project the admin credential was ISSUED for, or `null` when it names
 * none (application default credentials). `cert()`'s credential carries it as
 * `projectId`; anything else answers `null` rather than a guess.
 */
export function projetoDaCredencial(credencial: unknown): string | null {
  if (typeof credencial !== 'object' || credencial === null) return null;
  const projeto = (credencial as { readonly projectId?: unknown }).projectId;
  return typeof projeto === 'string' && projeto.length > 0 ? projeto : null;
}

/** The project the `--live` buyer mode writes to, as the script resolved it. */
export interface ProjetoDoModoComprador {
  /** `--project`, or `null` when it was not passed. */
  readonly projetoPedido: string | null;
  /** What the admin app resolved (`app.options.projectId`). */
  readonly projetoResolvido: string | null;
  /** {@link projetoDaCredencial} of the admin app's credential. */
  readonly projetoDaCredencial: string | null;
}

/**
 * `--live` in buyer mode writes a cliente under a fake document, so the project
 * must be NAMED, not inherited — `tools/migrations/src/admin.ts`'s rule: an
 * explicit `--project`, equal to what the admin app resolved, AND a service
 * account issued for that same project.
 *
 * ⚠️ The credential leg is the one that bites. The script copies `--project`
 * into `FIREBASE_PROJECT_ID` before the admin app exists, and that variable is
 * the resolver's FIRST source, so "requested equals resolved" can hardly fail
 * from there. Application default credentials (a gcloud login, or
 * `GOOGLE_APPLICATION_CREDENTIALS`) name NO project and may reach any project —
 * production included — so a credential that names none is REFUSED, exactly as
 * `tools/migrations` refuses to run without a service account.
 */
export function exigirProjetoDoModoComprador(args: ProjetoDoModoComprador): void {
  const { projetoPedido, projetoResolvido } = args;
  if (projetoPedido === null) {
    throw new SimulacaoCompradorRecusadaError(
      '--importar-cliente com --live exige --project <id> explícito: o projeto não é herdado ' +
        'do ambiente quando a execução grava um cliente de teste.',
    );
  }
  if (projetoResolvido !== projetoPedido) {
    throw new SimulacaoCompradorRecusadaError(
      `--project ${projetoPedido} não é o projeto que o admin resolveu ` +
        `(${projetoResolvido ?? 'nenhum'}). Nada foi gravado.`,
    );
  }
  if (args.projetoDaCredencial === null) {
    throw new SimulacaoCompradorRecusadaError(
      '--importar-cliente com --live exige uma conta de serviço (FIREBASE_SERVICE_ACCOUNT ou ' +
        'FIREBASE_SERVICE_ACCOUNT_PATH) emitida para --project: credenciais padrão do ambiente ' +
        'não dizem de qual projeto são. Nada foi gravado.',
    );
  }
  if (args.projetoDaCredencial !== projetoPedido) {
    throw new SimulacaoCompradorRecusadaError(
      `A credencial de serviço é do projeto ${args.projetoDaCredencial}, não de --project ` +
        `${projetoPedido}. Nada foi gravado.`,
    );
  }
}

/** A stored buyer ref counts as LINKED exactly where fill-once would not write (`vazio`). */
function vinculado(valor: unknown): boolean {
  return !vazio(valor);
}

/**
 * The stored capture that leaves a TEST run nothing to do, else `null` (absent
 * pedido included):
 *
 *  - `expirado` — always: a diary whose next write would mix a real verdict
 *    with a simulated one;
 *  - `capturado` — only when nothing is left to FILL: the cliente is linked and
 *    either the endereço is too or `--importar-endereco` was not passed. A
 *    `capturado` pedido still missing its endereço is NOT refused — fill-once
 *    writes the endereço under the linked cliente, which
 *    {@link exigirPedidoSemVinculoAlheio} has proved is the test buyer — so
 *    `--nome-teste` first and `--importar-endereco` on a later run works.
 *
 * `pendente` is never terminal: a run without substitutes stores it, and a
 * re-run with `--nome-teste` links.
 */
export function capturaTerminalDoPedido(
  armazenado: Record<string, unknown> | null,
  importarEndereco: boolean,
): CapturaCompradorEstado | null {
  const estado = objeto(armazenado?.capturaComprador)?.estado;
  if (estado === CAPTURA_COMPRADOR_ESTADO.expirado) return CAPTURA_COMPRADOR_ESTADO.expirado;
  if (estado !== CAPTURA_COMPRADOR_ESTADO.capturado) return null;
  const restaPreencher =
    !vinculado(armazenado?.clientePedidoOuterRef) ||
    (importarEndereco && !vinculado(armazenado?.enderecoFiscalOuterRef));
  return restaPreencher ? null : CAPTURA_COMPRADOR_ESTADO.capturado;
}

export function exigirPedidoSemCapturaTerminal(
  armazenado: Record<string, unknown> | null,
  importarEndereco: boolean,
): void {
  const estado = capturaTerminalDoPedido(armazenado, importarEndereco);
  if (estado === null) return;
  const dica =
    estado === CAPTURA_COMPRADOR_ESTADO.capturado &&
    !importarEndereco &&
    !vinculado(armazenado?.enderecoFiscalOuterRef)
      ? ' (o endereço ainda não foi gravado: passe --importar-endereco para gravá-lo)'
      : '';
  throw new SimulacaoCompradorRecusadaError(
    `o pedido já existe e a captura do comprador já terminou (${estado})${dica}; use um pedido ` +
      'de teste novo.',
  );
}

/**
 * What the stored pedido links that this run cannot attribute to the TEST
 * buyer, or `null` when nothing is in the way.
 *
 * ⚠️ Why it matters: over a stored cliente `resolverComprador` SKIPS
 * `findOrCreateCliente`, so the collision check protects nothing, and
 * `--importar-endereco` writes the simulated address UNDER that cliente — then
 * links it as the fiscal and delivery address and latches a `capturado` Shopee
 * never made, on a cliente this run never resolved (an operator can set
 * `clientePedidoOuterRef` by hand, and that group sits outside the
 * `hasUserInteraction` freeze). A stored cliente is attributable only when it
 * is one of the document's holders under the SAME name — the
 * {@link decidirColisaoDeDocumento} `mesmo-nome` answer, i.e. a previous test
 * run's cliente; a stored endereço only beside such a cliente.
 */
export function vinculoAlheioDoPedido(
  armazenado: Record<string, unknown> | null,
  colisao: ColisaoDeDocumento | null,
): { readonly clienteId: string | null } | null {
  const cliente = armazenado?.clientePedidoOuterRef;
  if (!vinculado(cliente) && !vinculado(armazenado?.enderecoFiscalOuterRef)) return null;
  const clienteId = idFromRefOrNull(cliente);
  const doTeste = colisao?.kind === 'mesmo-nome' ? colisao.clienteIds : [];
  if (clienteId !== null && doTeste.includes(clienteId)) return null;
  return { clienteId };
}

export function exigirPedidoSemVinculoAlheio(
  armazenado: Record<string, unknown> | null,
  colisao: ColisaoDeDocumento | null,
): void {
  const alheio = vinculoAlheioDoPedido(armazenado, colisao);
  if (alheio === null) return;
  throw new SimulacaoCompradorRecusadaError(
    `o pedido já tem cliente/endereço vinculado (cliente ${alheio.clienteId ?? '—'}) que não é ` +
      'o comprador de teste desta execução; use um pedido de teste novo. Nada foi gravado.',
  );
}

/** One cliente already holding the document the test mode would use. */
export interface DonoDoDocumento {
  readonly clienteId: string;
  /** The STORED `nome`, raw — compared through `normalizeNome`, never printed. */
  readonly nome: unknown;
}

export type ColisaoDeDocumento =
  /** Nobody holds it: `findOrCreateCliente` will create. */
  | { readonly kind: 'livre' }
  /** Every holder carries the same normalized name: an idempotent re-run converges. */
  | { readonly kind: 'mesmo-nome'; readonly clienteIds: readonly string[] }
  /** At least one holder is somebody else: the run would link to a stranger. */
  | { readonly kind: 'colisao'; readonly clienteIds: readonly string[] };

/**
 * Would the test run link to a cliente that is NOT the test buyer?
 *
 * `findOrCreateCliente`'s first leg matches ANY holder of the document (no
 * other strong key is sent, so none can contradict), so one holder with another
 * name is a collision. The fold is `normalizeNome` and nothing more: equal =
 * trimmed and whitespace-collapsed; distinct = any other difference, case and
 * accents INCLUDED, because that is exactly what the stored name holds.
 */
export function decidirColisaoDeDocumento(
  donos: readonly DonoDoDocumento[],
  nomeDoComprador: string,
): ColisaoDeDocumento {
  if (donos.length === 0) return { kind: 'livre' };
  const nome = normalizeNome(nomeDoComprador);
  const outros = donos
    .filter((d) => nome === null || normalizeNome(d.nome) !== nome)
    .map((d) => d.clienteId)
    .sort();
  if (outros.length > 0) return { kind: 'colisao', clienteIds: outros };
  return { kind: 'mesmo-nome', clienteIds: donos.map((d) => d.clienteId).sort() };
}

/** The refusal for {@link decidirColisaoDeDocumento}'s `colisao` — ids only, never a name. */
export function exigirDocumentoSemColisao(decisao: ColisaoDeDocumento): void {
  if (decisao.kind !== 'colisao') return;
  throw new SimulacaoCompradorRecusadaError(
    `o documento que o modo de teste usaria já pertence a outro cliente ` +
      `(${decisao.clienteIds.join(', ')}). Passe --nome-teste "<o nome desse cliente>" para ` +
      'reusá-lo, ou apague esse cliente e os endereços dele no console (o seed de dev grava ' +
      'um cliente com o CPF de teste). Nada foi gravado.',
  );
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

export interface LinhaResumoShopee {
  readonly ordem: number | null;
  readonly mktplaceId: string | null;
  readonly produtoUid: string | null;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly precoDeVenda: number | null;
  readonly descontoUnitario: number | null;
  readonly quantidade: number | null;
}

export interface VolumeResumoShopee {
  readonly numero: string | null;
  readonly pesoBrutoKg: number | null;
}

export interface FreteResumoShopee {
  readonly estado: string | null;
  readonly modalidade: string | null;
  readonly integradora: string | null;
  readonly externalId: string | null;
  readonly externalOptionId: string | null;
  readonly valorCobrado: number | null;
  readonly custoCalculado: number | null;
  readonly custoFinal: number | null;
  readonly codRastreio: string | null;
  readonly prazoDespachoUs: number | null;
  readonly dataPrevisaoEntregaUs: number | null;
  readonly ultimaModificacaoUs: number | null;
  readonly volumes: readonly VolumeResumoShopee[];
  /**
   * The conta's `int_frete` doc, as an outer-ref (an id). On `mapeado` it is
   * what the read-only half found — off the mapped block, never a second lookup
   * — and only a CREATE writes it; on `armazenado` it is what the pedido holds.
   */
  readonly integracaoFreteOuterRef: string | null;
  /** The delivery address, as an outer-ref (ids) — the fiscal one, filled once. */
  readonly enderecoFreteOuterReference: string | null;
}

/** One pedido, reduced to what a rehearsal needs and nothing a buyer authored. */
export interface ResumoPedidoShopee {
  /** `mapeado` = what a write WOULD store; `armazenado` = what is stored. */
  readonly origem: 'mapeado' | 'armazenado';
  readonly pedidoId: string;
  readonly numero: string | null;
  readonly orderStatus: string | null;
  /** `mapeado` only — the estado the ladder targets, or why it refuses one. */
  readonly alvoEstado: string | null;
  /** `armazenado` only — the estado the document holds. */
  readonly estadoArmazenado: string | null;
  readonly lastMarketplaceUpdateUs: number | null;
  readonly timestampUs: number | null;
  readonly marketplace: {
    readonly tipo: string | null;
    readonly status: string | null;
    readonly statusEmUs: number | null;
    readonly pendingTerms: readonly string[] | null;
    readonly completedScenario: string | null;
    readonly cancelReason: string | null;
    readonly cancelBy: string | null;
  };
  readonly capturaComprador: {
    readonly estado: string | null;
    readonly statusObservado: string | null;
    readonly camposRecusados: readonly string[];
    readonly camposRecusadosExtra: readonly string[];
  };
  readonly erro: string | null;
  readonly valorCobrado: number | null;
  readonly descontoTotal: number | null;
  /** REDACTED: the character count, never the text. */
  readonly observacoesInternasChars: number | null;
  readonly integracaoPedidoOuterRef: string | null;
  readonly listaDePrecosOuterRef: string | null;
  readonly operacaoPedidoOuterRef: string | null;
  readonly clientePedidoOuterRef: string | null;
  readonly enderecoFiscalOuterRef: string | null;
  readonly ehSaida: boolean | null;
  readonly bloquearEmissaoNFe: boolean | null;
  readonly frete: FreteResumoShopee | null;
  readonly itens: readonly LinhaResumoShopee[];
}

/**
 * One pagamento, reduced the same ALLOW-LIST way (#1514, step 6).
 *
 * ⚠️ Three fields of the `cartao` block are the reason this type exists at all,
 * and all three are BOOLEANS:
 *
 *  - **`temCnpjInstituicao`, never the digits.** It is
 *    `payment_info[].payment_processor_register` — the payment processor's CNPJ.
 *    The importer's own log excludes it and a terminal transcript is pasted into
 *    issues exactly like a log stream is.
 *  - **`temCAut`, never the code.** `transaction_id` is the card authorization
 *    code; it reaches the signed XML and nowhere else.
 *  - **`temCartao`, never the block** — printing the map would carry both of the
 *    above by accident, which is the failure mode an allow-list exists to make
 *    impossible.
 *
 * `bandeira` DOES ride verbatim: it is a two-character CATALOGUE code
 * (`'01'`…`'99'`) from a closed enum, not a value anybody authored.
 */
export interface PagamentoResumoShopee {
  readonly docId: string;
  /** The `id` FIELD — `order_sn` on the primary, `<order_sn>-<n>` on a sibling. */
  readonly idCampo: string | null;
  readonly formaCodigo: number | null;
  readonly formaLabel: string | null;
  readonly statusCodigo: number | null;
  readonly statusLabel: string | null;
  readonly valor: number | null;
  readonly parcelas: number | null;
  readonly aVista: boolean | null;
  readonly tarifas: number | null;
  /** Forma 99 only — `Shopee: <método>`, and the NF-e's `xPag`. */
  readonly descricaoPagamento: string | null;
  readonly temCartao: boolean;
  readonly bandeira: string | null;
  readonly temCnpjInstituicao: boolean;
  readonly temCAut: boolean;
  readonly dataAprovacaoUs: number | null;
  readonly dataCancelamentoUs: number | null;
  /** Whether the weekly settlement sweep has already stamped this payment. */
  readonly temLiquidacao: boolean;
  /** The PRE-CLAMP `tarifas`, out of the `marketplace` diary. */
  readonly tarifasBrutas: number | null;
}

/* ------------------------------ raw readers ------------------------------- */

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function booleano(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function textos(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/* ---------------------------- from the mapping ---------------------------- */

/** What `--dry-run` prints: the four write groups a live run would apply. */
export function resumoDoPedidoMapeado(
  pedidoId: string,
  mapeado: PedidoMapeadoShopee,
): ResumoPedidoShopee {
  const { sempre, dados, preencherUmaVez, criacao, alvo } = mapeado;
  return {
    origem: 'mapeado',
    pedidoId,
    numero: mapeado.numero,
    orderStatus: mapeado.orderStatus,
    alvoEstado: alvo.tipo === 'estado' ? alvo.estado : `(${alvo.tipo})`,
    estadoArmazenado: null,
    // The mapper writes ONE watermark for the document, and `orderPedidoTx`
    // asserts `marketplace.statusEm` equals it — so naming it twice here is a
    // rendering convenience, never a second source.
    lastMarketplaceUpdateUs: sempre.marketplace.statusEm,
    timestampUs: preencherUmaVez.timestamp,
    marketplace: {
      tipo: sempre.marketplace.tipo,
      status: sempre.marketplace.status,
      statusEmUs: sempre.marketplace.statusEm,
      pendingTerms: sempre.marketplace.pendingTerms,
      completedScenario: sempre.marketplace.completedScenario,
      cancelReason: sempre.marketplace.cancelReason,
      cancelBy: sempre.marketplace.cancelBy,
    },
    capturaComprador: {
      estado: sempre.capturaComprador.estado,
      statusObservado: sempre.capturaComprador.statusObservado,
      camposRecusados: sempre.capturaComprador.camposRecusados,
      camposRecusadosExtra: sempre.capturaComprador.camposRecusadosExtra,
    },
    erro: sempre.erro.tipo === 'definir' ? sempre.erro.mensagem : '(limpar-se-nosso)',
    valorCobrado: dados.valorCobrado,
    descontoTotal: dados.descontoTotal,
    observacoesInternasChars: dados.observacoesInternas?.length ?? null,
    integracaoPedidoOuterRef: preencherUmaVez.integracaoPedidoOuterRef,
    listaDePrecosOuterRef: preencherUmaVez.listaDePrecosOuterRef,
    operacaoPedidoOuterRef: preencherUmaVez.operacaoPedidoOuterRef,
    clientePedidoOuterRef: preencherUmaVez.clientePedidoOuterRef,
    enderecoFiscalOuterRef: preencherUmaVez.enderecoFiscalOuterRef,
    ehSaida: criacao.ehSaida,
    bloquearEmissaoNFe: criacao.bloquearEmissaoNFe,
    frete: {
      estado: dados.freteInicial.estado,
      modalidade: dados.freteInicial.modalidade,
      integradora: dados.freteInicial.externalOptionIntegracao,
      externalId: dados.freteInicial.externalId,
      externalOptionId: dados.freteInicial.externalOptionId,
      valorCobrado: dados.freteInicial.valorCobrado,
      custoCalculado: dados.freteInicial.custoCalculado,
      custoFinal: dados.freteInicial.custoFinal,
      codRastreio: dados.freteInicial.codRastreio,
      prazoDespachoUs: dados.freteInicial.prazoDespacho,
      dataPrevisaoEntregaUs: dados.freteInicial.dataPrevisaoEntrega,
      ultimaModificacaoUs: dados.freteInicial.ultimaModificacao,
      volumes: (dados.freteInicial.volumes ?? []).map((v) => ({
        numero: v.numero,
        pesoBrutoKg: v.pesoBruto,
      })),
      integracaoFreteOuterRef: dados.freteInicial.integracaoFreteOuterRef,
      enderecoFreteOuterReference: dados.freteInicial.enderecoFreteOuterReference,
    },
    itens: dados.itens.map((item) => ({
      ordem: item.ordem,
      mktplaceId: item.mktplaceId,
      produtoUid: item.produtoUid,
      sku: item.sku,
      gtin: item.gtin,
      precoDeVenda: item.precoDeVenda,
      descontoUnitario: item.descontoUnitario,
      quantidade: item.quantidade,
    })),
  };
}

/**
 * The pagamento set a live run WOULD write, straight off the pure mapper.
 *
 * ⚠️ `statusCodigo` is the LADDER'S TARGET, not a verdict: what actually lands
 * depends on what the document already holds, and only the transaction knows
 * that. `dataCancelamentoUs` and `temLiquidacao` are therefore always `null` /
 * `false` here — neither is knowable before the write.
 */
export function resumoDosPagamentosMapeados(
  mapeados: PagamentosMapeadosShopee,
): PagamentoResumoShopee[] {
  return mapeados.docs.map((m) => {
    const alvo = m.sempre.alvoStatus;
    const status = alvo.tipo === ALVO_STATUS_PAGAMENTO_SHOPEE.status ? alvo.status : null;
    return {
      docId: m.docId,
      idCampo: m.preencherUmaVez.id,
      formaCodigo: m.dados.forma_de_pagamento,
      formaLabel: FORMA_PAGAMENTO_LABELS[m.dados.forma_de_pagamento] ?? null,
      statusCodigo: status,
      statusLabel: status == null ? null : (STATUS_PAGAMENTO_LABELS[status] ?? null),
      valor: m.dados.valor,
      parcelas: m.dados.parcelas,
      aVista: m.dados.aVista,
      tarifas: m.sempre.tarifas ?? null,
      descricaoPagamento: m.dados.descricaoPagamento,
      temCartao: m.dados.cartao !== undefined,
      bandeira: m.dados.cartao?.bandeira ?? null,
      temCnpjInstituicao: m.dados.cartao?.cnpj_instituicao != null,
      temCAut: m.dados.cartao?.cAut != null,
      dataAprovacaoUs: m.datas.dataAprovacao ?? null,
      dataCancelamentoUs: null,
      temLiquidacao: false,
      tarifasBrutas: m.sempre.marketplace?.tarifasBrutas ?? null,
    };
  });
}

/**
 * The same summary read back from what Firestore actually holds — raw data, so
 * every field goes through a defensive reader and a document missing every key
 * still renders.
 *
 * ⚠️ It lists EVERY document in the subcollection, including a migrated legacy
 * `<order_sn>-desconto` sibling this importer never writes: the NF-e sums the
 * whole collection, so a rehearsal that hid the siblings would hide the only
 * thing that can put Σ pagante off the nota.
 */
export function resumoDosPagamentosArmazenados(
  docs: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
): PagamentoResumoShopee[] {
  return docs.map(({ id, data }) => {
    const cartao = objeto(data.cartao);
    const marketplace = objeto(data.marketplace);
    const forma = numero(data.forma_de_pagamento);
    const status = numero(data.status_pagamento);
    return {
      docId: id,
      idCampo: texto(data.id),
      formaCodigo: forma,
      formaLabel: forma == null ? null : (FORMA_PAGAMENTO_LABELS[forma as FormaPagamento] ?? null),
      statusCodigo: status,
      statusLabel:
        status == null ? null : (STATUS_PAGAMENTO_LABELS[status as StatusPagamento] ?? null),
      valor: numero(data.valor),
      parcelas: numero(data.parcelas),
      aVista: booleano(data.aVista),
      tarifas: numero(data.tarifas),
      descricaoPagamento: texto(data.descricaoPagamento),
      temCartao: cartao !== null,
      bandeira: cartao === null ? null : texto(cartao.bandeira),
      temCnpjInstituicao: cartao !== null && texto(cartao.cnpj_instituicao) !== null,
      temCAut: cartao !== null && texto(cartao.cAut) !== null,
      dataAprovacaoUs: numero(data.dataAprovacao),
      dataCancelamentoUs: numero(data.dataCancelamento),
      temLiquidacao: objeto(data.liquidacao) !== null,
      tarifasBrutas: marketplace === null ? null : numero(marketplace.tarifasBrutas),
    };
  });
}

/* --------------------------- from the stored doc --------------------------- */

/**
 * The same summary, read back from what Firestore actually holds after a live
 * run — raw data, so every field goes through a defensive reader.
 *
 * ⚠️ It reads the STORED shape, not the mapped one: `itens` is a map keyed by
 * `produtoUid` (with the unbound lines under `NONE`) rather than a flat array.
 */
export function resumoDoPedidoArmazenado(
  pedidoId: string,
  doc: Record<string, unknown>,
): ResumoPedidoShopee {
  const marketplace = objeto(doc.marketplace) ?? {};
  const captura = objeto(doc.capturaComprador) ?? {};
  const frete = objeto(doc.freteInicial);

  return {
    origem: 'armazenado',
    pedidoId,
    numero: texto(doc.numero),
    orderStatus: texto(marketplace.status),
    alvoEstado: null,
    estadoArmazenado: texto(doc.estado),
    lastMarketplaceUpdateUs: numero(doc.lastMarketplaceUpdate),
    timestampUs: numero(doc.timestamp),
    marketplace: {
      tipo: texto(marketplace.tipo),
      status: texto(marketplace.status),
      statusEmUs: numero(marketplace.statusEm),
      pendingTerms: marketplace.pendingTerms == null ? null : textos(marketplace.pendingTerms),
      completedScenario: texto(marketplace.completedScenario),
      cancelReason: texto(marketplace.cancelReason),
      cancelBy: texto(marketplace.cancelBy),
    },
    capturaComprador: {
      estado: texto(captura.estado),
      statusObservado: texto(captura.statusObservado),
      camposRecusados: textos(captura.camposRecusados),
      camposRecusadosExtra: textos(captura.camposRecusadosExtra),
    },
    erro: texto(doc.error),
    valorCobrado: numero(doc.valorCobrado),
    descontoTotal: numero(doc.descontoTotal),
    observacoesInternasChars: texto(doc.observacoesInternas)?.length ?? null,
    integracaoPedidoOuterRef: texto(doc.integracaoPedidoOuterRef),
    listaDePrecosOuterRef: texto(doc.listaDePrecosOuterRef),
    operacaoPedidoOuterRef: texto(doc.operacaoPedidoOuterRef),
    clientePedidoOuterRef: texto(doc.clientePedidoOuterRef),
    enderecoFiscalOuterRef: texto(doc.enderecoFiscalOuterRef),
    ehSaida: booleano(doc.ehSaida),
    bloquearEmissaoNFe: booleano(doc.bloquearEmissaoNFe),
    frete:
      frete === null
        ? null
        : {
            estado: texto(frete.estado),
            modalidade: texto(frete.modalidade),
            integradora: texto(frete.externalOptionIntegracao),
            externalId: texto(frete.externalId),
            externalOptionId: texto(frete.externalOptionId),
            valorCobrado: numero(frete.valorCobrado),
            custoCalculado: numero(frete.custoCalculado),
            custoFinal: numero(frete.custoFinal),
            codRastreio: texto(frete.codRastreio),
            prazoDespachoUs: numero(frete.prazoDespacho),
            dataPrevisaoEntregaUs: numero(frete.dataPrevisaoEntrega),
            ultimaModificacaoUs: numero(frete.ultimaModificacao),
            volumes: (Array.isArray(frete.volumes) ? frete.volumes : []).map((v) => {
              const vol = objeto(v) ?? {};
              return { numero: texto(vol.numero), pesoBrutoKg: numero(vol.pesoBruto) };
            }),
            integracaoFreteOuterRef: texto(frete.integracaoFreteOuterRef),
            enderecoFreteOuterReference: texto(frete.enderecoFreteOuterReference),
          },
    itens: linhasDoArmazenado(doc.itens),
  };
}

/** The stored `itens` map, flattened and reduced. Defensive at every level. */
function linhasDoArmazenado(v: unknown): LinhaResumoShopee[] {
  const mapa = objeto(v);
  if (mapa === null) return [];
  const linhas: LinhaResumoShopee[] = [];
  for (const [chave, lista] of Object.entries(mapa)) {
    if (!Array.isArray(lista)) continue;
    for (const bruto of lista) {
      const item = objeto(bruto);
      if (item === null) continue;
      linhas.push({
        ordem: numero(item.ordem),
        mktplaceId: texto(item.mktplaceId),
        // The map key IS the produtoUid; `NONE` is the unbound bucket.
        produtoUid: texto(item.produtoUid) ?? (chave === 'NONE' ? null : chave),
        sku: texto(item.sku),
        gtin: texto(item.gtin),
        precoDeVenda: numero(item.precoDeVenda),
        descontoUnitario: numero(item.descontoUnitario),
        quantidade: numero(item.quantidade),
      });
    }
  }
  return linhas.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function txt(v: string | null): string {
  return v ?? '—';
}

function dinheiro(v: number | null): string {
  return v == null ? '—' : formatReais(v);
}

function qtd(v: number | null): string {
  return v == null ? '—' : String(v);
}

/**
 * A µs stamp as `<raw> (<ISO UTC>)`.
 *
 * ⚠️ **UTC, never the ambient zone.** `apps/shopee` is a server surface for
 * `delfrance/no-ambient-timezone`, and the answer must not depend on which
 * machine ran the script.
 */
function carimbo(us: number | null): string {
  if (us == null) return '—';
  const ms = microsToMillis(us);
  if (!Number.isFinite(ms)) return String(us);
  return `${String(us)} (${new Date(ms).toISOString()})`;
}

/**
 * The human rendering of a summary. Section headers name the WRITE GROUP each
 * field belongs to, which is true of the stored document as well — those groups
 * are what wrote it.
 */
export function renderResumoPedido(
  r: ResumoPedidoShopee,
  /**
   * The pagamentos (#1514, step 6). OMIT it and no `### pagamentos` section is
   * rendered at all — an empty ARRAY is a different fact (this order maps to no
   * payment) and does get its own section saying so.
   */
  pagamentos?: readonly PagamentoResumoShopee[],
): string[] {
  const linhas: string[] = [];
  linhas.push(
    r.origem === 'mapeado'
      ? '## O que uma gravação escreveria (nada foi gravado)'
      : '## O que está gravado no Firestore',
  );
  linhas.push(`  pedidoId ................ ${r.pedidoId}`);
  linhas.push(`  numero (order_sn) ....... ${txt(r.numero)}`);
  linhas.push(
    r.origem === 'mapeado'
      ? `  estado alvo ............. ${txt(r.alvoEstado)}`
      : `  estado .................. ${txt(r.estadoArmazenado)}`,
  );
  linhas.push(`  lastMarketplaceUpdate ... ${carimbo(r.lastMarketplaceUpdateUs)}`);

  linhas.push('');
  linhas.push('### grupo `sempre` — toda entrega aceita');
  linhas.push(`  marketplace.tipo ........ ${txt(r.marketplace.tipo)}`);
  linhas.push(`  marketplace.status ...... ${txt(r.marketplace.status)}`);
  linhas.push(`  marketplace.statusEm .... ${carimbo(r.marketplace.statusEmUs)}`);
  linhas.push(
    `  pendingTerms ............ ${r.marketplace.pendingTerms == null ? 'null (a Shopee não mandou o campo)' : JSON.stringify(r.marketplace.pendingTerms)}`,
  );
  linhas.push(`  completedScenario ....... ${txt(r.marketplace.completedScenario)}`);
  linhas.push(
    `  cancelReason / cancelBy . ${txt(r.marketplace.cancelReason)} / ${txt(r.marketplace.cancelBy)}`,
  );
  linhas.push(`  capturaComprador ........ ${txt(r.capturaComprador.estado)}`);
  linhas.push(`    statusObservado ....... ${txt(r.capturaComprador.statusObservado)}`);
  linhas.push(
    `    camposRecusados ....... ${r.capturaComprador.camposRecusados.length === 0 ? '(nenhum)' : r.capturaComprador.camposRecusados.join(', ')}`,
  );
  linhas.push(
    `    camposRecusadosExtra .. ${r.capturaComprador.camposRecusadosExtra.length === 0 ? '(nenhum)' : r.capturaComprador.camposRecusadosExtra.join(', ')}`,
  );
  linhas.push(`  error ................... ${txt(r.erro)}`);

  linhas.push('');
  linhas.push('### grupo `dados` — enquanto o operador não editou o pedido');
  linhas.push(`  valorCobrado ............ ${dinheiro(r.valorCobrado)}`);
  linhas.push(
    `  descontoTotal ........... ${dinheiro(r.descontoTotal)}   (a Shopee não tem desconto de pedido)`,
  );
  linhas.push(
    `  observacoesInternas ..... ${r.observacoesInternasChars == null ? 'null' : `«REDIGIDO — ${String(r.observacoesInternasChars)} caractere(s)»`}`,
  );

  linhas.push('');
  linhas.push('### bloco `freteInicial`');
  if (r.frete === null) {
    linhas.push('  (sem freteInicial)');
  } else {
    const f = r.frete;
    linhas.push(`  estado / modalidade ..... ${txt(f.estado)} / ${txt(f.modalidade)}`);
    linhas.push(`  integradora ............. ${txt(f.integradora)}`);
    // The conta's `int_frete` doc: what the read-only half FOUND (off the mapped
    // block — no second lookup) on `mapeado`, what the pedido holds on
    // `armazenado`. Only a CREATE writes it, so the mapped line says so.
    linhas.push(
      r.origem === 'mapeado'
        ? `  int_frete da conta ...... ${f.integracaoFreteOuterRef ?? 'nenhum ativo — o pedido fica sem ref'}   (só um pedido NOVO grava; um existente mantém o seu)`
        : `  integracaoFreteOuterRef . ${txt(f.integracaoFreteOuterRef)}`,
    );
    linhas.push(
      `  endereço de entrega ..... ${txt(f.enderecoFreteOuterReference)}   (o endereço fiscal, preenchido uma vez)`,
    );
    linhas.push(`  externalId .............. ${txt(f.externalId)}   (package_number)`);
    linhas.push(`  externalOptionId ........ ${txt(f.externalOptionId)}   (logistics_channel_id)`);
    linhas.push(
      `  valorCobrado ............ ${dinheiro(f.valorCobrado)}   ← o que o comprador pagou`,
    );
    linhas.push(`  custoCalculado .......... ${dinheiro(f.custoCalculado)}`);
    linhas.push(`  custoFinal .............. ${dinheiro(f.custoFinal)}`);
    linhas.push(`  codRastreio ............. ${txt(f.codRastreio)}   (o step 7 é o dono)`);
    linhas.push(`  prazoDespacho ........... ${carimbo(f.prazoDespachoUs)}`);
    linhas.push(`  dataPrevisaoEntrega ..... ${carimbo(f.dataPrevisaoEntregaUs)}`);
    linhas.push(`  ultimaModificacao ....... ${carimbo(f.ultimaModificacaoUs)}`);
    if (f.volumes.length === 0) {
      linhas.push('  volumes ................. (nenhum)');
    } else {
      for (const v of f.volumes) {
        linhas.push(
          `  volume .................. ${txt(v.numero)}  pesoBruto=${qtd(v.pesoBrutoKg)} kg`,
        );
      }
    }
  }

  linhas.push('');
  linhas.push(`### itens (${String(r.itens.length)})`);
  if (r.itens.length === 0) {
    linhas.push('  (nenhum)');
  } else {
    linhas.push(
      '  ordem  produtoUid            sku                  qtd    preço      desconto   mktplaceId',
    );
    for (const i of r.itens) {
      linhas.push(
        `  ${String(i.ordem ?? '—').padEnd(6)} ${txt(i.produtoUid).padEnd(20)} ${txt(i.sku).padEnd(20)} ` +
          `${qtd(i.quantidade).padEnd(6)} ${dinheiro(i.precoDeVenda).padEnd(10)} ` +
          `${dinheiro(i.descontoUnitario).padEnd(10)} ${txt(i.mktplaceId)}`,
      );
    }
    linhas.push('  (o nome de venda é omitido de propósito — ver o cabeçalho do módulo)');
  }

  if (pagamentos !== undefined) {
    linhas.push('');
    linhas.push(`### pagamentos (${String(pagamentos.length)})`);
    if (pagamentos.length === 0) {
      linhas.push(
        r.origem === 'mapeado'
          ? '  (nenhum — a order não tem `pay_time` utilizável, então nada seria criado)'
          : '  (nenhum gravado)',
      );
    } else {
      for (const p of pagamentos) {
        linhas.push(`  docId ................... ${p.docId}`);
        linhas.push(`    id (campo) ............ ${txt(p.idCampo)}`);
        linhas.push(
          `    forma ................. ${p.formaCodigo == null ? '—' : String(p.formaCodigo)} ${txt(p.formaLabel)}`,
        );
        linhas.push(
          `    status ................ ${p.statusCodigo == null ? '—' : String(p.statusCodigo)} ${txt(p.statusLabel)}` +
            (r.origem === 'mapeado' ? '   (ALVO — a escada decide contra o gravado)' : ''),
        );
        linhas.push(
          `    valor ................. ${dinheiro(p.valor)}   parcelas=${qtd(p.parcelas)} aVista=${p.aVista == null ? '—' : String(p.aVista)}`,
        );
        linhas.push(
          `    tarifas ............... ${dinheiro(p.tarifas)}   bruto=${dinheiro(p.tarifasBrutas)}`,
        );
        linhas.push(`    descricaoPagamento .... ${txt(p.descricaoPagamento)}`);
        // ⚠️ Booleans, never the CNPJ and never the authorization code.
        linhas.push(
          `    cartao ................ ${p.temCartao ? 'sim' : 'não'}  bandeira=${txt(p.bandeira)}` +
            `  cnpj_instituicao=${p.temCnpjInstituicao ? 'presente' : '—'}  cAut=${p.temCAut ? 'presente' : '—'}`,
        );
        linhas.push(`    dataAprovacao ......... ${carimbo(p.dataAprovacaoUs)}`);
        linhas.push(`    dataCancelamento ...... ${carimbo(p.dataCancelamentoUs)}`);
        linhas.push(`    liquidação ............ ${p.temLiquidacao ? 'já liquidado' : 'pendente'}`);
      }
      linhas.push('  (o CNPJ do processador e o código de autorização são omitidos de propósito)');
    }
  }

  linhas.push('');
  linhas.push('### grupo `preencher-uma-vez` + criação');
  linhas.push(`  timestamp ............... ${carimbo(r.timestampUs)}`);
  linhas.push(`  integracaoPedidoOuterRef  ${txt(r.integracaoPedidoOuterRef)}`);
  linhas.push(`  listaDePrecosOuterRef ... ${txt(r.listaDePrecosOuterRef)}`);
  linhas.push(`  operacaoPedidoOuterRef .. ${txt(r.operacaoPedidoOuterRef)}`);
  linhas.push(`  clientePedidoOuterRef ... ${txt(r.clientePedidoOuterRef)}`);
  linhas.push(`  enderecoFiscalOuterRef .. ${txt(r.enderecoFiscalOuterRef)}`);
  linhas.push(
    `  ehSaida / bloquearNFe ... ${r.ehSaida == null ? '—' : String(r.ehSaida)} / ${r.bloquearEmissaoNFe == null ? 'null' : String(r.bloquearEmissaoNFe)}`,
  );
  if (r.origem === 'mapeado') {
    linhas.push('');
    linhas.push(
      '  ⚠️ Em dry-run o comprador NÃO é resolvido (isso seria uma escrita), então os dois',
    );
    linhas.push(
      '     outerRefs acima saem nulos mesmo numa order que a gravação de verdade vincularia.',
    );
    linhas.push('     Quem responde por isso é o veredito `capturaComprador` acima.');
    linhas.push('     O endereço de entrega do `freteInicial` é o fiscal, então sai nulo também.');
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                      the TEST buyer mode — the report                       */
/* -------------------------------------------------------------------------- */

/** A capture verdict as data — the `<campo>:<veredito>` names, never a value. */
export interface VereditoResumo {
  readonly estado: string;
  readonly camposRecusados: readonly string[];
}

/**
 * What the endereço builder would answer, in field NAMES, counts and the
 * builder's own fallback literals — never the street, the CEP or the city.
 */
export interface EnderecoSimuladoResumo {
  /** `nao-construido` = a gate refused before the builder ran (or no block). */
  readonly resultado: 'ok' | 'uf-desconhecida' | 'sem-cep' | 'nao-construido';
  /** The gates' refusals: `nome:`, `logradouro:`, `cep:` + a verdict, or `endereco:ausente`. */
  readonly recusados: readonly string[];
  /** The zipcode's DIGIT COUNT — the reason for a `sem-cep`, never the digits. */
  readonly digitosDoCep: number | null;
  /** Whether the zipcode sanitizes to the 8 digits a stored endereço needs. */
  readonly cepValido: boolean | null;
  readonly uf: string | null;
  /** The UF is the builder's `AC` because Shopee sent no state at all. */
  readonly ufPadraoPorAusencia: boolean | null;
  /** The builder's `pais` — `null` means BR. */
  readonly pais: string | null;
  /** Fields that took `ENDERECO_FALLBACKS`, as `campo=LITERAL`. */
  readonly fallbacks: readonly string[];
}

/** The dry run's buyer block. Values-free by construction: every field is a verdict or a count. */
export interface CompradorSimuladoResumo {
  readonly veredictoReal: VereditoResumo;
  readonly veredictoSimulado: VereditoResumo;
  readonly cpfDeTesteAplicado: boolean;
  readonly nomeTesteAplicado: boolean;
  readonly cepTesteAplicado: boolean;
  readonly importarEndereco: boolean;
  readonly endereco: EnderecoSimuladoResumo;
  /** The stored pedido's capture when it leaves nothing to do — `--live` refuses it. */
  readonly capturaTerminalArmazenada: CapturaCompradorEstado | null;
  /**
   * The cliente the stored pedido ALREADY links (an id), else `null` — `--live`
   * goes on only when it is the test buyer's (`exigirPedidoSemVinculoAlheio`).
   */
  readonly clienteVinculadoId: string | null;
}

const CAMPOS_COM_FALLBACK = ['logradouro', 'numero', 'bairro', 'cidade'] as const;

function veredito(c: CapturaComprador): VereditoResumo {
  return { estado: c.estado, camposRecusados: [...c.camposRecusados] };
}

function resumoDoEnderecoSimulado(
  endereco: EnderecoShopee | null,
  portoes: PortoesEnderecoShopee | null,
  saida: EnderecoBuildOutcome | null,
): EnderecoSimuladoResumo {
  const semDados = {
    digitosDoCep: null,
    cepValido: null,
    uf: null,
    ufPadraoPorAusencia: null,
    pais: null,
    fallbacks: [],
  };
  if (endereco == null || portoes === null) {
    return { ...semDados, resultado: 'nao-construido', recusados: ['endereco:ausente'] };
  }
  // The gates' OWN answer (`portoesDoEnderecoShopee`, the one `enderecoDeShopee`
  // builds from) — never re-derived here.
  const recusados = [...portoes.recusados];
  // Display only: the zipcode's digit count, and whether the builder's own
  // `sanitizeCep` would take it — the reason a `sem-cep` is, even when an
  // earlier gate kept the builder from running at all.
  const cep = valorUtilizavel(endereco.zipcode);
  const doCep = {
    digitosDoCep: cep === null ? null : (cep.match(/\d/g)?.length ?? 0),
    cepValido: cep === null ? null : sanitizeCep(cep) !== null,
  };
  if (saida === null) return { ...semDados, ...doCep, resultado: 'nao-construido', recusados };
  if (saida.kind === 'sem-cep') return { ...semDados, ...doCep, resultado: 'sem-cep', recusados };
  const f = saida.fields;
  return {
    resultado: saida.kind,
    recusados,
    ...doCep,
    uf: f.estado,
    // The builder's input says it: an absent estado is `AC` by its definition.
    ufPadraoPorAusencia: portoes.entrada !== null && portoes.entrada.estadoRaw === null,
    pais: f.pais,
    fallbacks: CAMPOS_COM_FALLBACK.filter((c) => f[c] === ENDERECO_FALLBACKS[c]).map(
      (c) => `${c}=${ENDERECO_FALLBACKS[c]}`,
    ),
  };
}

/**
 * The dry run's buyer block, read off the importer's OWN read-only half (its
 * `simulacao`), so the preview and the write share one composition.
 */
export function resumoDoCompradorSimulado(
  simulacao: SimulacaoAplicadaShopee,
  capturaSimulada: CapturaComprador,
  armazenado: Record<string, unknown> | null,
): CompradorSimuladoResumo {
  return {
    veredictoReal: veredito(simulacao.capturaReal),
    veredictoSimulado: veredito(capturaSimulada),
    cpfDeTesteAplicado: simulacao.cpfDeTesteAplicado,
    nomeTesteAplicado: simulacao.nomeTesteAplicado,
    cepTesteAplicado: simulacao.cepTesteAplicado,
    importarEndereco: simulacao.pedida.importarEndereco,
    endereco: resumoDoEnderecoSimulado(
      simulacao.detalheComprador.recipient_address,
      simulacao.portoesEndereco,
      simulacao.endereco,
    ),
    capturaTerminalArmazenada: capturaTerminalDoPedido(
      armazenado,
      simulacao.pedida.importarEndereco,
    ),
    clienteVinculadoId: vinculado(armazenado?.clientePedidoOuterRef)
      ? (idFromRefOrNull(armazenado?.clientePedidoOuterRef) ?? '—')
      : null,
  };
}

function textoDoVeredito(v: VereditoResumo): string {
  return [v.estado, ...v.camposRecusados].join(' ');
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

/** The stdout half of the buyer block. Names, verdicts and counts only. */
export function renderCompradorSimulado(r: CompradorSimuladoResumo): string[] {
  const e = r.endereco;
  const cep =
    e.digitosDoCep === null
      ? '—'
      : e.cepValido === true
        ? `${String(e.digitosDoCep)} dígitos`
        : `sem-cep — CEP precisa de 8 dígitos; veio com ${String(e.digitosDoCep)}`;
  const resultado =
    e.resultado === 'uf-desconhecida'
      ? 'uf-desconhecida — a UF seria recuperada pelo ViaCEP em --live (o dry-run não chama)'
      : e.resultado === 'nao-construido'
        ? `não construído (${e.recusados.join(', ')})`
        : e.resultado;
  const linhas = [
    '### comprador — MODO DE TESTE (--importar-cliente)',
    `  veredito real ........... ${textoDoVeredito(r.veredictoReal)}   (o que uma importação normal gravaria)`,
    `  veredito simulado ....... ${textoDoVeredito(r.veredictoSimulado)}   (o que esta execução gravaria)`,
    `  CPF de teste aplicado ... ${simNao(r.cpfDeTesteAplicado)}`,
    `  nome de teste ........... ${r.nomeTesteAplicado ? 'aplicado' : 'não — vale o que a Shopee mandou'}`,
    `  CEP de teste ............ ${r.cepTesteAplicado ? 'aplicado' : 'não — vale o que a Shopee mandou'}`,
    `  endereço ................ ${resultado}`,
    `    CEP ................... ${cep}`,
  ];
  if (e.uf !== null) {
    linhas.push(
      `    UF .................... ${e.uf}${e.ufPadraoPorAusencia === true ? '   (padrão AC: a Shopee não mandou estado)' : ''}`,
    );
    linhas.push(`    país .................. ${e.pais ?? 'BR'}`);
    linhas.push(
      `    fallbacks ............. ${e.fallbacks.length === 0 ? '(nenhum)' : e.fallbacks.join(', ')}`,
    );
  }
  linhas.push(
    `  gravar endereço ......... ${r.importarEndereco ? 'sim — só com um cliente vinculado' : 'não — passe --importar-endereco'}`,
  );
  if (r.clienteVinculadoId !== null) {
    linhas.push(
      `  ⚠️ o pedido já vincula o cliente ${r.clienteVinculadoId}: o --live só segue se ele for o ` +
        'comprador de teste (o mesmo documento e o mesmo nome).',
    );
  }
  if (r.capturaTerminalArmazenada !== null) {
    linhas.push(
      `  ⚠️ o pedido já existe e a captura do comprador já terminou (${r.capturaTerminalArmazenada}): ` +
        'o --live vai recusar. Use um pedido de teste novo.',
    );
  }
  return linhas;
}

/**
 * The VALUES Shopee sent in `recipient_address` — what Lucas asked to SEE
 * ("ver como está vindo"). For STDERR only, never stdout and never `--json`,
 * and empty unless all three hold: buyer mode (the preparo carries a
 * `simulacao`), the sandbox override, and a real region the mode accepts
 * (`regiaoEstrangeiraParaSimulacao`) — a sandbox fixture, never a BR buyer.
 *
 * ⚠️ It reads the REAL row itself (`preparo.linha`), never the simulated one,
 * so the substitutes can never be printed as if Shopee had sent them.
 */
export function valoresEnviadosPelaShopee(args: {
  readonly overrideSandboxAtivo: boolean;
  readonly preparo: Pick<PreparoPedidoShopee, 'linha' | 'simulacao'>;
}): string[] {
  const { linha, simulacao } = args.preparo;
  if (simulacao === null || !args.overrideSandboxAtivo) return [];
  if (!regiaoEstrangeiraParaSimulacao(linha.region)) return [];
  const titulo = `[shopee/importar:pedido] recipient_address como a Shopee mandou (região ${linha.region ?? '—'}; só no stderr):`;
  const e: EnderecoShopee | null = linha.recipient_address;
  if (e == null) return [titulo, '  (recipient_address: null)'];
  return [
    titulo,
    ...(
      [
        ['name', e.name],
        ['phone', e.phone],
        ['full_address', e.full_address],
        ['zipcode', e.zipcode],
        ['state', e.state],
        ['city', e.city],
        ['district', e.district],
        ['town', e.town],
      ] as const
    ).map(([campo, valor]) => `  ${campo.padEnd(13, '.')} ${JSON.stringify(valor)}`),
  ];
}

/** What a `--live` buyer-mode run resolved — ids, verdicts and document PATHS only. */
export interface CompradorGravadoResumo {
  readonly pedidoId: string | null;
  readonly clienteId: string | null;
  readonly criado: boolean | null;
  readonly matchedBy: string | null;
  readonly enderecoId: string | null;
  /**
   * What to delete to undo the test, read off the pedido AS STORED after the
   * run (so a cliente linked by an earlier test run is listed too): the
   * pedido, then the endereço and the cliente it links. Bare document paths.
   */
  readonly limpeza: readonly string[];
}

/**
 * @param armazenadoDepois the pedido re-read AFTER the import (`null` when it
 *        is not there) — the cleanup is what it LINKS, not what this run did.
 */
export function resumoDoCompradorGravado(
  resultado: ResultadoImportacaoPedidoShopee,
  armazenadoDepois: Record<string, unknown> | null,
): CompradorGravadoResumo {
  const c = resultado.compradorDeTeste;
  const ref = c?.enderecoOuterRef ?? null;
  const limpeza =
    armazenadoDepois === null || resultado.pedidoId === null
      ? []
      : [
          `pedidos/${resultado.pedidoId}`,
          toDocPathOrNull(armazenadoDepois.enderecoFiscalOuterRef),
          toDocPathOrNull(armazenadoDepois.clientePedidoOuterRef),
        ].filter((p): p is string => p !== null);
  return {
    pedidoId: resultado.pedidoId,
    clienteId: c?.cliente?.clienteId ?? null,
    criado: c?.cliente?.criado ?? null,
    matchedBy: c?.cliente?.matchedBy ?? null,
    enderecoId: ref === null ? null : idFromRef(ref),
    limpeza,
  };
}

export function renderCompradorGravado(r: CompradorGravadoResumo): string[] {
  const linhas = [
    '### comprador — MODO DE TESTE (gravado)',
    r.clienteId === null
      ? '  cliente ................. — (nenhum resolvido nesta execução; ver capturaComprador)'
      : `  cliente ................. ${r.clienteId}   criado=${r.criado === null ? '—' : simNao(r.criado)}` +
        `   matchedBy=${r.matchedBy ?? '—'}`,
    `  endereço ................ ${r.enderecoId ?? '— (nenhum gravado nesta execução)'}`,
    `  pedido .................. ${r.pedidoId ?? '—'}`,
  ];
  if (r.limpeza.length > 0) {
    linhas.push(
      `  limpeza (no console) .... ${r.limpeza.join(', ')}`,
      '    o pedido vincula um comprador de TESTE até ser apagado (ou ter clientePedidoOuterRef,',
      '    enderecoFiscalOuterRef, freteInicial.enderecoFreteOuterReference e capturaComprador',
      '    zerados): uma importação normal nunca desfaz o vínculo. Apague o cliente só se uma',
      '    execução de teste o CRIOU (criado=sim) — um cliente reaproveitado, como o do seed, fica.',
    );
  }
  return linhas;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it — and never
 * a payload.
 *
 * ⚠️ Every Shopee `message` in the package is built from paths, codes and
 * statuses (`call.ts` says why: an aborted fetch's own message can echo the
 * request URL, which carries `access_token`), so printing it is safe while
 * printing a body never would be. `ShopeeNetworkError.cause` is deliberately
 * NOT printed for exactly that reason.
 *
 * ⚠️ The subclasses come FIRST: `ShopeeReauthRequiredError` and
 * `ShopeeRateLimitError` both extend `ShopeeApiError`.
 */
export function descreverErro(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_IMPORTAR_PEDIDO];
  }
  if (err instanceof SimulacaoCompradorRecusadaError) {
    // Every refusal of the TEST buyer mode fires before any write.
    return [`❌ Modo comprador de TESTE recusado: ${err.message}`];
  }
  if (err instanceof ShopeeReauthRequiredError) {
    return [
      `❌ ShopeeReauthRequiredError — a autorização da loja acabou.`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   ${err.message}`,
      '   Reconecte a conta (o painel /canais/shopee/<id>, ou o script oauth:url).',
    ];
  }
  if (err instanceof ShopeeRateLimitError) {
    return [
      `❌ ShopeeRateLimitError (${err.kind})`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}` +
        ` retryAfter=${err.retryAfterSeconds == null ? '—' : String(err.retryAfterSeconds)}s`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeApiError) {
    return [
      `❌ ShopeeApiError (${err.kind})`,
      `   code=${err.code} httpStatus=${String(err.httpStatus)} path=${err.path}` +
        ` requestId=${err.requestId ?? '—'}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeSchemaError) {
    return [
      '❌ ShopeeSchemaError — a resposta não bate com o schema.',
      `   httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   campos: ${err.campos.length === 0 ? '(nenhum)' : err.campos.join(', ')}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeHttpError) {
    return [
      '❌ ShopeeHttpError',
      `   httpStatus=${String(err.httpStatus)} path=${err.path}`,
      `   ${err.message}`,
    ];
  }
  if (err instanceof ShopeeNetworkError) {
    // `cause` can echo the request URL, which carries the access token.
    return ['❌ ShopeeNetworkError', `   ${err.message}`];
  }
  if (err instanceof ShopeeError) {
    return [`❌ ${err.name}`, `   ${err.message}`];
  }
  if (err instanceof Error) {
    return [`❌ ${err.name}`, `   ${err.message}`];
  }
  return [`❌ erro não-Error: ${String(err)}`];
}
