import { db } from './admin';

/**
 * Dev-seed for the `/pedidos` TableView — writes a handful of pedidos with
 * varying `estado`, NFe state, frete state, print metadata and cliente
 * references, so you can run the app locally and eyeball every cell
 * variant (NFCell badges, ClienteCell link + tooltip, FreteCell label,
 * ImpCell icon).
 *
 * Idempotent: every seeded doc uses a stable `dev-pedidos-...` id, so
 * re-running this script just overwrites the previous run. Pass `--clean`
 * to delete everything the seed wrote without re-creating it.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:pedidos          # create + overwrite
 *   pnpm --filter @delfrance/test-fixtures seed:pedidos --clean  # delete only
 *
 * Requires the same env as the e2e fixtures: `FIREBASE_SERVICE_ACCOUNT`
 * (or `FIREBASE_SERVICE_ACCOUNT_PATH`) and `FIREBASE_PROJECT_ID`. Targets
 * the database named by `FIREBASE_DATABASE_ID` (default `'default'`).
 */

const PREFIX = 'dev-pedidos';
const CLIENTE_ID = `${PREFIX}-cliente`;

/**
 * Build a pedido id for the seeded entry at index `i`. Stable across
 * runs so re-seeding overwrites instead of accreting docs.
 */
function pedidoId(i: number): string {
  return `${PREFIX}-${String(i).padStart(2, '0')}`;
}

interface NFeSeed {
  readonly estado: string;
  readonly chave?: string | null;
  readonly xMotivo?: string | null;
  readonly error?: string | null;
  readonly tpEmis?: number;
}

interface PedidoSeed {
  readonly numero: string;
  readonly estadoPedido: string;
  /** Set when the pedido should have a row in `nfev4` (latest doc). */
  readonly nfe?: NFeSeed;
  /** When true, link to the seeded cliente so ClienteCell exercises its fetch. */
  readonly withCliente?: boolean;
  /** When set, stamp `dtImpressao` so ImpCell shows the printer icon. */
  readonly dtImpressao?: number;
  /** When set, stamp `freteInicial` so FreteCell shows a label + tracking. */
  readonly frete?: { estado: string; codRastreio?: string; prazoDespacho?: number };
  /** Cached total — the cell prefers this over recomputing from `itens`. */
  readonly valorCobrado?: number;
}

// A representative slice of the NFe state machine so the operator can
// confirm every NFCell branch renders correctly: aprovada (green), rejeitada
// (red + tooltip), error (red), aguardando (yellow), gerado (gray),
// contingência via `tpEmis=9` (outline variant), and one row with no NFe at
// all (DASH).
const PEDIDOS: PedidoSeed[] = [
  {
    numero: '0001',
    estadoPedido: 'pago',
    nfe: { estado: 'a', chave: '3'.repeat(44) },
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
    nfe: {
      estado: 'n',
      xMotivo: '561 - Inscrição estadual do destinatário inválida',
    },
    withCliente: true,
    frete: { estado: 'aCaminho', codRastreio: 'BR987654321' },
    valorCobrado: 250.0,
  },
  {
    numero: '0003',
    estadoPedido: 'aguardandoConfirmacaoDePagamento',
    nfe: { estado: '2' },
    withCliente: true,
    frete: { estado: 'aguardandoNFe' },
    valorCobrado: 75.5,
  },
  {
    numero: '0004',
    estadoPedido: 'emAnalise',
    nfe: { estado: 'e', error: 'TLS handshake failed contacting SEFAZ-RS' },
    frete: { estado: 'iniciado' },
    valorCobrado: 320.0,
  },
  {
    numero: '0005',
    estadoPedido: 'pago',
    // EPEC aprovado + tpEmis=9 (SVC) → outline variant in the NFCell badge.
    nfe: { estado: 'p', chave: '4'.repeat(44), tpEmis: 9 },
    withCliente: true,
    valorCobrado: 980.0,
  },
  {
    numero: '0006',
    estadoPedido: 'finalizado',
    // No NFe doc — NFCell falls back to DASH.
    withCliente: true,
    dtImpressao: Date.now() - 3_600_000,
    frete: { estado: 'postado', codRastreio: 'BR555555555' },
    valorCobrado: 49.9,
  },
  {
    numero: '0007',
    estadoPedido: 'cancelado',
    nfe: { estado: 'c' },
    valorCobrado: 199.0,
  },
];

async function writeCliente(): Promise<void> {
  await db()
    .collection('clientes')
    .doc(CLIENTE_ID)
    .set({
      tipo: '1', // Pessoa Jurídica
      nome: 'Dev Pedidos Cliente Ltda',
      cpf_cnpj: '12345678000190',
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

async function writePedido(i: number, spec: PedidoSeed): Promise<void> {
  const id = pedidoId(i);
  const now = Date.now();
  const clienteRef = spec.withCliente
    ? db().collection('clientes').doc(CLIENTE_ID)
    : null;

  await db()
    .collection('pedidos')
    .doc(id)
    .set({
      ehSaida: true,
      estado: spec.estadoPedido,
      numero: spec.numero,
      itens: {},
      itensIds: [],
      descontoTotal: 0,
      valorCobrado: spec.valorCobrado ?? null,
      timestamp: now - i * 3_600_000,
      ultimaModificacao: now - i * 3_600_000,
      foiImpresso: spec.dtImpressao != null,
      dtImpressao: spec.dtImpressao ?? null,
      // Outer refs the cells dereference. Only `clientePedidoOuterRef`
      // matters for the seeded UI walk; the rest stay null.
      vendedorPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: clienteRef,
      enderecoFiscalOuterRef: null,
      listaDePrecosOuterRef: null,
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

  if (!spec.nfe) return;
  await db()
    .collection('pedidos')
    .doc(id)
    .collection('nfev4')
    .doc(`${id}-nfe`)
    .set({
      numeracao: 1000 + i,
      serie: 1,
      tpEmis: spec.nfe.tpEmis ?? 1,
      estado: spec.nfe.estado,
      chave: spec.nfe.chave ?? null,
      idLote: null,
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: null,
      nRec: null,
      retries: null,
      cStat: null,
      xMotivo: spec.nfe.xMotivo ?? null,
      error: spec.nfe.error ?? null,
      timestamp: now - i * 3_600_000,
      ultima_modificacao: new Date(now - i * 3_600_000).toISOString(),
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
  for (let i = 0; i < PEDIDOS.length; i += 1) {
    const id = pedidoId(i + 1);
    // Subcollections must be deleted explicitly — the Admin SDK doesn't
    // cascade them with the parent doc.
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
          `[seed-pedidos-dev] wrote ${created} pedido(s) + 1 cliente; ids: ${pedidoId(1)}..${pedidoId(created)}`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
