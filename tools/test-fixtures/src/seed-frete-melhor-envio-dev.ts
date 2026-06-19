import { db } from './admin';

/**
 * Dev-seed for the Melhor Envio **etiqueta** UI (F5.3) — wires a complete,
 * ready-to-test freight scenario so you can exercise the Frete tab's
 * Comprar / Imprimir / Rastrear panel and the `/pedidos` "Imprimir etiqueta"
 * row action without hand-building a pedido.
 *
 * It writes:
 *   - a cliente (PF) + one endereço (the delivery / "Quem recebe" address),
 *   - a filial + a `melhorEnvios` int_frete (ONLY when you don't point it at
 *     an existing, already-connected integração — see `ME_INT_FRETE_ID`),
 *   - TWO pedidos in a freight modalidade, both wired to the integração +
 *     endereço, with a selected quote (`externalOptionId`):
 *       • `dev-frete-me-01` — printLabelId = null  → exercises **Comprar**
 *         (cart-payload build + the resolve-gating).
 *       • `dev-frete-me-02` — printLabelId set      → makes the `/pedidos`
 *         row action appear and the panel show Imprimir / Rastrear.
 *
 * ## Buying a real label
 *
 * `Comprar` calls the LIVE Melhor Envio sandbox, which needs a **connected**
 * integração (a token in `int_frete/{id}/tokenMelEnv`). A fixture-created
 * integração has no token, so Comprar returns 409 `ME_REAUTH` — fine for
 * eyeballing the panel/gating, but not a real buy. To do a real sandbox buy,
 * set `ME_INT_FRETE_ID` to one you've already connected via OAuth
 * (Logística › Melhor Envio): the pedidos point at it (and its filial), and
 * NO dev filial/int_frete are created.
 *
 * Likewise `Imprimir`/`Rastrear` hit ME with `printLabelId`; the dev default
 * (`dev-label-0001`) only proves the buttons + wiring (ME will 404 it). Set
 * `ME_PRINT_LABEL_ID` to a real ME order id to print/track for real.
 *
 * Idempotent: stable ids, re-running overwrites. `--clean` deletes everything
 * this seed wrote (only the dev filial/int_frete when they were created here —
 * never an integração you passed via `ME_INT_FRETE_ID`).
 *
 * Usage (from the repo root):
 *   pnpm --filter @delfrance/test-fixtures seed:frete-me
 *   ME_INT_FRETE_ID=<id> pnpm --filter @delfrance/test-fixtures seed:frete-me
 *   pnpm --filter @delfrance/test-fixtures seed:frete-me --clean
 *
 * Requires the same env as the other fixtures: `FIREBASE_SERVICE_ACCOUNT`
 * (or `_PATH`) + `FIREBASE_PROJECT_ID`, targeting `FIREBASE_DATABASE_ID`.
 */

const PREFIX = 'dev-frete-me';
export const FRETE_CLIENTE_ID = `${PREFIX}-cliente`;
export const FRETE_ENDERECO_ID = `${PREFIX}-endereco`;
export const FRETE_FILIAL_ID = `${PREFIX}-filial`;
export const FRETE_INT_ID = `${PREFIX}-int`;
export const FRETE_PEDIDO_READY_ID = `${PREFIX}-01`;
export const FRETE_PEDIDO_BOUGHT_ID = `${PREFIX}-02`;

/** ms → µs — pedido/frete datetime fields are microseconds since epoch. */
const us = (ms: number): number => ms * 1000;

/** A full enderecoSchema object (origin + delivery share the shape). */
function endereco(over: {
  cep: string;
  logradouro: string;
  numero: string;
  bairro: string;
  cidade: string;
  estado: string;
  nome?: string | null;
  cpf_cnpj?: string | null;
  email?: string | null;
  telefone?: string | null;
}): Record<string, unknown> {
  return {
    idExterno: null,
    cep: over.cep,
    logradouro: over.logradouro,
    numero: over.numero,
    bairro: over.bairro,
    complemento: null,
    codigoMunicipio: null,
    cidade: over.cidade,
    estado: over.estado,
    cPais: '1058',
    pais: 'Brasil',
    nome: over.nome ?? null,
    cpf_cnpj: over.cpf_cnpj ?? null,
    rg: null,
    ie: null,
    imun: null,
    email: over.email ?? null,
    telefone: over.telefone ?? null,
  };
}

/** Resolve the integração the pedidos point at + whether we own (created) it. */
function resolveIntegracao(): { intFreteId: string; created: boolean } {
  const existing = process.env.ME_INT_FRETE_ID?.trim();
  if (existing) return { intFreteId: existing, created: false };
  return { intFreteId: FRETE_INT_ID, created: true };
}

async function writeCliente(): Promise<void> {
  await db().collection('clientes').doc(FRETE_CLIENTE_ID).set({
    tipo: '0', // Pessoa Física
    nome: 'Cliente Frete Dev',
    cpf_cnpj: '12345678909',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: 'frete-dev@example.com',
    telefone: '21999998888',
    observacoesInternas: null,
    timestamp: Date.now(),
    nome_embedding: null,
    telefone_embedding: null,
    userCliente: null,
  });

  // Delivery / "Quem recebe" address — a real RJ CEP so a live quote/buy can
  // actually price a route from the origin.
  await db()
    .collection('clientes')
    .doc(FRETE_CLIENTE_ID)
    .collection('enderecos')
    .doc(FRETE_ENDERECO_ID)
    .set(
      endereco({
        cep: '20040002',
        logradouro: 'Rua da Assembleia',
        numero: '10',
        bairro: 'Centro',
        cidade: 'Rio de Janeiro',
        estado: 'RJ',
        nome: 'Maria Recebedora',
        cpf_cnpj: '12345678909',
        email: 'frete-dev@example.com',
        telefone: '21999998888',
      }),
    );
}

/** Create the dev filial + melhorEnvios int_frete (only when not reusing one). */
async function writeIntegracao(): Promise<void> {
  await db()
    .collection('filiais')
    .doc(FRETE_FILIAL_ID)
    .set({
      razaoSocial: 'Frete Dev Comércio LTDA',
      fantasia: 'Frete Dev',
      cnae: '4781400',
      cnpj: '12345678000199',
      ie: '111222333',
      iest: null,
      imun: null,
      sede: endereco({
        cep: '01310100',
        logradouro: 'Av Paulista',
        numero: '1000',
        bairro: 'Bela Vista',
        cidade: 'São Paulo',
        estado: 'SP',
      }),
      timestamp: Date.now(),
    });

  await db()
    .collection('int_frete')
    .doc(FRETE_INT_ID)
    .set({
      tipo: 'melhorEnvios',
      nome: 'Melhor Envio (dev)',
      ativo: true,
      filialIntegracaoFreteOuterRef: `documents/filiais/${FRETE_FILIAL_ID}`,
      // Origin address — a real SP CEP so live quotes price a route.
      enderecoDeOrigem: endereco({
        cep: '01310100',
        logradouro: 'Av Paulista',
        numero: '1000',
        bairro: 'Bela Vista',
        cidade: 'São Paulo',
        estado: 'SP',
        email: 'loja-dev@example.com',
        telefone: '1133334444',
      }),
      dataCadastro: Date.now(),
      mapa: null,
      faixaCep: null,
      horarioDeCorte: null,
      prazoExtra: 0,
      // Env creds are used by the Next flow; these stay null (read-compat).
      client_id: null,
      client_secret: null,
    });
}

/** A freteInicial block in the `melhorEnvios` shape the etiqueta panel reads. */
function freteInicial(opts: {
  intFreteId: string;
  printLabelId: string | null;
  estado: string;
  codRastreio: string | null;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    externalId: null,
    printLabelId: opts.printLabelId,
    // A pre-selected quote (Correios PAC = service 1) so the panel is "ready".
    // If a live buy 422s, re-quote with "Calcular frete" and re-select.
    externalOptionId: '1',
    // The integração **tipo** enum (`integracoesFreteSchema`), not the doc id —
    // matches what `onSelectQuote` writes (see #218 / PR #223).
    externalOptionIntegracao: 'melhorEnvios',
    externalOptionData: { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
    externalOptionSelectionDate: us(now),
    estado: opts.estado,
    // String doc-path refs (what IntegracaoFreteSelect / EnderecoPicker write;
    // `dereferenceOuterRef` resolves them).
    integracaoFreteOuterRef: `documents/int_frete/${opts.intFreteId}`,
    integracaoTargetOuterRef: null,
    integracao_path: null,
    clienteRecebedorOuterReference: null,
    enderecoFreteOuterReference: `documents/clientes/${FRETE_CLIENTE_ID}/enderecos/${FRETE_ENDERECO_ID}`,
    modalidade: '0',
    transportadora: null,
    veiculo: null,
    reboques: null,
    vagao: null,
    balsa: null,
    volumes: [
      {
        quantidade: 1,
        especie: 'CAIXA',
        marca: null,
        numero: '1',
        pesoBruto: 1,
        pesoLiquido: null,
        dimensoes: { altura: 10, largura: 15, comprimento: 20 },
        lacres: null,
      },
    ],
    codRastreio: opts.codRastreio,
    valorCobrado: 25,
    custoCalculado: 25,
    custoFinal: 25,
    ehReverso: false,
    prazoExtra: 0,
    prazoDespacho: null,
    dataEntrega: null,
    dataPrevisaoEntrega: null,
    valor_assegurado: 100,
    maoPropria: false,
    avisoRecebimento: false,
    ultimaModificacao: us(now),
    timestamp: us(now),
  };
}

async function writePedido(
  id: string,
  numero: string,
  frete: Record<string, unknown>,
): Promise<void> {
  const now = Date.now();
  const clienteRef = db().collection('clientes').doc(FRETE_CLIENTE_ID);
  await db()
    .collection('pedidos')
    .doc(id)
    .set({
      ehSaida: true,
      estado: 'pago',
      numero,
      itensIds: ['dev-frete-prod-01'],
      itens: {
        'dev-frete-prod-01': [
          {
            sku: 'DEV-FRETE-01',
            gtin: null,
            nomeDeVenda: 'Produto Frete Dev',
            precoDeVenda: 120,
            descontoUnitario: null,
            quantidade: 1,
          },
        ],
      },
      descontoTotal: 0,
      valorCobrado: 145,
      timestamp: us(now),
      ultimaModificacao: us(now),
      foiImpresso: false,
      dtImpressao: null,
      vendedorPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: clienteRef,
      enderecoFiscalOuterRef: null,
      listaDePrecosOuterRef: null,
      freteInicial: frete,
      infCpl: null,
    });
}

export async function seedFreteMelhorEnvio(): Promise<{ intFreteId: string; created: boolean }> {
  const { intFreteId, created } = resolveIntegracao();
  await writeCliente();
  if (created) await writeIntegracao();

  await writePedido(
    FRETE_PEDIDO_READY_ID,
    'FRETE-01',
    freteInicial({ intFreteId, printLabelId: null, estado: 'iniciado', codRastreio: null }),
  );
  await writePedido(
    FRETE_PEDIDO_BOUGHT_ID,
    'FRETE-02',
    freteInicial({
      intFreteId,
      printLabelId: process.env.ME_PRINT_LABEL_ID?.trim() || 'dev-label-0001',
      estado: 'aguardandoPostagem',
      codRastreio: null,
    }),
  );

  return { intFreteId, created };
}

export async function cleanupFreteMelhorEnvio(): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of [FRETE_PEDIDO_READY_ID, FRETE_PEDIDO_BOUGHT_ID]) {
    await db().collection('pedidos').doc(id).delete();
    deleted += 1;
  }
  // Endereço subcollection doesn't cascade — delete it before the cliente.
  await db()
    .collection('clientes')
    .doc(FRETE_CLIENTE_ID)
    .collection('enderecos')
    .doc(FRETE_ENDERECO_ID)
    .delete();
  await db().collection('clientes').doc(FRETE_CLIENTE_ID).delete();
  // Only remove the integração/filial when THIS seed created them — never an
  // existing one passed via ME_INT_FRETE_ID.
  if (!process.env.ME_INT_FRETE_ID?.trim()) {
    await db().collection('int_frete').doc(FRETE_INT_ID).delete();
    await db().collection('filiais').doc(FRETE_FILIAL_ID).delete();
  }
  return { deleted };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-frete-melhor-envio-dev.ts') ||
  process.argv[1]?.endsWith('seed-frete-melhor-envio-dev.js');

if (isDirectInvocation) {
  const shouldClean = process.argv.includes('--clean');
  const runner = shouldClean
    ? cleanupFreteMelhorEnvio().then(({ deleted }) => {
        // eslint-disable-next-line no-console
        console.log(`[seed-frete-me] removed ${deleted} pedido(s) + cliente/endereço (+ dev int)`);
      })
    : seedFreteMelhorEnvio().then(({ intFreteId, created }) => {
        // eslint-disable-next-line no-console
        console.log(
          `[seed-frete-me] wrote 2 pedidos wired to int_frete/${intFreteId}` +
            `${created ? ' (dev integração created — no token, Comprar → ME_REAUTH)' : ' (existing integração)'}\n` +
            `[seed-frete-me]   • ${FRETE_PEDIDO_READY_ID} (FRETE-01) → open in edit mode, test Comprar\n` +
            `[seed-frete-me]   • ${FRETE_PEDIDO_BOUGHT_ID} (FRETE-02) → has printLabelId, test the /pedidos row action + Imprimir/Rastrear\n` +
            `[seed-frete-me] tip: ME_INT_FRETE_ID=<connected id> for a real sandbox buy; ME_PRINT_LABEL_ID=<real order id> to print/track for real`,
        );
      });
  runner.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
