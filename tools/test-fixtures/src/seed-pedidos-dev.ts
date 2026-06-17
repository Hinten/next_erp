import { db } from './admin';
import { DEV_FILIAL_ID } from './seed-filiais-dev';
import { DEV_OPERACAO_ID } from './seed-operacoes-dev';
import { DEV_ENDERECO_ID } from './seed-enderecos-dev';

/**
 * Dev-seed for the `/pedidos` TableView — writes a handful of pedidos
 * (plus one cliente) with varying `estado`, frete state, print metadata
 * and cliente references, so you can run the app locally and eyeball the
 * static cells (ClienteCell link + tooltip, FreteCell label, ImpCell).
 *
 * NF-e docs are seeded SEPARATELY by `seed-nfe-dev.ts` — run this first to
 * get pedidos with an empty NF column (DASH), then run the NF-e generator
 * and watch the NFCell badges appear / change live, without reloading the
 * page. That split is the whole point: it proves the per-row snapshot
 * listener updates on its own.
 *
 * Idempotent: every seeded doc uses a stable `dev-pedidos-...` id, so
 * re-running this script just overwrites the previous run. Pass `--clean`
 * to delete everything the seed wrote (pedidos, their `nfev4`
 * subcollections, and the cliente) without re-creating it.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:pedidos          # create + overwrite
 *   pnpm --filter @delfrance/test-fixtures seed:pedidos --clean  # delete only
 *
 * Requires the same env as the e2e fixtures: `FIREBASE_SERVICE_ACCOUNT`
 * (or `FIREBASE_SERVICE_ACCOUNT_PATH`) and `FIREBASE_PROJECT_ID`. Targets
 * the database named by `FIREBASE_DATABASE_ID` (default `'default'`).
 */

export const DEV_PEDIDOS_PREFIX = 'dev-pedidos';
export const CLIENTE_ID = `${DEV_PEDIDOS_PREFIX}-cliente`;

/**
 * Build a pedido id for the seeded entry at index `i` (1-based). Stable
 * across runs so re-seeding overwrites instead of accreting docs.
 */
export function devPedidoId(i: number): string {
  return `${DEV_PEDIDOS_PREFIX}-${String(i).padStart(2, '0')}`;
}

/**
 * Shape of a Pagamento doc seeded under `pedidos/{id}/pagamento`.
 * Mirrors `pagamentoSchema` — kept inline here so the fixture doesn't
 * pull `@delfrance/schemas` (this script runs under tsx without the
 * monorepo build), but the fields line up 1-1 with the schema.
 */
interface DevPagamentoSeed {
  readonly forma_de_pagamento: number;
  readonly valor: number;
  /** PIX / boleto / etc. — see FORMA_PAGAMENTO. */
  readonly aVista?: boolean;
  /** Required when forma=99 (outros) to satisfy SEFAZ cStat 441. */
  readonly descricaoPagamento?: string;
  /** Card detail — only meaningful for forma=3/4 (credito/debito). */
  readonly cartao?: {
    tpIntegra: '1' | '2';
    cnpj_instituicao?: string;
    bandeira?: string;
    cAut?: string;
  };
  /**
   * When `true`, this pagamento contributes to the NF-e's `<cobr>`
   * block (fatura + duplicata installments). Typically paired with a
   * `nFat` + `vencimento` for boleto-style billing.
   */
  readonly duplicata?: boolean;
  /** Invoice number — propagates to `<cobr>.<fat>.<nFat>`. */
  readonly nFat?: string;
  /** ISO datetime — propagates to `<cobr>.<dup>.<dVenc>` (YYYY-MM-DD). */
  readonly vencimento?: string;
}

/**
 * Frete block seeded under `pedido.freteInicial`. The orchestrator's
 * `<transp>` projection reads `modalidade` + optional carrier/vehicle/
 * volume details; UI cells read `estado` + `codRastreio` +
 * `prazoDespacho`. Both consumers live in one struct.
 */
interface DevFreteSeed {
  readonly estado: string;
  readonly codRastreio?: string;
  readonly prazoDespacho?: number;
  /**
   * NFe `modFrete`: '0'=contratação emitente (CIF), '1'=destinatário (FOB),
   * '2'=terceiros, '3'/'4'=próprio, '9'=sem transporte. Default '0'.
   */
  readonly modalidade?: '0' | '1' | '2' | '3' | '4' | '9';
  /**
   * Freight value charged to the customer. Participates in the pedido money
   * caches (`valorCobrado`/`valorFreteInicial`) for EVERY modalidade — see
   * `derivePedidoFreteTotals` (legacy `Pedido.total`). Only the NF-e side is
   * modalidade-gated: `<total>.vFrete` counts it solely under modalidade='0'
   * (contratação pelo emitente).
   */
  readonly valorCobrado?: number;
  /** Flutter wire names (the NFe orchestrator remaps to CNPJ/xNome/… itself). */
  readonly transportadora?: {
    cnpj?: string;
    ie?: string;
    nome?: string;
    endereco?: string;
    municipio?: string;
    uf?: string;
  };
  /**
   * Flutter wire names (the NFe orchestrator remaps to placa/UF/RNTC
   * itself). `placa` and `uf` are required on the wire — the legacy decoder
   * crashes on null, so a fixture without them would be invalid.
   */
  readonly veiculo?: {
    placa: string;
    uf: string;
    rntc?: string;
  };
  /** Flutter wire names (the NFe orchestrator remaps to qVol/esp/… itself). */
  readonly volumes?: ReadonlyArray<{
    quantidade?: number;
    especie?: string;
    marca?: string;
    numero?: string;
    pesoLiquido?: number;
    pesoBruto?: number;
  }>;
}

interface PedidoSeed {
  readonly numero: string;
  readonly estadoPedido: string;
  /** When true, link to the seeded cliente so ClienteCell exercises its fetch. */
  readonly withCliente?: boolean;
  /** When set, stamp `dtImpressao` so ImpCell shows the printer icon. */
  readonly dtImpressao?: number;
  /** When set, stamp `freteInicial`. */
  readonly frete?: DevFreteSeed;
  /** Cached total — the cell prefers this over recomputing from `itens`. */
  readonly valorCobrado?: number;
  /**
   * Approved pagamentos to write under `pedidos/{id}/pagamento/`. Empty
   * (or omitted) exercises the orchestrator's `tPag='90'` (sem
   * pagamento) fallback. Status is always `aprovado` so the NF-e
   * orchestrator's status filter picks them up.
   */
  readonly pagamentos?: ReadonlyArray<DevPagamentoSeed>;
  /** Free-text informational note — propagates to `<infAdic>.<infCpl>`. */
  readonly infCpl?: string;
  /**
   * When true, omit `imposto` from each item so the orchestrator's
   * `resolveItemImposto` cascade fires. Pair with a seeded
   * `regraImposto` (under the dev operação) so the resolver has
   * something to resolve to. Used by PED-8 to exercise Group C
   * end-to-end against live SEFAZ-SP HOM.
   */
  readonly omitImposto?: boolean;
}

const PEDIDOS: PedidoSeed[] = [
  {
    numero: '0001',
    estadoPedido: 'pago',
    withCliente: true,
    dtImpressao: Date.now() - 86_400_000,
    // Full frete projection — exercises <transp> with transporta +
    // veicTransp + vol AND <total>.vFrete > 0 (modalidade='0') AND
    // the <pag> frete-emitente single-payment override.
    frete: {
      estado: 'entregue',
      codRastreio: 'BR123456789',
      prazoDespacho: Date.now() - 172_800_000,
      modalidade: '0',
      valorCobrado: 49.9,
      transportadora: {
        cnpj: '99999999000191',
        nome: 'Transportadora Dev SA',
        ie: '110042490114',
        endereco: 'Av Carrier 100',
        municipio: 'Sao Paulo',
        uf: 'SP',
      },
      veiculo: { placa: 'ABC1D23', uf: 'SP', rntc: '12345' },
      volumes: [
        {
          quantidade: 1,
          especie: 'CAIXA',
          marca: 'Dev',
          numero: '001',
          pesoLiquido: 1.25,
          pesoBruto: 1.5,
        },
      ],
    },
    valorCobrado: 1499.9,
    // Single PIX payment — the orchestrator's happy path for SEFAZ.
    // SEFAZ NT 2022.001 requires a <card> block on tPag=17 (same as
    // 03/04), so a minimal cartao with `tpIntegra='2'` (standalone PSP,
    // no integrated TEF) is mandatory even for PIX. Without it SEFAZ
    // rejects cStat=391. Production data gets this from the payment
    // gateway integration; in fixtures we stamp it by hand.
    pagamentos: [
      {
        forma_de_pagamento: 17,
        valor: 1499.9,
        aVista: true,
        cartao: {
          tpIntegra: '2',
          cnpj_instituicao: '99999999000191',
        },
      },
    ],
  },
  {
    numero: '0002',
    estadoPedido: 'emProcessamento',
    withCliente: true,
    frete: { estado: 'aCaminho', codRastreio: 'BR987654321', modalidade: '1' },
    valorCobrado: 250.0,
    // Boleto a prazo with duplicata=true — exercises both indPag='1'
    // and the <cobr> block (fat + dup).
    pagamentos: [
      {
        forma_de_pagamento: 15,
        valor: 250.0,
        aVista: false,
        duplicata: true,
        nFat: 'F-0002',
        vencimento: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
    ],
  },
  {
    numero: '0003',
    estadoPedido: 'aguardandoConfirmacaoDePagamento',
    withCliente: true,
    frete: { estado: 'aguardandoNFe', modalidade: '9' },
    valorCobrado: 75.5,
    // Credit-card payment — exercises the <card> block.
    pagamentos: [
      {
        forma_de_pagamento: 3,
        valor: 75.5,
        aVista: true,
        cartao: {
          tpIntegra: '2',
          cnpj_instituicao: '99999999000191',
          bandeira: '03',
        },
      },
    ],
    // Free-text note — exercises <infAdic>.<infCpl>.
    infCpl: 'Pedido dev de teste — exercita o bloco <infAdic>.',
  },
  {
    numero: '0004',
    estadoPedido: 'emAnalise',
    frete: { estado: 'iniciado' },
    valorCobrado: 320.0,
    // No pagamentos — exercises the `tPag='90'` (sem pagamento) fallback.
  },
  {
    numero: '0005',
    estadoPedido: 'pago',
    withCliente: true,
    valorCobrado: 980.0,
    // forma=99 (outros) — exercises the <xPag> branch (and would trigger
    // SEFAZ cStat=441 without it).
    pagamentos: [
      {
        forma_de_pagamento: 99,
        valor: 980.0,
        aVista: true,
        descricaoPagamento: 'Permuta de mercadoria',
      },
    ],
  },
  {
    numero: '0006',
    estadoPedido: 'finalizado',
    withCliente: true,
    dtImpressao: Date.now() - 3_600_000,
    frete: { estado: 'postado', codRastreio: 'BR555555555' },
    valorCobrado: 49.9,
    // Cash — the simplest XSD-valid path.
    pagamentos: [{ forma_de_pagamento: 1, valor: 49.9, aVista: true }],
  },
  {
    numero: '0007',
    estadoPedido: 'cancelado',
    valorCobrado: 199.0,
    // No pagamentos either — second sample of the sem-pagamento fallback.
  },
  {
    numero: '0008',
    estadoPedido: 'pago',
    withCliente: true,
    valorCobrado: 100.0,
    // Resolver cascade exercise — items have NO `imposto` stamped, so
    // the orchestrator must resolve via the `regraImposto` doc seeded
    // under `operacao/{DEV_OPERACAO_ID}/regraimposto/{DEV_REGRA_IMPOSTO_ID}`
    // (matches produtos:['dev-prod-01'] → CSOSN 102 + PIS/COFINS 49).
    // Without that rule the emit would throw NFeMissingImpostoError.
    pagamentos: [{ forma_de_pagamento: 1, valor: 100.0, aVista: true }],
    omitImposto: true,
  },
];

/** The stable ids of every pedido this script seeds (1-based order). */
export function devPedidoIds(): string[] {
  return PEDIDOS.map((_, i) => devPedidoId(i + 1));
}

async function writeCliente(): Promise<void> {
  await db().collection('clientes').doc(CLIENTE_ID).set({
    tipo: '0', // Pessoa Física
    nome: 'Cliente Dev Pessoa Fisica',
    // Known-valid test CPF (passes check digits). PF avoids
    // cStat=234 ("IE do destinatário não vinculada ao CNPJ") — the
    // previous PJ pair (CNPJ 11222333000181 + IE 110042490114) was
    // not recognised by SEFAZ-SP HOM. PF has no IE; the orchestrator
    // stamps `indIEDest='9'` (Não Contribuinte) and the paired
    // `operacao.ehConsumidorFinal=true` keeps `indFinal='1'` so
    // SEFAZ doesn't reject with cStat=696.
    cpf_cnpj: '12345678909',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: 'dev-pedidos@example.com',
    telefone: '11999990000',
    observacoesInternas: null,
    timestamp: new Date().toISOString(),
    nome_embedding: null,
    telefone_embedding: null,
    userCliente: null,
  });
}

/**
 * Build a one-item `itens` map ready for NF-e emission. CSOSN 102
 * (Simples Nacional sem permissão de crédito) is the most common
 * Phase-A path; PIS / COFINS CST '49' (outras operações de saída)
 * is the SN-friendly default. NCM / CFOP / unidade come from the
 * seeded `operacao` (operacaoSchema falls back via the orchestrator).
 *
 * The `valor` param is the line total — used as `precoDeVenda` with
 * `quantidade: 1` so the pedido's cached `valorCobrado` lines up with
 * `aggregateTotals(items)` inside the orchestrator.
 */
function devItensMap(
  valor: number,
  options: { omitImposto?: boolean } = {},
): {
  itens: Record<string, unknown[]>;
  itensIds: string[];
} {
  const produtoUid = 'dev-prod-01';
  const baseItem: Record<string, unknown> = {
    sku: 'DEV-PROD-01',
    gtin: null,
    nomeDeVenda: 'Produto Dev',
    precoDeVenda: valor,
    descontoUnitario: null,
    quantidade: 1,
  };
  if (!options.omitImposto) {
    baseItem.imposto = {
      origem: '0',
      configuracaoICMS: {
        crt: '1', // Simples Nacional
        csosn: '102', // sem permissão de crédito
      },
      configuracaoPIS: { CST: '49' }, // outras operações de saída
      configuracaoCOFINS: { CST: '49' },
    };
  }
  return {
    itensIds: [produtoUid],
    itens: { [produtoUid]: [baseItem] },
  };
}

/**
 * Stable doc id for the n-th pagamento (1-based) of a seeded pedido —
 * idempotent re-seeding overwrites the same docs instead of accreting.
 */
function devPagamentoId(n: number): string {
  return `dev-pag-${String(n).padStart(2, '0')}`;
}

/**
 * ms → µs. Pedido / pagamento / frete datetime fields are microseconds since
 * epoch (`microsSinceEpoch()`); the seed builds values from `Date.now()` /
 * ISO, which are ms — scale to the wire unit. Mirrors
 * `@delfrance/core/datetime` `millisToMicros` (not imported: this dev seed
 * keeps its deps to firebase-admin + @delfrance/auth).
 */
const us = (ms: number): number => ms * 1000;

/**
 * Write the pagamentos for a seeded pedido under
 * `pedidos/{pedidoId}/pagamento/`. Status is hard-coded to
 * `STATUS_PAGAMENTO.aprovado` (= 4) so the NF-e orchestrator's status
 * filter accepts them.
 */
async function writePagamentos(
  pedidoId: string,
  pagamentos: ReadonlyArray<DevPagamentoSeed>,
): Promise<void> {
  const now = us(Date.now());
  const pagRef = db().collection('pedidos').doc(pedidoId).collection('pagamento');
  for (let i = 0; i < pagamentos.length; i += 1) {
    const p = pagamentos[i]!;
    const id = devPagamentoId(i + 1);
    await pagRef.doc(id).set({
      id,
      metodoPagamentoOuterRef: null,
      forma_de_pagamento: p.forma_de_pagamento,
      status_pagamento: 4, // STATUS_PAGAMENTO.aprovado
      cartao: p.cartao ?? null,
      cheque: null,
      descricaoPagamento: p.descricaoPagamento ?? null,
      valor: p.valor,
      parcelas: 1,
      juros: null,
      tarifas: null,
      aVista: p.aVista ?? true,
      duplicata: p.duplicata ?? false,
      nFat: p.nFat ?? null,
      vencimento: p.vencimento != null ? us(new Date(p.vencimento).getTime()) : null,
      ultimaModificacao: now,
      dataCancelamento: null,
      dataAprovacao: now,
      dataCadastro: now,
    });
  }
}

async function writePedido(i: number, spec: PedidoSeed): Promise<void> {
  const id = devPedidoId(i);
  const now = Date.now();
  const clienteRef = spec.withCliente ? db().collection('clientes').doc(CLIENTE_ID) : null;
  // Filial, operação, and endereço fiscal refs stamped on every seeded
  // pedido so the NFe orchestrator can resolve `<emit>` + `<ide>` +
  // `<dest><enderDest>`. The docs themselves are provisioned by
  // `seed:filiais` / `seed:operacoes` / `seed:enderecos` — run those
  // first (or alongside) for emission to work. The endereço is a
  // subcollection of the seeded cliente, only meaningful when
  // `clienteRef` is non-null.
  const filialRef = db().collection('filiais').doc(DEV_FILIAL_ID);
  const operacaoRef = db().collection('operacao').doc(DEV_OPERACAO_ID);
  const enderecoFiscalRef = clienteRef
    ? clienteRef.collection('enderecos').doc(DEV_ENDERECO_ID)
    : null;

  await db()
    .collection('pedidos')
    .doc(id)
    .set({
      ehSaida: true,
      estado: spec.estadoPedido,
      numero: spec.numero,
      ...devItensMap(spec.valorCobrado ?? 100, { omitImposto: spec.omitImposto }),
      descontoTotal: 0,
      valorCobrado: spec.valorCobrado ?? null,
      timestamp: us(now - i * 3_600_000),
      ultimaModificacao: us(now - i * 3_600_000),
      foiImpresso: spec.dtImpressao != null,
      dtImpressao: spec.dtImpressao != null ? us(spec.dtImpressao) : null,
      // Outer refs the cells dereference. `clientePedidoOuterRef`
      // matters for the UI walk; the other three (filial, operação,
      // endereço fiscal) are required by the NFe orchestrator
      // (`apps/nfe/lib/nfe/orchestrator.ts:146-154`).
      vendedorPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      operacaoPedidoOuterRef: operacaoRef,
      clientePedidoOuterRef: clienteRef,
      enderecoFiscalOuterRef: enderecoFiscalRef,
      listaDePrecosOuterRef: null,
      filialPedidoOuterRef: filialRef,
      // Optional embedded frete block. UI cells read `estado` +
      // `codRastreio` + `prazoDespacho`; the NF-e orchestrator reads
      // `modalidade` + `valorCobrado` + `transportadora` + `veiculo` +
      // `volumes`. Both sets coexist on the same struct.
      freteInicial: spec.frete
        ? {
            estado: spec.frete.estado,
            codRastreio: spec.frete.codRastreio ?? null,
            prazoDespacho: spec.frete.prazoDespacho != null ? us(spec.frete.prazoDespacho) : null,
            modalidade: spec.frete.modalidade ?? '0',
            valorCobrado: spec.frete.valorCobrado ?? null,
            transportadora: spec.frete.transportadora ?? null,
            veiculo: spec.frete.veiculo ?? null,
            reboques: null,
            vagao: null,
            balsa: null,
            volumes: spec.frete.volumes ?? null,
            ehReverso: false,
            prazoExtra: 0,
            timestamp: us(now - i * 3_600_000),
          }
        : null,
      infCpl: spec.infCpl ?? null,
    });

  if (spec.pagamentos && spec.pagamentos.length > 0) {
    await writePagamentos(id, spec.pagamentos);
  }
}

export async function seedDevPedidos(): Promise<{ created: number }> {
  await writeCliente();
  // Sequential so a fail mid-loop leaves a coherent partial state and
  // the next re-run overwrites cleanly.
  for (let i = 0; i < PEDIDOS.length; i += 1) {
    await writePedido(i + 1, PEDIDOS[i]!);
  }
  return { created: PEDIDOS.length };
}

export async function cleanupDevPedidos(): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of devPedidoIds()) {
    // Subcollections must be deleted explicitly — the Admin SDK doesn't
    // cascade them with the parent doc. Sweeps the two subcollections
    // we own: `nfev4` (the NF-e generator's output) and `pagamento`
    // (this seed's own writes).
    for (const sub of ['nfev4', 'pagamento']) {
      const subSnap = await db().collection('pedidos').doc(id).collection(sub).get();
      if (!subSnap.empty) {
        const batch = db().batch();
        subSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    }
    await db().collection('pedidos').doc(id).delete();
    deleted += 1;
  }
  await db().collection('clientes').doc(CLIENTE_ID).delete();
  return { deleted };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-pedidos-dev.ts') ||
  process.argv[1]?.endsWith('seed-pedidos-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevPedidos().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-pedidos-dev] removed ${deleted} pedido(s) + cliente`);
      })
    : seedDevPedidos().then(({ created }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-pedidos-dev] wrote ${created} pedido(s) + 1 cliente; ` +
            `ids: ${devPedidoId(1)}..${devPedidoId(created)}\n` +
            `[seed-pedidos-dev] next: run \`seed:nfe\` to populate the NF column live`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
