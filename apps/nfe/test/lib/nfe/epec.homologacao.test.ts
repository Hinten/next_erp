/**
 * Live SEFAZ-SP homologação **EPEC** (Evento Prévio de Emissão em
 * Contingência) round-trip — orchestrator path, real Ambiente Nacional +
 * staging Firestore.
 *
 * First live-validated by hand on 2026-06-11 (evento accepted by the AN,
 * cStat 136; the pós-EPEC retransmission to the home SEFAZ succeeded after
 * the expected 468 retry window). This file automates that same round-trip
 * so a future EPEC regression alerts on its own instead of waiting for the
 * next real SEFAZ outage. Runs in CI via the scheduled
 * `.github/workflows/nfe-epec-scheduled.yml` (monthly) or on-demand via
 * `workflow_dispatch` — deliberately **not** wired into the per-PR
 * `ci-nfe.yml` live lane: the AN round-trip + pós-EPEC leg are slow and
 * stateful, not the kind of check that should gate every PR (#130).
 *
 * Test shape:
 *   1. Flip the fixture filial's `NFeConfig.contingencia_modo` to `'epec'`
 *      and call `emitirPedido` — the orchestrator routes into
 *      `enviarEpecParaNota` (tpEvento 110140 → AN) instead of `autorizarLote`.
 *      Accept cStat **135 or 136** (both mean "EPEC registrado" — see
 *      `EPEC_EVENT_REGISTRADO`), estado → `epecAprovado`.
 *   2. Call `emitirPedido` again on the SAME pedido, contingência still
 *      `'epec'` in config. `prepareEmission` resolves the same tpEmis=4 doc
 *      (`s4`), sees it already `epecAprovado`, and the emit cycle
 *      automatically routes into `transmitirPosEpec` — the FULL NF-e
 *      transmitted to the home SEFAZ on the same chave. Accept **100/150**
 *      (aprovada) or the retryable **468** (EPEC not yet synced at the home
 *      SEFAZ — estado stays `epecAprovado` for a later retry); either is a
 *      pass, per the MOC's own retry contract.
 *
 * Required env (same as `orchestrator.homologacao.test.ts`):
 *   - `NFE_CERT_BASE64` (or `NFE_CERT_PATH`) + `NFE_CERT_PASSWORD`
 *   - `NFE_TEST_IE`
 *   - `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT`(`_PATH`)
 *
 * **serie lane**: this suite owns **serie 5** (`SEFAZ_HOM_EPEC_SERIE`) — full
 * lane registry in `homologacao-seed.ts`. `nNF` comes from `seedNNF()`, same
 * collision-avoidance rationale as every other live suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTINGENCIA_MODO, ESTADO_NFE } from '@delfrance/schemas';
import {
  assertNotConsumoIndevido,
  hasNFeCertEnv,
  loadCertificateFromEnv,
} from '@delfrance/integrations-nfe';
import {
  seedIdLote,
  seedNNF,
  SEFAZ_HOM_EPEC_SERIE,
} from '@delfrance/integrations-nfe/test-helpers/homologacao-seed';
import { logSefaz } from '@delfrance/integrations-nfe/test-helpers/sefaz-log';

import { getAdminFirestore } from '../../../lib/firebase/admin';
import { emitirPedido } from '../../../lib/nfe/orchestrator';
import {
  __resetNFeRuntimeForTests,
  getNFeRuntime,
  type NFeBaseRuntime,
} from '../../../lib/nfe/runtime';

// ---------------------------------------------------------------------------
// Env gating — same posture as every other live homologação suite: skip
// cleanly with no creds locally, fail loud in CI (never a silently-green
// fiscal lane with zero coverage).
// ---------------------------------------------------------------------------

const hasCert = hasNFeCertEnv();
const hasFirebase =
  Boolean(process.env.FIREBASE_PROJECT_ID) &&
  (Boolean(process.env.FIREBASE_SERVICE_ACCOUNT) ||
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
const TEST_IE = process.env.NFE_TEST_IE;
const hasFullCreds = hasCert && hasFirebase && Boolean(TEST_IE);

const describeOrSkip = !hasFullCreds && !process.env.CI ? describe.skip : describe;

// ---------------------------------------------------------------------------
// Per-run fixture ids
// ---------------------------------------------------------------------------

const RUN_ID = Date.now().toString(36);
const FIXTURE_PREFIX = `ci-epec-${RUN_ID}`;
const FILIAL_ID = `${FIXTURE_PREFIX}-filial`;
const CLIENTE_ID = `${FIXTURE_PREFIX}-cliente`;
const ENDERECO_ID = `${FIXTURE_PREFIX}-end`;
const OPERACAO_ID = `${FIXTURE_PREFIX}-op`;
const INTEGRACAO_ID = `${FIXTURE_PREFIX}-int`;
const PRODUTO_UID = 'P-1';
const PEDIDO_ID = `${FIXTURE_PREFIX}-PED-1`;

const SEED_NNF_START = seedNNF();
const SEED_IDLOTE_START = seedIdLote();

// ---------------------------------------------------------------------------
// Fixture builders — minimal docs the orchestrator needs, EPEC contingência active
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
    razaoSocial: 'CI Test Filial EPEC Ltda',
    fantasia: 'CI Filial EPEC',
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
  return {
    tipo: '0',
    nome: 'Cliente Test PF EPEC',
    cpf_cnpj: '12345678909',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: 'ci-epec-test@example.com',
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
    nome: 'Venda interna SP (CI EPEC)',
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

function pedidoDoc(valor: number): Record<string, unknown> {
  return {
    ehSaida: true,
    estado: 'pago',
    numero: PEDIDO_ID.slice(-4),
    itens: {
      [PRODUTO_UID]: [
        {
          sku: `SKU-${PEDIDO_ID}`,
          gtin: null,
          nomeDeVenda: 'Produto CI EPEC',
          precoDeVenda: valor,
          descontoUnitario: null,
          quantidade: 1,
          imposto: impostoCsosn102(),
        },
      ],
    },
    descontoTotal: 0,
    valorCobrado: valor,
    timestamp: Date.now(),
    ultimaModificacao: Date.now(),
    foiImpresso: false,
    dtImpressao: null,
    clientePedidoOuterRef: `clientes/${CLIENTE_ID}`,
    operacaoPedidoOuterRef: `operacao/${OPERACAO_ID}`,
    enderecoFiscalOuterRef: `clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`,
    vendedorPedidoOuterRef: null,
    integracaoPedidoOuterRef: `integracao/${INTEGRACAO_ID}`,
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
    forma_de_pagamento: 1,
    status_pagamento: 4,
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
  await fs.collection('filiais').doc(FILIAL_ID).set(filialDoc(cnpj, ie));
  // Contingência EPEC active from the start — dataInicio must precede
  // dhEmi (the generator stamps dhEmi = now at emission time).
  await fs.doc(`filiais/${FILIAL_ID}/nfeconfig/default`).set({
    numeracao_atual: SEED_NNF_START,
    serie: SEFAZ_HOM_EPEC_SERIE,
    idLote: SEED_IDLOTE_START,
    ambiente: '2',
    contingencia_modo: CONTINGENCIA_MODO.epec,
    contingencia_justificativa:
      'Teste automatizado de contingencia EPEC em ambiente de homologacao',
    contingencia_dataInicio: Date.now() - 60_000,
  });

  await fs
    .collection('integracao')
    .doc(INTEGRACAO_ID)
    .set({
      nome: 'CI canal EPEC',
      tipo: 0,
      padrao: false,
      ativo: true,
      filialIntegracaoPedidoOuterRef: `filiais/${FILIAL_ID}`,
    });

  await fs.collection('clientes').doc(CLIENTE_ID).set(clienteDoc());
  await fs.doc(`clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`).set(enderecoDoc());
  await fs.collection('operacao').doc(OPERACAO_ID).set(operacaoDoc());

  const valor = 121;
  await fs.collection('pedidos').doc(PEDIDO_ID).set(pedidoDoc(valor));
  await fs.doc(`pedidos/${PEDIDO_ID}/pagamentos/pag-01`).set(pagamentoDoc(valor));
}

async function cleanupFixtures(fs: FirebaseFirestore.Firestore): Promise<void> {
  async function deleteDocWithSubcoll(path: string, subcollections: string[]): Promise<void> {
    for (const sub of subcollections) {
      const snap = await fs.collection(`${path}/${sub}`).get();
      for (const d of snap.docs) await d.ref.delete();
    }
    await fs.doc(path).delete();
  }

  await deleteDocWithSubcoll(`pedidos/${PEDIDO_ID}`, ['nfev4', 'pagamentos']);
  await fs.doc(`clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`).delete();
  await fs.doc(`clientes/${CLIENTE_ID}`).delete();
  await fs.doc(`operacao/${OPERACAO_ID}`).delete();
  await deleteDocWithSubcoll(`filiais/${FILIAL_ID}`, ['nfeconfig', 'enviNfe']);
  await fs.doc(`integracao/${INTEGRACAO_ID}`).delete();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeOrSkip('orchestrator — SEFAZ-SP homologação EPEC contingência', () => {
  let fs: FirebaseFirestore.Firestore;
  let rt: NFeBaseRuntime;

  beforeAll(async () => {
    if (!hasFullCreds) {
      throw new Error(
        'Live EPEC homologação test requires real credentials. Missing one of: ' +
          'NFE_CERT_PATH|NFE_CERT_BASE64 + NFE_CERT_PASSWORD, NFE_TEST_IE, ' +
          'FIREBASE_PROJECT_ID + FIREBASE_SERVICE_ACCOUNT(_PATH). ' +
          'Refusing to skip a fiscal live lane silently.',
      );
    }
    const cert = loadCertificateFromEnv();
    fs = getAdminFirestore();
    await seedFixtures(fs, cert.cnpj, TEST_IE!);
    __resetNFeRuntimeForTests();
    rt = getNFeRuntime();
  }, 60_000);

  afterAll(async () => {
    if (fs) await cleanupFixtures(fs);
  }, 30_000);

  it('enviarEpecParaNota — EPEC evento accepted by the AN (cStat 135/136) → estado=epecAprovado', async () => {
    const result = await emitirPedido(fs, rt, PEDIDO_ID);
    assertNotConsumoIndevido(result, 'epec/send');
    logSefaz('epec send', result);
    expect(['135', '136']).toContain(result.cStat);
    expect(result.estado).toBe(ESTADO_NFE.epecAprovado);
    expect(result.chave).toMatch(/^\d{44}$/);
    // tpEmis digit (position 34) must be '4' — EPEC contingência.
    expect(result.chave[34]).toBe('4');
  }, 90_000);

  it('transmitirPosEpec — full NF-e reaches the home SEFAZ (100/150 aprovada, or 468 pending retry)', async () => {
    // Throttle so the AN round-trip above and this home-SEFAZ round-trip
    // don't stack into SEFAZ-SP's cStat=656 window.
    await new Promise((r) => setTimeout(r, 1000));

    // Re-calling emitirPedido on the SAME pedido (contingência still
    // 'epec' in config) resolves the same s4 doc, finds it epecAprovado,
    // and the emit cycle itself routes into transmitirPosEpec — the exact
    // path a real operator retry (or the reconcile sweep) takes.
    const result = await emitirPedido(fs, rt, PEDIDO_ID);
    assertNotConsumoIndevido(result, 'epec/pos-transmit');
    logSefaz('epec pós-transmissão', result);
    expect(['100', '150', '468']).toContain(result.cStat);
    if (result.cStat === '468') {
      // Home SEFAZ hasn't received the EPEC from the AN yet — expected on
      // a fresh registration; the sweep retries later. Still a pass: the
      // round-trip itself (send + typed 468 handling) is what this proves.
      expect(result.estado).toBe(ESTADO_NFE.epecAprovado);
    } else {
      expect(result.estado).toBe(ESTADO_NFE.aprovada);
    }
  }, 90_000);
});
