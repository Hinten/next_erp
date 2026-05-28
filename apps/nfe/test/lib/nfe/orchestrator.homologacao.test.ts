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
 * SEFAZ-SP HOM persists numeração across runs; per-run starting `nNF` +
 * `idLote` come from the shared `seedNNF()` / `seedIdLote()` helpers in
 * `@delfrance/integrations-nfe`'s test surface — see
 * `packages/integrations/nfe/test/helpers/homologacao-seed.ts` for the
 * collision-avoidance rationale (high-zone + Date.now() offset, ~500M
 * slots) and the explanation of why SEFAZ exposes no "query last nNF
 * used" endpoint.
 *
 * **serie lane**: this test runs on **serie=1**; the library-level
 * duplicidade test at
 * `packages/integrations/nfe/test/operations/emission.homologacao.test.ts`
 * owns serie=2. SEFAZ keys persistence on serie, so the two test paths
 * can never collide at the (CNPJ, serie, tpAmb, tpEmis, nNF) key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESTADO_NFE } from '@delfrance/schemas';
import {
  assertNotConsumoIndevido,
  loadCertificateFromEnv,
  NFeConsumoIndevidoError,
} from '@delfrance/integrations-nfe';

import {
  seedIdLote,
  seedNNF,
} from '@delfrance/integrations-nfe/test-helpers/homologacao-seed';

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
// Falls back to a 12-digit placeholder when NFE_TEST_IE is unset —
// supports the self-signed cert experiment (Phase 2 of the
// `rosy-nibbling-wand` plan) where we probe SEFAZ-SP HOM without an
// IE secret to see whether the response demands one (cStat=209).
const TEST_IE = process.env.NFE_TEST_IE ?? '111111111111';
const hasFullCreds = hasCert && hasFirebase;
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

// 10 fresh pedidos consumed by the parallel-batch test. Named with a
// distinct `PP` infix so the cleanup loop can pick them apart from the
// `PED-{1,3,8}` ids the single-pedido + reused-batch tests use.
const PARALLEL_PEDIDO_IDS: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `${FIXTURE_PREFIX}-PED-PP${i + 1}`,
);

// Starting nNF + idLote come from the shared homologação seed helpers.
// SEFAZ exposes no endpoint to query last-used nNF for a (CNPJ, serie,
// tpAmb, tpEmis) tuple, so collision-avoidance across CI runs is fully
// client-side. The helpers seed into a high "test zone" (~500M slots)
// to keep the birthday-paradox probability negligible at any plausible
// CI cadence. See the helper module for full rationale.
const SEED_NNF_START = seedNNF();
const SEED_IDLOTE_START = seedIdLote();

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

  // 10 fresh pedidos for the parallel-batch test. Each carries `imposto`
  // pre-stamped so the orchestrator's parallel `nextNumeracao` path is
  // not gated by the resolver cascade (which the prior test already
  // covers in isolation).
  for (let i = 0; i < PARALLEL_PEDIDO_IDS.length; i++) {
    const pedidoId = PARALLEL_PEDIDO_IDS[i]!;
    const valor = 200 + i;
    await fs
      .collection('pedidos')
      .doc(pedidoId)
      .set(pedidoDoc(pedidoId, valor));
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

  for (const pedidoId of [PED1, PED3, PED8, ...PARALLEL_PEDIDO_IDS]) {
    await deleteDocWithSubcoll(`pedidos/${pedidoId}`, ['nfev4', 'pagamento']);
  }
  await deleteDocWithSubcoll(`operacao/${OPERACAO_ID}`, ['regraimposto']);
  await fs.doc(`clientes/${CLIENTE_ID}/enderecos/${ENDERECO_ID}`).delete();
  await fs.doc(`clientes/${CLIENTE_ID}`).delete();
  await deleteDocWithSubcoll(`filiais/${FILIAL_ID}`, ['nfeconfig', 'enviNfe']);
}

// ---------------------------------------------------------------------------
// Consumo Indevido Shield — batch helper
// ---------------------------------------------------------------------------

/**
 * Walk a `BatchEmitResult.results` array and fire the shield for any
 * entry that surfaces cStat=656 — either directly on a successful
 * `EmitResult` or indirectly inside an `EmitError.errorMessage`.
 * The orchestrator wraps SEFAZ rejections in typed error classes; the
 * raw cStat may not be on the top-level union member, so we scan the
 * message as a fallback.
 */
function shieldBatch(
  results: ReadonlyArray<{
    pedidoId: string;
    cStat?: string;
    xMotivo?: string;
    errorCode?: string;
    errorMessage?: string;
  }>,
  source: string,
): void {
  for (const r of results) {
    if (r.cStat != null && r.xMotivo != null) {
      assertNotConsumoIndevido(
        { cStat: r.cStat, xMotivo: r.xMotivo },
        `${source}/pedido=${r.pedidoId}`,
      );
      continue;
    }
    const msg = r.errorMessage;
    if (
      msg != null &&
      (msg.includes('656') || msg.toLowerCase().includes('consumo indevido'))
    ) {
      throw new NFeConsumoIndevidoError({
        cStat: '656',
        xMotivo: msg,
        source: `${source}/pedido=${r.pedidoId}/${r.errorCode ?? 'unknown'}`,
      });
    }
  }
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
    await seedFixtures(fs, cert.cnpj, TEST_IE);
    __resetNFeRuntimeForTests();
    rt = getNFeRuntime();
    // SEFAZ status pre-flight intentionally removed — the ci-nfe.yml
    // "SEFAZ-SP HOM status gate" step runs operations.homologacao
    // immediately before this suite and short-circuits the whole job
    // on cStat ≠ 107/108/109, so re-pinging the status endpoint here
    // would just feed the 656 throttle for no extra signal.
  }, 60_000);

  afterAll(async () => {
    if (fs) await cleanupFixtures(fs);
  }, 30_000);

  it('emitirPedido single happy path — PED-1 with imposto stamped → cStat=100', async () => {
    const result = await emitirPedido(fs, rt, PED1);
    assertNotConsumoIndevido(result, 'single-happy/PED-1');
    expect(result.cStat).toBe('100');
    expect(result.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.chave).toMatch(/^\d{44}$/);
    expect(result.reused).toBe(false);
  }, 90_000);

  it('emitirPedido resolver-via-regra — PED-8 lacks item.imposto, regraImposto fills it → cStat=100', async () => {
    const result = await emitirPedido(fs, rt, PED8);
    assertNotConsumoIndevido(result, 'resolver-via-regra/PED-8');
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
      shieldBatch(batch.results, 'batch-of-3-jaAprovadas');
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

  it(
    'emitirPedidosLote × 10 parallel — unique consecutive nNFs, all aprovadas',
    async () => {
      // Throttle before a 10-emission batch so the prior 3 tests'
      // round-trips don't push us into SEFAZ's cStat=656 ("Consumo
      // Indevido") window.
      await new Promise((r) => setTimeout(r, 1000));

      // Snapshot numeracao_atual + idLote BEFORE the batch so we can
      // assert the orchestrator's parallel `nextNumeracao` path produced
      // exactly 10 consecutive allocations and exactly 1 idLote bump.
      const cfgBefore = (
        await fs.doc(`filiais/${FILIAL_ID}/nfeconfig/default`).get()
      ).data() as { numeracao_atual: number; idLote: number };

      const batch = await emitirPedidosLote(fs, rt, PARALLEL_PEDIDO_IDS);
      shieldBatch(batch.results, 'batch-parallel-10');

      // Outcome shape — every pedido aprovada, all fresh.
      expect(batch.results).toHaveLength(10);
      for (const r of batch.results) {
        expect('estado' in r).toBe(true);
        if ('estado' in r) {
          expect(r.estado).toBe(ESTADO_NFE.aprovada);
          expect(r.reused).toBe(false);
          expect(r.chave).toMatch(/^\d{44}$/);
        }
      }

      // nNF extraction — positions 25..34 (9-digit nNF field inside the
      // 44-digit chave). All 10 must be distinct AND form a consecutive
      // run starting at `cfgBefore.numeracao_atual + 1`.
      const nNFs: number[] = [];
      for (const r of batch.results) {
        if ('chave' in r) nNFs.push(Number(r.chave.substring(25, 34)));
      }
      nNFs.sort((a, b) => a - b);
      expect(new Set(nNFs).size).toBe(10);
      expect(nNFs[0]).toBe(cfgBefore.numeracao_atual + 1);
      expect(nNFs[9]).toBe(cfgBefore.numeracao_atual + 10);
      expect(nNFs).toEqual(
        Array.from({ length: 10 }, (_, i) => cfgBefore.numeracao_atual + 1 + i),
      );

      // Persisted counter state — numeracao_atual advanced by exactly 10
      // (one per pedido); idLote advanced by exactly 1 (one chunk = one
      // shared lote, regardless of pedido count).
      const cfgAfter = (
        await fs.doc(`filiais/${FILIAL_ID}/nfeconfig/default`).get()
      ).data() as { numeracao_atual: number; idLote: number };
      expect(cfgAfter.numeracao_atual).toBe(cfgBefore.numeracao_atual + 10);
      expect(cfgAfter.idLote).toBe(cfgBefore.idLote + 1);
    },
    180_000,
  );
});
