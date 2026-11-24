/**
 * The ENGINE of `scripts/reproduzir-pedido.ts` — replay captured Shopee order
 * bodies through the REAL step-5 importer, offline, over an in-memory Firestore.
 *
 * ## Why this exists
 *
 * The SG sandbox order captures no buyer (region not BR, name masked), so the
 * buyer half of step 5 — CPF, name, the endereço and its gates, the capture
 * diary — has never run against a body Shopee really sends for a Brazilian
 * order. This module runs it: a human captures the raw `get_order_detail` (and
 * `get_escrow_detail`) response of a REAL production order into a folder outside
 * every checkout, and the replay hands those bytes to the real Shopee client as
 * if the wire had answered them. Everything after the `fetch` is production
 * code: the wire schema, the escrow containment, the mappers, the buyer adapter,
 * `findOrCreateCliente`, `ensureEndereco`, the three transactions, the
 * incidentes.
 *
 * ## What is replaced, and nothing else
 *
 * `importarPedidoShopee` is called exactly as the code-3 task handler calls it,
 * with ONLY its two documented seams filled:
 *
 *  - `clientFor` — the REAL `createShopeeClient`, whose `fetch` is
 *    {@link criarFetchDeReproducao}: the order-detail path answers the captured
 *    text, the escrow path the escrow capture (or a rejection, the way a network
 *    failure does — `call.ts` turns it into the `ShopeeNetworkError` the
 *    importer's escrow containment already absorbs, so a missing escrow imports
 *    at detail prices exactly as an unavailable one does in production), and
 *    ANY other path is recorded and rejected;
 *  - `viaCep` — whatever the caller passes, wrapped to COUNT consultations.
 *
 * The importer's TEST buyer option is never passed: this replay feeds it the
 * real buyer, not a substitute.
 *
 * ## What this module never does
 *
 *  - It never reads a file, the environment or a clock: the capture TEXTS and
 *    `nowMs` are parameters, and the script owns the I/O.
 *  - It never opens a Firestore: `db` is a parameter, and the script hands it
 *    the in-memory double — the ONE sanctioned non-test consumer of
 *    `lib/shopee/testing/fakeDb.ts`. Nothing here imports `testing/` or
 *    `fixtures/`, so a test can drive it over the same double.
 *  - It never prints. The importer's own console lines are RECORDED while it
 *    runs (stdout would otherwise mix them into the report) and returned, so the
 *    CLI half can scan each one for buyer residue before it reaches stderr.
 *  - It never decides what is safe to show: it returns the raw captured row
 *    and escrow too, because the CLI's residue scan needs the values it must
 *    NOT find. They are never rendered.
 *
 * ## The idempotence probe
 *
 * After the first import the same texts run AGAIN at a clock
 * {@link ATRASO_DA_SEGUNDA_PASSADA_MS} later — the redelivery the backfill's
 * 5-minute overlap (or a Cloud Tasks retry) produces, which in production never
 * shares the first delivery's clock. The LATER clock is what lets the probe see
 * a clock-driven rewrite: a zero-filled `update_time` falls back to the wall
 * clock in the importer, so a redelivery at the SAME clock would read as
 * idempotent where production rewrites the pedido every time. The result names
 * that pass's `acao`, the read-back documents whose content changed (by deep
 * equality of the two read-backs) and the clientes count.
 *
 * ## A capture holding several orders
 *
 * Production asks `get_order_detail` for ONE `order_sn` and never sees another
 * order's row. So when the capture's `order_list` holds more than one entry,
 * the replay serves an envelope NARROWED to the chosen row: a defect in a
 * sibling row cannot abort the replay as a "wire schema mismatch" production
 * would never meet, and no sibling buyer's values reach the importer.
 */
import { formatWithOptions, isDeepStrictEqual } from 'node:util';
import type { Firestore } from 'firebase-admin/firestore';
import type { ViaCepClient } from '@delfrance/core/cep';
import {
  clienteCollection,
  enderecoCollection,
  incidenteCollection,
  intFreteCollection,
  integracaoCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  INTEGRACAO_FRETE,
  INTEGRACAO_TIPO,
  idFromRefOrNull,
  toDocPathOrNull,
  toOuterRef,
} from '@delfrance/schemas';
import {
  SHOPEE_GET_ESCROW_DETAIL_PATH,
  SHOPEE_GET_ORDER_DETAIL_PATH,
  createShopeeClient,
  type ShopeeClient,
  type ShopeeHosts,
} from '@delfrance/integrations-shopee';

import {
  codigoDoEnvelope,
  conferirEscrow,
  lerEnvelope,
  objetoSimples,
  semBom,
  type EscrowCapturado,
} from './envelopeCapturado';
import { importarPedidoShopee, type ResultadoImportacaoPedidoShopee } from './importarPedido';
import { makePedidoIdShopee } from './orderIds';
import {
  CapturaInvalidaError,
  ChamadaNaoCapturadaError,
  EscrowNaoCapturadoError,
  urlDaRequisicao,
} from './reproduzirPedidoCli';

/* -------------------------------------------------------------------------- */
/*                         the fixture conta of the replay                     */
/* -------------------------------------------------------------------------- */

/** The integração the replay imports under — a fixture id, never a real conta. */
export const INTEGRACAO_DA_REPRODUCAO = 'int-1';
/** The shop id the replay signs with — a fixture id. */
export const LOJA_DA_REPRODUCAO = 987654;
/** The partner id the replay signs with — a fixture id. */
export const PARCEIRO_DA_REPRODUCAO = 1000001;
/** The conta's ACTIVE `int_frete` doc — the id the step-20 trigger mints. */
export const INT_FRETE_DA_REPRODUCAO = 'shopee-int-1';
/** A fixed `dataCadastro` for that doc (ms) — the field the lookup orders on. */
const CADASTRO_INT_FRETE_MS = 1_700_000_000_000;

/**
 * The replay's whole seed, as DATA: `[path, document]` pairs the caller applies
 * (`FakeDb.seed`). The conta carries the tabela and the operação a configured
 * conta has, and its ONE active `int_frete` doc carries exactly the fields
 * `buscarIntFreteDaConta` filters on (`tipo`, `contaShopeeFreteOuterRef`,
 * `ativo`) and orders on (`dataCadastro`) — so a created pedido gets the ref a
 * production conta's pedido gets.
 *
 * ⚠️ No catálogo is seeded: every line resolves to no produto and raises its
 * incidente. That is expected, and the report says so.
 */
export function linhasDeSemente(): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  return [
    [
      integracaoCollection.docPath({}, INTEGRACAO_DA_REPRODUCAO),
      {
        tipo: INTEGRACAO_TIPO.shopee,
        ativo: true,
        nome: 'Loja de reprodução',
        shop_id: LOJA_DA_REPRODUCAO,
        tabelaNormalOuterRef: 'documents/listaDePrecos/lp-1',
        operacaoOuterRef: 'documents/operacao/op-1',
      },
    ],
    [
      intFreteCollection.docPath({}, INT_FRETE_DA_REPRODUCAO),
      {
        tipo: INTEGRACAO_FRETE.shopee,
        contaShopeeFreteOuterRef: toOuterRef(
          integracaoCollection.docPath({}, INTEGRACAO_DA_REPRODUCAO),
        ),
        ativo: true,
        nome: 'Loja de reprodução',
        dataCadastro: CADASTRO_INT_FRETE_MS,
      },
    ],
  ];
}

/* -------------------------------------------------------------------------- */
/*                               the captured texts                            */
/* -------------------------------------------------------------------------- */

// The envelope pre-checks (`lerEnvelope`, `conferirEscrow`, …) live in
// `envelopeCapturado.ts`, shared with `capturar:pedido`, so the capture can
// never save an escrow this engine would refuse.

/** The raw `response.order_list`, or `null` when it is not a list. */
function listaDoDetalhe(envelope: Record<string, unknown>): unknown[] | null {
  const resposta = objetoSimples(envelope.response);
  const lista = resposta === null ? null : resposta.order_list;
  return Array.isArray(lista) ? lista : null;
}

/** The `order_list` rows that carry an `order_sn` at all. Shape only — the client validates. */
function linhasDoDetalhe(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const lista = listaDoDetalhe(envelope);
  if (lista === null) return [];
  return lista
    .map((linha) => objetoSimples(linha))
    .filter((linha): linha is Record<string, unknown> => linha !== null)
    .filter((linha) => typeof linha.order_sn === 'string' && linha.order_sn.length > 0);
}

/**
 * The order to replay: the ONE row, or the `--order-sn` the caller named among
 * several. ⚠️ No refusal prints an `order_sn` — neither the caller's nor one of
 * the capture's.
 */
function escolherOrderSn(linhas: Record<string, unknown>[], pedido: string | null): string {
  const sns = linhas.map((l) => l.order_sn as string);
  if (pedido !== null) {
    if (!sns.includes(pedido)) {
      throw new CapturaInvalidaError(
        `--order-sn não está entre as ${String(sns.length)} order(s) da captura do detalhe.`,
      );
    }
    return pedido;
  }
  if (sns.length > 1) {
    throw new CapturaInvalidaError(
      `--detalhe traz ${String(sns.length)} orders: passe --order-sn para escolher uma.`,
    );
  }
  return sns[0]!;
}

/**
 * The detail text the replay SERVES: the capture verbatim when its
 * `order_list` holds one entry, otherwise the same envelope narrowed to the
 * chosen row — what production's one-`order_sn` call would have answered (see
 * the module header). `shopeeCall` parses the text either way, so re-serialising
 * loses nothing the client reads.
 */
function detalheServido(
  texto: string,
  envelope: Record<string, unknown>,
  linhaEscolhida: Record<string, unknown>,
): string {
  const lista = listaDoDetalhe(envelope);
  if (lista === null || lista.length <= 1) return texto;
  const resposta = objetoSimples(envelope.response) ?? {};
  return JSON.stringify({ ...envelope, response: { ...resposta, order_list: [linhaEscolhida] } });
}

export type { EscrowCapturado };

/* -------------------------------------------------------------------------- */
/*                                 the wire seam                               */
/* -------------------------------------------------------------------------- */

/** One request the replayed client made — the PATH and whether it was answered. Never a query value. */
export interface ChamadaReproduzida {
  readonly path: string;
  readonly servido: boolean;
}

/**
 * A host that resolves nowhere (RFC 2606's `.invalid`). The replay `fetch`
 * never dials it, and nothing else may: a call that somehow escaped the seam
 * would fail to resolve instead of reaching Shopee.
 */
const HOST_DA_REPRODUCAO = 'https://shopee-reproducao.invalid';

const HOSTS_DA_REPRODUCAO: ShopeeHosts = {
  apiHost: HOST_DA_REPRODUCAO,
  authHost: HOST_DA_REPRODUCAO,
  authorizeUrlBase: `${HOST_DA_REPRODUCAO}/auth`,
  cancelAuthUrlBase: `${HOST_DA_REPRODUCAO}/cancel_auth`,
};

/** Fixed fake credentials — the signature is computed and then thrown away. */
const CHAVE_FALSA = 'chave-falsa-da-reproducao';
const TOKEN_FALSO = 'token-falso-da-reproducao';

const CABECALHOS_JSON = { 'Content-Type': 'application/json' } as const;

/**
 * The `fetch` the replayed client is built with. Routes on the URL's PATH only:
 * the detail path answers the detail capture, the escrow path the escrow
 * capture (or a rejection when there is none), anything else is recorded and
 * rejected. Every call lands in `chamadas`.
 */
export function criarFetchDeReproducao(textos: {
  readonly detalhe: string;
  readonly escrow: string | null;
}): { readonly fetch: typeof globalThis.fetch; readonly chamadas: ChamadaReproduzida[] } {
  const chamadas: ChamadaReproduzida[] = [];
  const fetchDeReproducao: typeof globalThis.fetch = (input) => {
    const path = new URL(urlDaRequisicao(input)).pathname;
    if (path === SHOPEE_GET_ORDER_DETAIL_PATH) {
      chamadas.push({ path, servido: true });
      return Promise.resolve(
        new Response(textos.detalhe, { status: 200, headers: CABECALHOS_JSON }),
      );
    }
    if (path === SHOPEE_GET_ESCROW_DETAIL_PATH) {
      if (textos.escrow === null) {
        chamadas.push({ path, servido: false });
        return Promise.reject(new EscrowNaoCapturadoError());
      }
      chamadas.push({ path, servido: true });
      return Promise.resolve(
        new Response(textos.escrow, { status: 200, headers: CABECALHOS_JSON }),
      );
    }
    chamadas.push({ path, servido: false });
    return Promise.reject(new ChamadaNaoCapturadaError(path));
  };
  return { fetch: fetchDeReproducao, chamadas };
}

function clienteDeReproducao(
  fetchDeReproducao: typeof globalThis.fetch,
  nowMs: number,
): ShopeeClient {
  return createShopeeClient({
    partnerId: PARCEIRO_DA_REPRODUCAO,
    partnerKey: CHAVE_FALSA,
    hosts: HOSTS_DA_REPRODUCAO,
    shopId: LOJA_DA_REPRODUCAO,
    getAccessToken: () => Promise.resolve(TOKEN_FALSO),
    fetch: fetchDeReproducao,
    now: () => nowMs,
  });
}

/* -------------------------------------------------------------------------- */
/*                              the console recorder                           */
/* -------------------------------------------------------------------------- */

const NIVEIS_DE_LOG = ['log', 'info', 'warn', 'error'] as const;
type NivelDeLog = (typeof NIVEIS_DE_LOG)[number];

/**
 * Run `fn` with the four console methods replaced by recorders, and restore
 * them in `finally` — after a throw too. Each recorded line is
 * `[<level>] <the arguments, formatted the way console would>`, one line.
 */
async function comConsoleGravado<T>(linhas: string[], fn: () => Promise<T>): Promise<T> {
  /* eslint-disable no-console -- the recorder REPLACES the console methods; it never prints */
  const originais: Record<NivelDeLog, (...args: unknown[]) => void> = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const nivel of NIVEIS_DE_LOG) {
    console[nivel] = (...args: unknown[]): void => {
      linhas.push(
        `[${nivel}] ${formatWithOptions({ colors: false, depth: 8, breakLength: Infinity }, ...args)}`,
      );
    };
  }
  try {
    return await fn();
  } finally {
    for (const nivel of NIVEIS_DE_LOG) console[nivel] = originais[nivel];
  }
  /* eslint-enable no-console */
}

/* -------------------------------------------------------------------------- */
/*                                  the read-back                              */
/* -------------------------------------------------------------------------- */

/** One document as read back, its data deep-copied so a later write cannot alias it. */
export interface DocumentoLido {
  readonly caminho: string;
  readonly id: string;
  readonly dados: Record<string, unknown>;
}

/** The clientes in the database — a BOUNDED read, so a real database could never be scanned whole. */
export interface ContagemDeClientes {
  readonly ids: readonly string[];
  /** `true` when the bound was reached: the count is "at least". */
  readonly truncado: boolean;
}

const LIMITE_CONTAGEM_CLIENTES = 10;

export interface LeituraReproducao {
  readonly pedido: DocumentoLido | null;
  readonly pagamentos: readonly DocumentoLido[];
  readonly incidentes: readonly DocumentoLido[];
  /** The cliente the pedido's `clientePedidoOuterRef` names, or `null`. */
  readonly cliente: DocumentoLido | null;
  /** The endereço the pedido's `enderecoFiscalOuterRef` names, or `null`. */
  readonly endereco: DocumentoLido | null;
  readonly clientes: ContagemDeClientes;
}

/** A JSON round trip: plain data out, so two read-backs compare by value. */
function copiaJson(dados: unknown): Record<string, unknown> {
  return objetoSimples(JSON.parse(JSON.stringify(dados ?? {})) as unknown) ?? {};
}

async function contarClientes(db: Firestore): Promise<ContagemDeClientes> {
  const snap = await clienteCollection.ref(db, {}).limit(LIMITE_CONTAGEM_CLIENTES).get();
  return {
    ids: snap.docs.map((d) => d.id).sort(),
    truncado: snap.docs.length >= LIMITE_CONTAGEM_CLIENTES,
  };
}

/** `clientes/<id>/enderecos/<id>` out of a stored ref, or `null`. */
function enderecoDoRef(ref: unknown): { readonly clienteId: string; readonly id: string } | null {
  const caminho = toDocPathOrNull(ref);
  if (caminho === null) return null;
  const partes = caminho.split('/');
  if (partes.length !== 4 || partes[0] !== 'clientes' || partes[2] !== 'enderecos') return null;
  return { clienteId: partes[1]!, id: partes[3]! };
}

async function lerDocumentos(db: Firestore, pedidoId: string): Promise<LeituraReproducao> {
  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedido = pedidoSnap.exists
    ? {
        caminho: pedidoCollection.docPath({}, pedidoId),
        id: pedidoId,
        dados: copiaJson(pedidoSnap.data()),
      }
    : null;

  const pagSnap = await pagamentoCollection.ref(db, { pedidoId }).get();
  const pagamentos = pagSnap.docs.map((d) => ({
    caminho: pagamentoCollection.docPath({ pedidoId }, d.id),
    id: d.id,
    dados: copiaJson(d.data()),
  }));
  const incSnap = await incidenteCollection.ref(db, { pedidoId }).get();
  const incidentes = incSnap.docs.map((d) => ({
    caminho: incidenteCollection.docPath({ pedidoId }, d.id),
    id: d.id,
    dados: copiaJson(d.data()),
  }));

  let cliente: DocumentoLido | null = null;
  const clienteId = idFromRefOrNull(pedido?.dados.clientePedidoOuterRef);
  if (clienteId !== null) {
    const snap = await clienteCollection.docRef(db, {}, clienteId).get();
    if (snap.exists) {
      cliente = {
        caminho: clienteCollection.docPath({}, clienteId),
        id: clienteId,
        dados: copiaJson(snap.data()),
      };
    }
  }

  let endereco: DocumentoLido | null = null;
  const alvo = enderecoDoRef(pedido?.dados.enderecoFiscalOuterRef);
  if (alvo !== null) {
    const ctx = { clienteId: alvo.clienteId };
    const snap = await enderecoCollection.docRef(db, ctx, alvo.id).get();
    if (snap.exists) {
      endereco = {
        caminho: enderecoCollection.docPath(ctx, alvo.id),
        id: alvo.id,
        dados: copiaJson(snap.data()),
      };
    }
  }

  return {
    pedido,
    pagamentos,
    incidentes,
    cliente,
    endereco,
    clientes: await contarClientes(db),
  };
}

function porCaminho(leitura: LeituraReproducao): Map<string, Record<string, unknown>> {
  const mapa = new Map<string, Record<string, unknown>>();
  const todos = [
    leitura.pedido,
    ...leitura.pagamentos,
    ...leitura.incidentes,
    leitura.cliente,
    leitura.endereco,
  ];
  for (const doc of todos) if (doc !== null) mapa.set(doc.caminho, doc.dados);
  return mapa;
}

/** The paths whose content differs between two read-backs — appeared and vanished included. */
export function caminhosAlterados(antes: LeituraReproducao, depois: LeituraReproducao): string[] {
  const a = porCaminho(antes);
  const b = porCaminho(depois);
  const caminhos = new Set([...a.keys(), ...b.keys()]);
  return [...caminhos].filter((c) => !isDeepStrictEqual(a.get(c), b.get(c))).sort();
}

/* -------------------------------------------------------------------------- */
/*                                   the replay                                */
/* -------------------------------------------------------------------------- */

/**
 * How much later the idempotence probe runs: the backfill's 5-minute window
 * overlap, the redelivery every order sees in production. Fixed, so the
 * replay stays deterministic.
 */
export const ATRASO_DA_SEGUNDA_PASSADA_MS = 5 * 60_000;

export interface EntradaReproducao {
  /** The raw `get_order_detail` response body, as captured. */
  readonly detalheTexto: string;
  /** The raw `get_escrow_detail` response body, or `null` (detail prices). */
  readonly escrowTexto: string | null;
  /** Required only when the detail capture carries several orders. */
  readonly orderSn: string | null;
  /**
   * The ONE clock read, in milliseconds — the first pass's clock; the second
   * runs {@link ATRASO_DA_SEGUNDA_PASSADA_MS} later.
   */
  readonly nowMs: number;
  readonly viaCep: ViaCepClient;
}

export interface ResultadoReproducao {
  readonly orderSn: string;
  /**
   * The chosen order's RAW captured row and escrow `response` — for the CLI's
   * summary and its residue scan. ⚠️ They hold the buyer's values and are never
   * rendered.
   */
  readonly linhaBruta: Readonly<Record<string, unknown>>;
  readonly escrowBruto: Readonly<Record<string, unknown>> | null;
  readonly escrowCapturado: EscrowCapturado;
  readonly primeira: ResultadoImportacaoPedidoShopee;
  /** The idempotence probe — the same texts again, {@link ATRASO_DA_SEGUNDA_PASSADA_MS} later. */
  readonly segunda: ResultadoImportacaoPedidoShopee;
  /** Both passes' requests, in order. */
  readonly chamadas: readonly ChamadaReproduzida[];
  readonly clientesAntes: ContagemDeClientes;
  /** After the first pass. */
  readonly leitura: LeituraReproducao;
  /** After the second pass. */
  readonly leituraFinal: LeituraReproducao;
  /** Read-back paths whose content the second pass changed. */
  readonly documentosAlterados: readonly string[];
  /** The console lines both passes emitted, recorded — NOT yet scanned. */
  readonly logs: readonly string[];
  readonly consultasViaCep: number;
}

export async function reproduzirPedidoShopee(
  db: Firestore,
  entrada: EntradaReproducao,
): Promise<ResultadoReproducao> {
  const detalheTexto = semBom(entrada.detalheTexto);
  const escrowTexto = entrada.escrowTexto === null ? null : semBom(entrada.escrowTexto);

  const detalhe = lerEnvelope('--detalhe', detalheTexto);
  const escrowEnvelope = escrowTexto === null ? null : lerEnvelope('--escrow', escrowTexto);

  const linhas = linhasDoDetalhe(detalhe);
  if (linhas.length === 0) {
    throw new CapturaInvalidaError(
      `--detalhe não traz nenhuma order em response.order_list (error do envelope: ` +
        `${codigoDoEnvelope(detalhe)}). Refaça a captura como no scripts/README.md.`,
    );
  }
  const orderSn = escolherOrderSn(linhas, entrada.orderSn);
  const linhaBruta = linhas.find((l) => l.order_sn === orderSn)!;
  const escrow =
    escrowEnvelope === null
      ? { tipo: 'ausente' as const, resposta: null }
      : conferirEscrow(escrowEnvelope, orderSn);

  let consultasViaCep = 0;
  const viaCep: ViaCepClient = {
    buscarCep: (cep) => {
      consultasViaCep += 1;
      return entrada.viaCep.buscarCep(cep);
    },
  };
  const { fetch: fetchDeReproducao, chamadas } = criarFetchDeReproducao({
    detalhe: detalheServido(detalheTexto, detalhe, linhaBruta),
    escrow: escrowTexto,
  });
  // The code-3 handler's call, with only the two seams filled — once per pass,
  // each at its own clock.
  const passada = (nowMs: number) => {
    const client = clienteDeReproducao(fetchDeReproducao, nowMs);
    return importarPedidoShopee(
      db,
      { integracaoId: INTEGRACAO_DA_REPRODUCAO, shopId: LOJA_DA_REPRODUCAO, orderSn, nowMs },
      { clientFor: () => Promise.resolve(client), viaCep },
    );
  };

  const clientesAntes = await contarClientes(db);
  const logs: string[] = [];
  const passadas = await comConsoleGravado(logs, async () => {
    const primeira = await passada(entrada.nowMs);
    const pedidoId = primeira.pedidoId ?? makePedidoIdShopee(INTEGRACAO_DA_REPRODUCAO, orderSn);
    const leitura = await lerDocumentos(db, pedidoId);
    const segunda = await passada(entrada.nowMs + ATRASO_DA_SEGUNDA_PASSADA_MS);
    const leituraFinal = await lerDocumentos(db, pedidoId);
    return { primeira, leitura, segunda, leituraFinal };
  });

  return {
    orderSn,
    linhaBruta,
    escrowBruto: escrow.resposta,
    escrowCapturado: escrow.tipo,
    primeira: passadas.primeira,
    segunda: passadas.segunda,
    chamadas,
    clientesAntes,
    leitura: passadas.leitura,
    leituraFinal: passadas.leituraFinal,
    documentosAlterados: caminhosAlterados(passadas.leitura, passadas.leituraFinal),
    logs,
    consultasViaCep,
  };
}
