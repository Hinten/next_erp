/**
 * Live SEFAZ-SP homologação tests for the orchestrator path —
 * `emitirPedido` and `emitirPedidosLote` end-to-end against real SEFAZ
 * + staging Firestore.
 *
 * Mirrors the gating pattern of
 * `packages/integrations/nfe/test/operations/emission.homologacao.test.ts`:
 * `describe.skip`s itself when env credentials are missing. Runs in CI
 * via the `nfe-live` job in `.github/workflows/ci-nfe.yml`.
 *
 * Required env:
 *   - `NFE_CERT_BASE64` (or `NFE_CERT_PATH`) + `NFE_CERT_PASSWORD`
 *   - `NFE_TEST_IE` — the Inscrição Estadual registered for the cert's CNPJ
 *   - `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT`
 *
 * SEFAZ-SP HOM persists numeração across runs; a per-run starting `nNF`
 * derived from `Date.now() & 0xFFFFF` avoids the cStat=539 (duplicidade
 * with different chave) trap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESTADO_NFE } from '@delfrance/schemas';
import {
  consultarStatusServico,
  loadCertificateFromEnv,
} from '@delfrance/integrations-nfe';

import { getAdminFirestore } from '../../../lib/firebase/admin';
import {
  emitirPedido,
  emitirPedidosLote,
} from '../../../lib/nfe/orchestrator';
import {
  __resetNFeRuntimeForTests,
  getNFeRuntime,
  type NFeRuntime,
} from '../../../lib/nfe/runtime';

// ---------------------------------------------------------------------------
// Env gating
// ---------------------------------------------------------------------------

const hasCert =
  (Boolean(process.env.NFE_CERT_PATH) || Boolean(process.env.NFE_CERT_BASE64)) &&
  process.env.NFE_CERT_PASSWORD != null;
const hasFirebase =
  Boolean(process.env.FIREBASE_PROJECT_ID) &&
  (Boolean(process.env.FIREBASE_SERVICE_ACCOUNT) ||
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
const TEST_IE = process.env.NFE_TEST_IE;
const hasFullCreds = hasCert && hasFirebase && Boolean(TEST_IE);
const describeOrSkip = hasFullCreds ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Per-run fixture ids — keep CI runs from colliding on the staging project
// ---------------------------------------------------------------------------

const RUN_ID = Date.now().toString(36);
const FIXTURE_PREFIX = `ci-${RUN_ID}`;
const FILIAL_ID = `${FIXTURE_PREFIX}-filial`;
const CLIENTE_ID = `${FIXTURE_PREFIX}-cliente`;
const ENDERECO_ID = `${FIXTURE_PREFIX}-end`;
const OPERACAO_ID = `${FIXTURE_PREFIX}-op`;
const REGRA_ID = `${FIXTURE_PREFIX}-regra`;
const PRODUTO_UID = 'P-1';
const PED1 = `${FIXTURE_PREFIX}-PED-1`;
const PED3 = `${FIXTURE_PREFIX}-PED-3`;
const PED8 = `${FIXTURE_PREFIX}-PED-8`;

// Starting nNF — high enough to dodge prior CI runs' nNFs at SEFAZ.
// `Date.now() & 0xFFFFF` gives a 20-bit space (~1M unique values per
// second of wall-clock); collisions across CI runs separated by ≥1ms
// are astronomically unlikely.
const SEED_NNF_START = Date.now() & 0xfffff;
const SEED_IDLOTE_START = Date.now() & 0xffff;

// ---------------------------------------------------------------------------
// Fixture builders — minimal docs the orchestrator needs
// ---------------------------------------------------------------------------

function impostoCsosn102(): Record<string, unknown> {
  return {
    origem: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '21069090',
    unidade: 'UN',
    configuracaoICMS: { crt: '1', csosn: '102' },
    configuracaoPIS: { CST: '49' },
    configuracaoCOFINS: { CST: '49' },
  };
}

function filialDoc(cnpj: string, ie: string): Record<string, unknown> {
  return {
    razaoSocial: 'CI Test Filial Ltda',
    fantasia: 'CI Filial',
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
      codigoMunicipio: '3550308',
      cidade: 'Sao Paulo',
      estado: 'SP',
      cPais: '1058',
      pais: 'Brasil',
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
    },
  };
}

function clienteDoc(): Record<string, unknown> {
  // PF (tipo='0', no IE) — pairs with operação.ehConsumidorFinal=true
  // to clear cStat=696 ("indIEDest=9 + indFinal=0").
  return {
    tipo: '0',
    nome: 'Cliente Test PF',
    cpf_cnpj: '12345678909',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: 'ci-test@example.com',
    telefone: '11999990000',
    observacoesInternas: null,
    timestamp: new Date().toISOString(),
  };
}

function enderecoDoc(): Record<string, unknown> {
  return {
    logradouro: 'Av Cliente',
    numero: '1',
    bairro: 'Centro',
    cep: '01001000',
    codigoMunicipio: '3550308',
    cidade: 'Sao Paulo',
    estado: 'SP',
    complemento: null,
  };
}

function operacaoDoc(): Record<string, unknown> {
  return {
    nome: 'Venda interna SP (CI)',
    naturezaDaOperacao: 'Venda de mercadoria',
    tipo: 1,
    ehServico: false,
    ehExterior: false,
    ehConsumidorFinal: true,
    padrao: true,
    ativo: true,
    movimentaEstoque: true,
    movimentaIndisponivelEstoque: true,
    ehFiscal: true,
    finNFe: 1,
    indPres: '2',
    indIntermed: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    origem: '0',
    NCM: '21069090',
    CEST: null,
    unidade: 'UN',
    estadosDestino: null,
    estados: null,
    configuracaoICMS: null,
    configuracaoIPI: null,
    configuracaoPIS: null,
    configuracaoPISST: null,
    infCpl: null,
    timestamp: new Date().toISOString(),
  };
}

function regraImpostoDoc(): Record<string, unknown> {
  return {
    nome: 'CI resolver cascade rule',
    produtos: [PRODUTO_UID],
    categorias: [],
    ncms: [],
    dataCadastro: new Date().toISOString(),
    ...impostoCsosn102(),
  };
}

function pedidoDoc(
  pedidoId: string,
  valor: number,
  options: { omitImposto?: boolean } = {},
): Record<string, unknown> {
  const baseItem: Record<string, unknown> = {
    sku: `SKU-${pedidoId}`,
    gtin: null,
    nomeDeVenda: 'Produto CI',
    precoDeVenda: valor,
    descontoUnitario: null,
    quantidade: 1,
  };
  if (!options.omitImposto) baseItem.imposto = impostoCsosn102();

  return {
    ehSaida: true,
    estado: 'pago',
    numero: pedidoId.slice(-4),
    itens: { [PRODUTO_UID]: [baseItem] },
    descontoTotal: 0,
    valorCobrado: valor,
    timestamp: Date.now(),
    ultimaModificacao: Date.now(),
    foiImpresso: false,
    dtImpressao: null,
    filialPedidoOuterRef: `filiais/${FILIAL_ID}`,
    clientePedidoOuterRef: `clientes/${CLIENTE_ID}`,
    operacaoPedidoOuterRef: `operacao/${OPERACAO_ID}`,
    enderecoFiscalOuterRef: `clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`,
    vendedorPedidoOuterRef: null,
    integracaoPedidoOuterRef: null,
    listaDePrecosOuterRef: null,
    freteInicial: null,
    infCpl: null,
  };
}

function pagamentoDoc(valor: number): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'pag-01',
    metodoPagamentoOuterRef: null,
    forma_de_pagamento: 1, // dinheiro — simplest XSD-valid path
    status_pagamento: 4, // aprovado
    cartao: null,
    cheque: null,
    descricaoPagamento: null,
    valor,
    parcelas: 1,
    juros: null,
    tarifas: null,
    aVista: true,
    duplicata: false,
    nFat: null,
    vencimento: null,
    ultimaModificacao: now,
    dataCancelamento: null,
    dataAprovacao: now,
    dataCadastro: now,
  };
}

async function seedFixtures(
  fs: FirebaseFirestore.Firestore,
  cnpj: string,
  ie: string,
): Promise<void> {
  // Filial + NFeConfig — shared across all test pedidos.
  await fs.collection('filiais').doc(FILIAL_ID).set(filialDoc(cnpj, ie));
  await fs.doc(`filiais/${FILIAL_ID}/nfeconfig/default`).set({
    numeracao_atual: SEED_NNF_START,
    serie: 1,
    idLote: SEED_IDLOTE_START,
    ambiente: '2',
  });

  // Cliente + endereço.
  await fs.collection('clientes').doc(CLIENTE_ID).set(clienteDoc());
  await fs
    .doc(`clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`)
    .set(enderecoDoc());

  // Operação + regraImposto (the latter exercises the cascade for PED8).
  await fs.collection('operacao').doc(OPERACAO_ID).set(operacaoDoc());
  await fs
    .doc(`operacao/${OPERACAO_ID}/regraimposto/${REGRA_ID}`)
    .set(regraImpostoDoc());

  // Pedidos + one approved pagamento each (otherwise tPag='90' is the
  // default and we want to exercise the real <pag>/<detPag>/forma=01 path).
  for (const pedidoId of [PED1, PED3, PED8]) {
    const valor = 100 + Number(pedidoId.slice(-1)); // 101, 103, 108
    const omitImposto = pedidoId === PED8;
    await fs.collection('pedidos').doc(pedidoId).set(pedidoDoc(pedidoId, valor, { omitImposto }));
    await fs
      .doc(`pedidos/${pedidoId}/pagamento/pag-01`)
      .set(pagamentoDoc(valor));
  }
}

async function cleanupFixtures(fs: FirebaseFirestore.Firestore): Promise<void> {
  // Recursive cleanup: nfev4 subcollections + pagamento subcollections
  // + the pedido docs themselves. Then operacao + regraimposto. Then
  // cliente + endereço. Then filial + nfeconfig.
  async function deleteDocWithSubcoll(path: string, subcollections: string[]): Promise<void> {
    for (const sub of subcollections) {
      const snap = await fs.collection(`${path}/${sub}`).get();
      for (const d of snap.docs) await d.ref.delete();
    }
    await fs.doc(path).delete();
  }

  for (const pedidoId of [PED1, PED3, PED8]) {
    await deleteDocWithSubcoll(`pedidos/${pedidoId}`, ['nfev4', 'pagamento']);
  }
  await deleteDocWithSubcoll(`operacao/${OPERACAO_ID}`, ['regraimposto']);
  await fs.doc(`clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`).delete();
  await fs.doc(`clientes/${CLIENTE_ID}`).delete();
  await deleteDocWithSubcoll(`filiais/${FILIAL_ID}`, ['nfeconfig', 'enviNfe']);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrSkip('orchestrator — SEFAZ-SP homologação', () => {
  let fs: FirebaseFirestore.Firestore;
  let rt: NFeRuntime;

  beforeAll(async () => {
    // Load the cert once to extract its CNPJ — the filial fixture must
    // share that CNPJ-base or SEFAZ rejects with cStat=213.
    const cert = loadCertificateFromEnv();
    fs = getAdminFirestore();
    await seedFixtures(fs, cert.cnpj, TEST_IE!);
    __resetNFeRuntimeForTests();
    rt = getNFeRuntime();

    // SEFAZ pre-flight: warn loudly if the service is paralisado
    // (cStat 108/109) so a SEFAZ outage doesn't masquerade as an
    // orchestrator regression in the test report.
    const status = await consultarStatusServico(
      { url: rt.endpoints.NfeStatusServico, cert: rt.cert, agent: rt.agent, tpAmb: rt.tpAmb },
      { cUF: '35' },
    );
    if (status.cStat !== '107') {
      console.warn(
        `[orchestrator.homologacao] SEFAZ-SP HOM cStat=${status.cStat} ` +
          `(${status.xMotivo}) — proceeding anyway, but emit may reject.`,
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (fs) await cleanupFixtures(fs);
  }, 30_000);

  it('emitirPedido single happy path — PED-1 with imposto stamped → cStat=100', async () => {
    const result = await emitirPedido(fs, rt, PED1);
    expect(result.cStat).toBe('100');
    expect(result.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.chave).toMatch(/^\d{44}$/);
    expect(result.reused).toBe(false);
  }, 90_000);

  it('emitirPedido resolver-via-regra — PED-8 lacks item.imposto, regraImposto fills it → cStat=100', async () => {
    const result = await emitirPedido(fs, rt, PED8);
    expect(result.cStat).toBe('100');
    expect(result.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.chave).toMatch(/^\d{44}$/);
    expect(result.reused).toBe(false);
  }, 90_000);

  it(
    'emitirPedidosLote batch of 3 — jaAprovadas mirror (PED-1 + PED-8 reused, PED-3 fresh)',
    async () => {
      // Tests above already emitted PED-1 and PED-8 → their nfev4 docs
      // are now cStat=100 (bloqueada per STATUS_BLOQUEADORES). PED-3 is
      // still fresh. The batch should classify them as 2 reused + 1
      // fresh, all `estado='a'`, and only ONE entry hits the SEFAZ
      // autorizarLote NFe[] array.
      const batch = await emitirPedidosLote(fs, rt, [PED1, PED3, PED8]);
      expect(batch.results).toHaveLength(3);
      for (const r of batch.results) {
        expect('estado' in r).toBe(true);
        if ('estado' in r) {
          expect(r.estado).toBe(ESTADO_NFE.aprovada);
        }
      }
      const fresh = batch.results.filter((r) => 'reused' in r && r.reused === false);
      const reused = batch.results.filter((r) => 'reused' in r && r.reused === true);
      expect(fresh).toHaveLength(1);
      expect(reused).toHaveLength(2);
      expect(fresh[0]!.pedidoId).toBe(PED3);
    },
    120_000,
  );
});
