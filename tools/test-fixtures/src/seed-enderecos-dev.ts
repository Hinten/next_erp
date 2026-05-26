import { db } from './admin';
import { CLIENTE_ID } from './seed-pedidos-dev';

/**
 * Dev-seed for `clientes/{clienteId}/enderecos` — writes ONE endereço
 * under the dev pedidos cliente (`dev-pedidos-cliente`). The pedidos
 * seed (`seed-pedidos-dev.ts`) stamps every dev pedido's
 * `enderecoFiscalOuterRef` at this doc — the orchestrator
 * (`apps/nfe/lib/nfe/orchestrator.ts:154`) requires it to resolve
 * `<dest><enderDest>` for the NF-e XML.
 *
 * Address: a valid SP, BR address (`São Paulo`, IBGE 3550308). Adjust
 * the values if your test cert / NFe operation targets another UF.
 *
 * The endereço path is `clientes/{CLIENTE_ID}/enderecos/{enderecoId}`.
 * Firestore subcollection writes don't require the parent doc to
 * exist, so this seed runs cleanly in any order — but for a coherent
 * dataset, run `seed:pedidos` (creates the cliente) before or after.
 *
 * Idempotent: re-running overwrites the same doc id. `--clean`
 * deletes without re-creating.
 *
 * Usage:
 *   pnpm --filter @delfrance/test-fixtures seed:enderecos
 *   pnpm --filter @delfrance/test-fixtures seed:enderecos --clean
 */

export const DEV_ENDERECO_ID = 'dev-endereco-01';

export async function seedDevEnderecos(): Promise<{ created: number }> {
  await db()
    .collection('clientes')
    .doc(CLIENTE_ID)
    .collection('enderecos')
    .doc(DEV_ENDERECO_ID)
    .set({
      idExterno: null,
      logradouro: 'Avenida Paulista',
      numero: '1000',
      bairro: 'Bela Vista',
      complemento: null,
      cep: '01310100',
      codigoMunicipio: '3550308', // São Paulo / SP — IBGE
      cidade: 'São Paulo',
      estado: 'SP',
      cPais: '1058',
      pais: 'Brasil',
      nome: 'Dev Pedidos Cliente Ltda',
      // Same valid test CNPJ as the cliente doc (seed-pedidos-dev.ts).
      cpf_cnpj: '11222333000181',
      rg: null,
      ie: '110042490114',
      imun: null,
      email: 'dev-pedidos@example.com',
      telefone: '11999990000',
    });
  return { created: 1 };
}

export async function cleanupDevEnderecos(): Promise<{ deleted: number }> {
  await db()
    .collection('clientes')
    .doc(CLIENTE_ID)
    .collection('enderecos')
    .doc(DEV_ENDERECO_ID)
    .delete();
  return { deleted: 1 };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-enderecos-dev.ts') ||
  process.argv[1]?.endsWith('seed-enderecos-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevEnderecos().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-enderecos-dev] removed ${deleted} endereço(s)`);
      })
    : seedDevEnderecos().then(({ created }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-enderecos-dev] wrote ${created} endereço(s) at ` +
            `clientes/${CLIENTE_ID}/enderecos/${DEV_ENDERECO_ID}\n` +
            `[seed-enderecos-dev] next: re-run \`seed:pedidos\` so pedidos ` +
            `point at this endereço`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
