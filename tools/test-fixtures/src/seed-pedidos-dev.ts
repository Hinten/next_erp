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

interface PedidoSeed {
  readonly numero: string;
  readonly estadoPedido: string;
  /** When true, link to the seeded cliente so ClienteCell exercises its fetch. */
  readonly withCliente?: boolean;
  /** When set, stamp `dtImpressao` so ImpCell shows the printer icon. */
  readonly dtImpressao?: number;
  /** When set, stamp `freteInicial` so FreteCell shows a label + tracking. */
  readonly frete?: { estado: string; codRastreio?: string; prazoDespacho?: number };
  /** Cached total — the cell prefers this over recomputing from `itens`. */
  readonly valorCobrado?: number;
}

const PEDIDOS: PedidoSeed[] = [
  {
    numero: '0001',
    estadoPedido: 'pago',
    withCliente: true,
    dtImpressao: Date.now() - 86_400_000,
    frete: {
      estado: 'entregue',
      codRastreio: 'BR123456789',
      prazoDespacho: Date.now() - 172_800_000,
    },
    valorCobrado: 1499.9,
  },
  {
    numero: '0002',
    estadoPedido: 'emProcessamento',
    withCliente: true,
    frete: { estado: 'aCaminho', codRastreio: 'BR987654321' },
    valorCobrado: 250.0,
  },
  {
    numero: '0003',
    estadoPedido: 'aguardandoConfirmacaoDePagamento',
    withCliente: true,
    frete: { estado: 'aguardandoNFe' },
    valorCobrado: 75.5,
  },
  {
    numero: '0004',
    estadoPedido: 'emAnalise',
    frete: { estado: 'iniciado' },
    valorCobrado: 320.0,
  },
  {
    numero: '0005',
    estadoPedido: 'pago',
    withCliente: true,
    valorCobrado: 980.0,
  },
  {
    numero: '0006',
    estadoPedido: 'finalizado',
    withCliente: true,
    dtImpressao: Date.now() - 3_600_000,
    frete: { estado: 'postado', codRastreio: 'BR555555555' },
    valorCobrado: 49.9,
  },
  {
    numero: '0007',
    estadoPedido: 'cancelado',
    valorCobrado: 199.0,
  },
];

/** The stable ids of every pedido this script seeds (1-based order). */
export function devPedidoIds(): string[] {
  return PEDIDOS.map((_, i) => devPedidoId(i + 1));
}

async function writeCliente(): Promise<void> {
  await db()
    .collection('clientes')
    .doc(CLIENTE_ID)
    .set({
      tipo: '1', // Pessoa Jurídica
      nome: 'Dev Pedidos Cliente Ltda',
      // Known-valid test CNPJ (passes check digits). The previous value
      // 12345678000190 fails the SEFAZ CNPJ check-digit validation on
      // the destinatário, regardless of homologação leniency elsewhere.
      cpf_cnpj: '11222333000181',
      idEstrangeiro: null,
      ie: '110042490114',
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
function devItensMap(valor: number): {
  itens: Record<string, unknown[]>;
  itensIds: string[];
} {
  const produtoUid = 'dev-prod-01';
  return {
    itensIds: [produtoUid],
    itens: {
      [produtoUid]: [
        {
          sku: 'DEV-PROD-01',
          gtin: null,
          nomeDeVenda: 'Produto Dev',
          precoDeVenda: valor,
          descontoUnitario: null,
          quantidade: 1,
          imposto: {
            origem: '0',
            configuracaoICMS: {
              crt: '1', // Simples Nacional
              csosn: '102', // sem permissão de crédito
            },
            configuracaoPIS: { CST: '49' }, // outras operações de saída
            configuracaoCOFINS: { CST: '49' },
          },
        },
      ],
    },
  };
}

async function writePedido(i: number, spec: PedidoSeed): Promise<void> {
  const id = devPedidoId(i);
  const now = Date.now();
  const clienteRef = spec.withCliente
    ? db().collection('clientes').doc(CLIENTE_ID)
    : null;
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
      ...devItensMap(spec.valorCobrado ?? 100),
      descontoTotal: 0,
      valorCobrado: spec.valorCobrado ?? null,
      timestamp: now - i * 3_600_000,
      ultimaModificacao: now - i * 3_600_000,
      foiImpresso: spec.dtImpressao != null,
      dtImpressao: spec.dtImpressao ?? null,
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
      // Optional embedded frete block. The schema is wide; the cell only
      // reads `estado`, `codRastreio` and `prazoDespacho`, so the rest stay
      // at their default null/zero. `passthrough()` on the schema means
      // omitting fields is safe.
      freteInicial: spec.frete
        ? {
            estado: spec.frete.estado,
            codRastreio: spec.frete.codRastreio ?? null,
            prazoDespacho: spec.frete.prazoDespacho ?? null,
            modalidade: '0',
            ehReverso: false,
            prazoExtra: 0,
            timestamp: now - i * 3_600_000,
          }
        : null,
    });
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
    // cascade them with the parent doc. Sweeps any `nfev4` docs the NF-e
    // generator may have written.
    const nfeSnap = await db()
      .collection('pedidos')
      .doc(id)
      .collection('nfev4')
      .get();
    if (!nfeSnap.empty) {
      const batch = db().batch();
      nfeSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
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
