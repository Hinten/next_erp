import { db } from './admin';

/**
 * Dev-seed for `/operacao` — writes ONE operação fiscal
 * (`dev-operacao-01`) used by the seeded pedidos. The orchestrator
 * (`apps/nfe/lib/nfe/orchestrator.ts`) resolves
 * `operacaoPedidoOuterRef` to fill `<ide>` and `<det>` fields, and
 * falls back to operação-level `cfop` / `NCM` / `unidade` / `CEST`
 * when individual items don't ship their own.
 *
 * Defaults target a SP → SP venda interna saída (CFOP 5102, NCM
 * placeholder 21069090) — works against SEFAZ-SP HOM with the
 * seeded cliente. The pedidos seed (`seed-pedidos-dev.ts`) stamps
 * every dev pedido's `operacaoPedidoOuterRef` at this doc.
 *
 * Idempotent: re-running overwrites the same doc id. `--clean`
 * deletes without re-creating.
 *
 * Usage:
 *   pnpm --filter @delfrance/test-fixtures seed:operacoes
 *   pnpm --filter @delfrance/test-fixtures seed:operacoes --clean
 */

export const DEV_OPERACAO_ID = 'dev-operacao-01';

export async function seedDevOperacoes(): Promise<{ created: number }> {
  const now = new Date().toISOString();
  await db()
    .collection('operacao')
    .doc(DEV_OPERACAO_ID)
    .set({
      nome: 'Venda interna SP (dev)',
      naturezaDaOperacao: 'Venda de mercadoria',
      tipo: 1, // saída
      ehServico: false,
      ehExterior: false,
      // Cliente seeded by seed-pedidos-dev is PF (no IE) → orchestrator
      // stamps `indIEDest='9'` (Não Contribuinte). SEFAZ requires the
      // matching `indFinal='1'` on `<ide>`, which only flips when
      // `operacao.ehConsumidorFinal=true` (parties.ts:84 + ide.ts:103).
      // Without this pair, SEFAZ rejects with cStat=696.
      ehConsumidorFinal: true,
      padrao: true,
      ativo: true,
      movimentaEstoque: true,
      movimentaIndisponivelEstoque: true,
      ehFiscal: true,

      finNFe: 1, // normal
      indPres: '2', // operação não presencial pela internet
      indIntermed: '0', // sem intermediador (no integracaoPedidoOuterRef seeded)

      cfop: '5102', // venda de mercadoria adquirida de terceiros — interna
      cfopInterestadual: '6102', // mesma natureza, interestadual
      origem: '0', // nacional

      // Item-level fallbacks (used when pedido.itens[i].imposto is missing).
      NCM: '21069090', // placeholder generic — SEFAZ accepts any valid NCM
      CEST: null,
      unidade: 'UN',

      estadosDestino: null,
      estados: null,

      configuracaoICMS: null,
      configuracaoIPI: null,
      configuracaoPIS: null,
      configuracaoPISST: null,

      infCpl: null,

      timestamp: now,
    });
  return { created: 1 };
}

export async function cleanupDevOperacoes(): Promise<{ deleted: number }> {
  await db().collection('operacao').doc(DEV_OPERACAO_ID).delete();
  return { deleted: 1 };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-operacoes-dev.ts') ||
  process.argv[1]?.endsWith('seed-operacoes-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevOperacoes().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-operacoes-dev] removed ${deleted} operação(ões)`);
      })
    : seedDevOperacoes().then(({ created }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-operacoes-dev] wrote ${created} operação(ões) at ` +
            `operacao/${DEV_OPERACAO_ID}\n` +
            `[seed-operacoes-dev] next: re-run \`seed:pedidos\` so pedidos ` +
            `point at this operação`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
