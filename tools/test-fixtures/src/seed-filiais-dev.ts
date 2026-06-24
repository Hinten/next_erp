import { db } from './admin';

/**
 * Dev-seed for `/filiais` + per-filial `nfeconfig` — writes ONE filial
 * (`dev-filial-01`) with its initial NFe counters at
 * `filiais/dev-filial-01/nfeconfig/default`. Required for any NF-e
 * emission flow: the orchestrator (`apps/nfe/lib/nfe/orchestrator.ts`)
 * needs both docs to resolve `<emit>` data and allocate the next `nNF`
 * + `idLote`.
 *
 * This script also seeds a dev integração (`dev-integracao-01`) that owns
 * the filial via `filialIntegracaoPedidoOuterRef`. The pedido seed
 * (`seed-pedidos-dev.ts`) points each dev pedido's `integracaoPedidoOuterRef`
 * there, and the NF-e orchestrator resolves the issuing filial through it
 * (the pedido no longer carries a filial ref). Running this script first
 * wires the whole emission chain (modulo `operacaoPedidoOuterRef` +
 * `enderecoFiscalOuterRef`, still TODO).
 *
 * CNPJ / IE: read from env so the seed matches the user's A1 cert.
 *   - `NFE_TEST_CNPJ` — the 14-digit CNPJ from the cert's Subject CN.
 *     SEFAZ rejects with cStat=213 if this doesn't match the cert.
 *   - `NFE_TEST_IE`   — the Inscrição Estadual registered at SEFAZ-SP
 *     HOM for that CNPJ. SEFAZ rejects with cStat=209 if it doesn't
 *     match.
 *
 * Both env vars must be set in the repo-root `.env.local`. The seed
 * fails loudly if either is missing — better than seeding with a
 * placeholder that emission will silently reject later.
 *
 * Idempotent: re-running overwrites the same doc ids. Pass `--clean`
 * to delete (filial + nfeconfig subcollection) without re-creating.
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:filiais
 *   pnpm --filter @delfrance/test-fixtures seed:filiais --clean
 */

export const DEV_FILIAL_ID = 'dev-filial-01';
export const DEV_INTEGRACAO_ID = 'dev-integracao-01';
const NFE_CONFIG_ID = 'default';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `${name} is required to seed the dev filial — set it in the repo-root .env.local. ` +
        'See seed-filiais-dev.ts for the full rationale.',
    );
  }
  return v;
}

export async function seedDevFiliais(): Promise<{ created: number }> {
  const cnpj = requireEnv('NFE_TEST_CNPJ');
  const ie = requireEnv('NFE_TEST_IE');
  // Both filial.timestamp and nfeconfig.timestamp are milliseconds since epoch
  // (nfeconfig was converted in #253; the "still ISO" note no longer applies).
  const now = Date.now();

  await db()
    .collection('filiais')
    .doc(DEV_FILIAL_ID)
    .set({
      razaoSocial: 'Dev Filial Ltda',
      fantasia: 'Dev Filial',
      cnae: null,
      cnpj,
      ie,
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        logradouro: 'Rua Exemplo',
        numero: '100',
        bairro: 'Centro',
        complemento: null,
        cep: '01001000',
        codigoMunicipio: '3550308', // São Paulo / SP — IBGE
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: '1058',
        pais: 'Brasil',
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
      timestamp: Date.now(),
    });

  await db()
    .collection('filiais')
    .doc(DEV_FILIAL_ID)
    .collection('nfeconfig')
    .doc(NFE_CONFIG_ID)
    .set({
      numeracao_atual: 0,
      serie: 1,
      idLote: 0,
      ambiente: '2', // homologação
      timestamp: now,
    });

  // Dev integração that owns this filial — the pedido seed points
  // `integracaoPedidoOuterRef` here and the NF-e orchestrator resolves the
  // issuing filial via `integracao.filialIntegracaoPedidoOuterRef`.
  await db()
    .collection('integracao')
    .doc(DEV_INTEGRACAO_ID)
    .set({
      nome: 'Dev Balcão',
      tipo: 0,
      padrao: true,
      ativo: true,
      filialIntegracaoPedidoOuterRef: db().collection('filiais').doc(DEV_FILIAL_ID),
      tabelaNormalOuterRef: null,
      depositoOuterRef: null,
      dataCadastro: now,
    });

  return { created: 1 };
}

export async function cleanupDevFiliais(): Promise<{ deleted: number }> {
  const filialRef = db().collection('filiais').doc(DEV_FILIAL_ID);

  // Subcollections don't cascade — sweep nfeconfig explicitly.
  const cfgSnap = await filialRef.collection('nfeconfig').get();
  if (!cfgSnap.empty) {
    const batch = db().batch();
    cfgSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await filialRef.delete();
  await db().collection('integracao').doc(DEV_INTEGRACAO_ID).delete();
  return { deleted: 1 };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-filiais-dev.ts') ||
  process.argv[1]?.endsWith('seed-filiais-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupDevFiliais().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-filiais-dev] removed ${deleted} filial(is) + nfeconfig`);
      })
    : seedDevFiliais().then(({ created }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-filiais-dev] wrote ${created} filial(is) + nfeconfig at ` +
            `filiais/${DEV_FILIAL_ID}/nfeconfig/${NFE_CONFIG_ID}\n` +
            `[seed-filiais-dev] next: re-run \`seed:pedidos\` so pedidos ` +
            `point at this filial`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
