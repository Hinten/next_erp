/**
 * Mock-data seeding for the TableView/ObjectView e2e suites. Writes docs
 * straight to Firestore via the Admin SDK (bypassing rules), then sweeps
 * them out by `nome` prefix afterwards.
 *
 * Every test doc — seeded here OR created through the UI during a test —
 * has its `nome` start with the run-scoped prefix from `e2ePrefix()`, so a
 * single prefix sweep cleans the whole suite without tracking ids.
 */
import { millisToMicros } from '@delfrance/core/datetime';
import { db } from '@delfrance/test-fixtures';
import { getRunId } from './run-id';

/** High Unicode code point — upper bound for a Firestore prefix range query. */
const PREFIX_MAX = String.fromCharCode(0xffff);

/**
 * Run-scoped, tag-scoped `nome` prefix. The run id keeps parallel CI runs
 * from clobbering each other; the tag separates suites (cli / cat).
 */
export function e2ePrefix(tag: string): string {
  return `e2e-${getRunId()}-${tag}`;
}

const pad = (n: number): string => String(n).padStart(3, '0');

/**
 * Checksum-valid CPF derived from a sequence number — `clienteSchema` now
 * validates CPF/CNPJ check digits, so editing a seeded row through
 * ObjectView would fail with an arbitrary 11-digit string. Mirrors the
 * mod-11 algorithm in `@delfrance/core/documents`.
 */
export function validTestCpf(i: number): string {
  const base = String(100000000 + i); // 9 digits
  const dv = (digits: string): number => {
    let sum = 0;
    for (let k = 0; k < digits.length; k += 1) {
      sum += Number(digits[k]) * (digits.length + 1 - k);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const dv1 = dv(base);
  const dv2 = dv(`${base}${dv1}`);
  return `${base}${dv1}${dv2}`;
}

/**
 * Last `n` digits derived from the run id. Identity values the quick-create
 * dedup queries see (CPF/CNPJ, telefone) must be unique per run: the staging
 * `clientes` collection is shared across runs — isolation is by `nome`
 * prefix only — and also holds long-lived dev seeds, so a fixed document
 * number would trip the modal's blocking dedup. Pads with '7' when the run
 * id has too few digits (the local base36 fallback).
 */
export function runDigits(n: number): string {
  const digits = getRunId().replace(/\D/g, '') || String(Date.now());
  return digits.padStart(n, '7').slice(-n);
}

/**
 * Checksum-valid CNPJ derived from a digit string — same rationale as
 * `validTestCpf`, with the CNPJ mod-11 weight vectors.
 */
export function validTestCnpj(seedDigits: string): string {
  const base = seedDigits.replace(/\D/g, '').padStart(12, '7').slice(-12);
  const dv = (digits: string, weights: number[]): number => {
    let sum = 0;
    for (let k = 0; k < weights.length; k += 1) {
      sum += Number(digits[k]) * weights[k]!;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const dv1Weights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv1 = dv(base, dv1Weights);
  const dv2 = dv(`${base}${dv1}`, [6, ...dv1Weights]);
  return `${base}${dv1}${dv2}`;
}

/**
 * Seed `n` cliente docs. `nome` = `<prefix>-NNN`; `tipo`, `cpf_cnpj` and
 * `email` are varied so filter/sort tests have something to bite on.
 */
export async function seedClientes(prefix: string, n: number): Promise<void> {
  const tipos = ['0', '1', '2'] as const;
  const col = db().collection('clientes');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      tipo: tipos[i % tipos.length],
      nome: `${prefix}-${pad(i)}`,
      cpf_cnpj: validTestCpf(i),
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: i % 2 === 0 ? `${prefix}-${pad(i)}@example.com` : null,
      telefone: null,
      observacoesInternas: null,
      timestamp: Date.now(),
      nome_embedding: null,
      telefone_embedding: null,
      userCliente: null,
    });
  }
  await batch.commit();
}

/**
 * Seed `n` categoria docs. `permiteCadastro` alternates so the boolean
 * column filter has both states.
 */
export async function seedCategorias(prefix: string, n: number): Promise<void> {
  const col = db().collection('categorias');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      nomeCompleto: i % 2 === 0 ? `${prefix}-${pad(i)} completo` : null,
      permiteCadastro: i % 2 === 0,
      categoriaGoogleId: null,
      categoriaPaiOuterRef: null,
      timestamp: Date.now(),
    });
  }
  await batch.commit();
}

/**
 * Seed `n` deposito docs. `ativo` alternates so the boolean column filter
 * has both states to bite on.
 */
export async function seedDepositos(prefix: string, n: number): Promise<void> {
  const col = db().collection('depositos');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      ativo: i % 2 === 0,
      timestamp: Date.now(),
    });
  }
  await batch.commit();
}

/**
 * Seed exactly one ACTIVE deposito (`<prefix>-dep`, `ativo: true`) and return
 * its id + nome. The Estoque tab lists active depósitos ordered by `nome`
 * (bounded), so the seeded one shows as long as the shared collection stays
 * under that cap. `timestamp` is stamped only for parity with the other deposito
 * seeds (it does not affect the name-ordered list).
 */
export async function seedDepositoAtivo(prefix: string): Promise<{ id: string; nome: string }> {
  const id = `${prefix}-dep`;
  const nome = `${prefix}-dep`;
  await db().collection('depositos').doc(id).set({ nome, ativo: true, timestamp: Date.now() });
  return { id, nome };
}

/**
 * Seed one ACTIVE + padrão Operação (`<prefix>-op`) — the Impostos tab lists
 * active operações and the produto imposto is scoped per operação. Full wire
 * shape so `operacaoCollection`'s converter parses it on read.
 */
export async function seedOperacaoAtiva(prefix: string): Promise<{ id: string; nome: string }> {
  const id = `${prefix}-op`;
  const nome = `${prefix}-op`;
  await db().collection('operacao').doc(id).set({
    nome,
    naturezaDaOperacao: 'Venda',
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
    indIntermed: '1',
    cfop: '5102',
    cfopInterestadual: '6102',
    origem: '0',
    NCM: null,
    CEST: null,
    unidade: 'UN',
    estadosDestino: null,
    estados: null,
    configuracaoICMS: null,
    configuracaoIPI: null,
    configuracaoPIS: null,
    configuracaoPISST: null,
    infCpl: null,
    timestamp: Date.now(),
  });
  return { id, nome };
}

/**
 * Seed `n` motivoIncidente docs. `ativo` alternates for the boolean filter.
 */
export async function seedMotivosIncidente(prefix: string, n: number): Promise<void> {
  const col = db().collection('motivosincidentes');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      ativo: i % 2 === 0,
    });
  }
  await batch.commit();
}

/**
 * Seed `n` bandeiraCartao docs. `bandeira` cycles through Visa/Mastercard/Elo
 * and `ehCredito` alternates, so the enum + boolean column filters have
 * something to bite on.
 */
export async function seedBandeirasCartao(prefix: string, n: number): Promise<void> {
  const bandeiras = ['01', '02', '06'] as const; // Visa, Mastercard, Elo
  const col = db().collection('bandeirasCartao');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      ehCredito: i % 2 === 0,
      nome: `${prefix}-${pad(i)}`,
      cnpj_instituicao: null,
      bandeira: bandeiras[i % bandeiras.length],
      tarifa: 0,
      tarifaFixa: 0,
      maxParcelas: 1 + (i % 12),
      prazoRecebimento: 0,
      dataCadastro: Date.now(),
      ultimaModificacao: Date.now(),
    });
  }
  await batch.commit();
}

/**
 * Seed `n` filial docs. `razaoSocial` = `<prefix>-NNN`; `fantasia` alternates
 * null/string and the embedded `sede` carries a valid São Paulo address so
 * the nested-object ObjectView fieldset round-trips.
 */
export async function seedFiliais(prefix: string, n: number): Promise<void> {
  const col = db().collection('filiais');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      razaoSocial: `${prefix}-${pad(i)}`,
      fantasia: i % 2 === 0 ? `${prefix}-${pad(i)} fantasia` : null,
      cnae: null,
      cnpj: String(10000000000000 + i),
      ie: String(100000000 + i),
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        logradouro: 'Av. Teste',
        numero: String(i),
        bairro: 'Centro',
        complemento: null,
        cep: '01310100',
        codigoMunicipio: null,
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: null,
        pais: null,
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
  }
  await batch.commit();
}

/**
 * Seed a small fixture set for the Balcão (canais/balcao) suite: one filial,
 * one listaDePrecos, one deposito (each named `<prefix>-ref`), then `n`
 * Integracao docs with `tipo = 7` (balcao) referencing them via real
 * `DocumentReference`s. The returned ids let tests pick the same docs in the
 * `<CollectionSelect>` dropdowns during the create flow.
 */
export async function seedBalcaoFixtures(
  prefix: string,
  n: number,
): Promise<{ filialId: string; listaId: string; depositoId: string }> {
  const filialId = `${prefix}-ref-filial`;
  const listaId = `${prefix}-ref-lista`;
  const depositoId = `${prefix}-ref-deposito`;
  // filial / listaDePrecos / deposito / integracao below are all numeric-epoch
  // (ms) now — one Date.now() feeds them all.
  const now = Date.now();

  await db()
    .collection('filiais')
    .doc(filialId)
    .set({
      razaoSocial: `${prefix}-ref-filial`,
      fantasia: null,
      cnae: null,
      cnpj: '99999999999999',
      ie: '999999999',
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        logradouro: 'Av. Teste',
        numero: '1',
        bairro: 'Centro',
        complemento: null,
        cep: '01310100',
        codigoMunicipio: null,
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: null,
        pais: null,
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
      timestamp: now,
    });

  await db()
    .collection('listaDePrecos')
    .doc(listaId)
    .set({
      nome: `${prefix}-ref-lista`,
      padrao: false,
      ativo: true,
      formulasCalculoPreco: null,
      formulasPorCategoria: null,
      timestamp: now,
      ultimaModificacao: now,
    });

  await db()
    .collection('depositos')
    .doc(depositoId)
    .set({
      nome: `${prefix}-ref-deposito`,
      ativo: true,
      timestamp: now,
    });

  const filialRef = db().collection('filiais').doc(filialId);
  const listaRef = db().collection('listaDePrecos').doc(listaId);
  const depositoRef = db().collection('depositos').doc(depositoId);

  const batch = db().batch();
  const col = db().collection('integracao');
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      tipo: 7,
      padrao: i === 1,
      nome: `${prefix}-${pad(i)}`,
      cpf_cnpj: null,
      idCadIntTran: null,
      ativo: i % 2 === 1,
      cor: null,
      modalidadeFreteImportacao: null,
      filialIntegracaoPedidoOuterRef: filialRef,
      tabelaNormalOuterRef: listaRef,
      tabelaPromocionalOuterRef: null,
      operacaoOuterRef: null,
      operacaoDevolucaoOuterRef: null,
      depositoOuterRef: depositoRef,
      dataCadastro: now,
    });
  }
  await batch.commit();

  return { filialId, listaId, depositoId };
}

/**
 * Teardown for `seedBalcaoFixtures`: sweeps the seeded Integracao + fixture
 * filial/listaDePrecos/deposito docs, including any UI-created Integracao
 * row sharing the run-scoped prefix.
 */
export async function cleanupBalcaoFixtures(prefix: string): Promise<void> {
  await Promise.all([
    cleanupByNamePrefix('integracao', prefix),
    cleanupByFieldPrefix('filiais', 'razaoSocial', prefix),
    cleanupByNamePrefix('listaDePrecos', prefix),
    cleanupByNamePrefix('depositos', prefix),
  ]);
}

/**
 * Seed fixtures for the `/logistica/*` suite: one filial (named
 * `<prefix>-ref-filial`) plus `n` Motoboy docs and one Retirada doc in the
 * tipo-discriminated `int_frete` collection. The docs use the **Flutter wire
 * shapes** F1 pinned: `filialIntegracaoFreteOuterRef` is a doc-path STRING
 * (`documents/filiais/<id>`, not a DocumentReference), `dataCadastro` is a
 * required ms-epoch int, and omit-tolerant fields are explicit null.
 */
export async function seedIntFreteFixtures(
  prefix: string,
  n: number,
): Promise<{ filialId: string }> {
  const filialId = `${prefix}-ref-filial`;
  const now = new Date().toISOString();

  await db()
    .collection('filiais')
    .doc(filialId)
    .set({
      razaoSocial: `${prefix}-ref-filial`,
      fantasia: null,
      cnae: null,
      cnpj: '99999999999999',
      ie: '999999999',
      iest: null,
      imun: null,
      sede: {
        idExterno: null,
        logradouro: 'Av. Teste',
        numero: '1',
        bairro: 'Centro',
        complemento: null,
        cep: '01310100',
        codigoMunicipio: null,
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: null,
        pais: null,
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
      timestamp: now,
    });

  const batch = db().batch();
  const col = db().collection('int_frete');
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      tipo: 'motoboy',
      nome: `${prefix}-${pad(i)}`,
      ativo: i % 2 === 1,
      filialIntegracaoFreteOuterRef: `documents/filiais/${filialId}`,
      enderecoDeOrigem: null,
      dataCadastro: Date.now(),
      mapa: null,
      faixaCep: [
        { cepInicial: '01000000', cepFinal: '01999999', custo: 15, valor: 20, prazo: 1 },
        { cepInicial: '02000000', cepFinal: '02999999', custo: 18.5, valor: 25, prazo: 2 },
      ],
      horarioDeCorte: [
        {
          diaDaSemana: 1,
          horaDeCorte: 16,
          minutosDeCorte: 30,
          prazoDePostagem: 0,
          horaPostagem: 18,
          minutosPostagem: 0,
        },
      ],
      prazoExtra: 0,
      client_id: null,
      client_secret: null,
    });
  }
  batch.set(col.doc(`${prefix}-ret-001`), {
    tipo: 'retiradaNaLoja',
    nome: `${prefix}-ret-001`,
    ativo: true,
    filialIntegracaoFreteOuterRef: `documents/filiais/${filialId}`,
    enderecoDeOrigem: null,
    dataCadastro: Date.now(),
    mapa: null,
    faixaCep: null,
    horarioDeCorte: null,
    prazoExtra: 2,
    client_id: null,
    client_secret: null,
  });
  await batch.commit();

  return { filialId };
}

/** Teardown for `seedIntFreteFixtures` (incl. UI-created docs on the prefix). */
export async function cleanupIntFreteFixtures(prefix: string): Promise<void> {
  await Promise.all([
    cleanupByNamePrefix('int_frete', prefix),
    cleanupByFieldPrefix('filiais', 'razaoSocial', prefix),
  ]);
}

/** Full data of the first `int_frete` doc named `nome`, or null. */
export async function getIntFreteByName(nome: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('int_frete').where('nome', '==', nome).limit(1).get();
  const data = snap.docs[0]?.data();
  return data ? (data as Record<string, unknown>) : null;
}

/** First cliente doc whose `nome` equals `nome` (null = not found). */
export async function getClienteByName(nome: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('clientes').where('nome', '==', nome).limit(1).get();
  const data = snap.docs[0]?.data();
  return data ? (data as Record<string, unknown>) : null;
}

/** Length of `faixaCep` on the `int_frete` doc named `nome` (-1 = no array/doc). */
export async function intFreteFaixaCount(nome: string): Promise<number> {
  const data = await getIntFreteByName(nome);
  const faixas = data?.faixaCep;
  return Array.isArray(faixas) ? faixas.length : -1;
}

/**
 * Seed minimal fixtures the `/pedidos/novo` e2e flow needs:
 *  - 1 cliente,
 *  - 1 operação (saída, tipo=1),
 *  - 1 integração,
 *  - 1 produto with a SKU.
 *
 * Returns the seeded paths so the spec can build outer refs without
 * hitting the UI search.
 */
export async function seedPedidoFixtures(prefix: string): Promise<{
  clientePath: string;
  operacaoPath: string;
  integracaoPath: string;
  produtoPath: string;
  clienteNome: string;
  clienteCpfCnpj: string;
  operacaoNome: string;
  integracaoNome: string;
  produtoNome: string;
  produtoSku: string;
}> {
  const clienteId = `${prefix}-cli-001`;
  const operacaoId = `${prefix}-op-001`;
  const integracaoId = `${prefix}-int-001`;
  const produtoId = `${prefix}-pro-001`;
  const clienteNome = `${prefix}-cli-001`;
  // Run-unique valid CNPJ: the quick-create dedup spec fills it expecting
  // exactly ONE blocking candidate (this fixture) in the shared collection.
  const clienteCpfCnpj = validTestCnpj(runDigits(12));
  const operacaoNome = `${prefix}-op-001`;
  const integracaoNome = `${prefix}-int-001`;
  const produtoNome = `${prefix}-pro-001`;
  const produtoSku = `${prefix.toUpperCase().replace(/-/g, '_')}_SKU_001`;

  const batch = db().batch();
  batch.set(db().collection('clientes').doc(clienteId), {
    tipo: '1',
    nome: clienteNome,
    cpf_cnpj: clienteCpfCnpj,
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: null,
    telefone: null,
    observacoesInternas: null,
    timestamp: Date.now(),
    nome_embedding: null,
    telefone_embedding: null,
    userCliente: null,
  });
  batch.set(db().collection('operacao').doc(operacaoId), {
    nome: operacaoNome,
    naturezaDaOperacao: 'Venda',
    tipo: 1,
    ehServico: false,
    ehExterior: false,
    ehConsumidorFinal: true,
    padrao: false,
    ativo: true,
    movimentaEstoque: true,
    movimentaIndisponivelEstoque: true,
    ehFiscal: true,
    finNFe: 1,
    indPres: '2',
    indIntermed: '1',
    cfop: '5102',
    cfopInterestadual: '6102',
    origem: '0',
    NCM: null,
    CEST: null,
    unidade: 'UN',
    estadosDestino: null,
    estados: null,
    configuracaoICMS: null,
    configuracaoIPI: null,
    configuracaoPIS: null,
    configuracaoPISST: null,
    infCpl: null,
    timestamp: Date.now(),
  });
  batch.set(db().collection('integracao').doc(integracaoId), {
    tipo: 7, // balcao
    padrao: false,
    nome: integracaoNome,
    cpf_cnpj: null,
    idCadIntTran: null,
    ativo: true,
    cor: null,
    modalidadeFreteImportacao: null,
    filialIntegracaoPedidoOuterRef: null,
    tabelaNormalOuterRef: null,
    tabelaPromocionalOuterRef: null,
    operacaoOuterRef: null,
    operacaoDevolucaoOuterRef: null,
    depositoOuterRef: null,
    dataCadastro: Date.now(),
  });
  batch.set(db().collection('produtos').doc(produtoId), {
    nome: produtoNome,
    sku: produtoSku,
    codPai: null,
    paiId: null,
    ordem: null,
    gtin: null,
    codFornecedor: null,
    categoriaProdutoOuterRef: null,
    pesoLiquidoKg: null,
    pesoBrutoKg: null,
    alturaCm: null,
    larguraCm: null,
    profundidadeCm: null,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    crossdocking: null,
    grupoDeVariacoesUid: null,
    variacoesUid: null,
    componentesKitKeys: null,
    componentesKit: null,
    integracoesComProduto: [],
    marketplaceIds: null,
    marketplace: [],
    statusProdutosMarketplace: null,
    fotos: null,
    videos: null,
    anexos: null,
    fotosArquivosIds: null,
    nome_embedding: null,
  });
  await batch.commit();

  return {
    clientePath: `clientes/${clienteId}`,
    operacaoPath: `operacao/${operacaoId}`,
    integracaoPath: `integracao/${integracaoId}`,
    produtoPath: `produtos/${produtoId}`,
    clienteNome,
    clienteCpfCnpj,
    operacaoNome,
    integracaoNome,
    produtoNome,
    produtoSku,
  };
}

/**
 * Clean up every test pedido whose `numero` starts with `prefix` and
 * every fixture document whose `nome` starts with `prefix`.
 */
export async function cleanupPedidoFixtures(prefix: string): Promise<void> {
  await Promise.all([
    cleanupByFieldPrefix('pedidos', 'numero', prefix),
    cleanupByNamePrefix('clientes', prefix),
    cleanupByNamePrefix('operacao', prefix),
    cleanupByNamePrefix('integracao', prefix),
    cleanupByNamePrefix('produtos', prefix),
  ]);
}

/**
 * Fixtures for the pedido **Frete tab** suite: everything
 * `seedPedidoFixtures` provides plus
 *   - one endereço under the cliente (CEP inside the motoboy faixa below);
 *   - a Retirada na Loja and a Motoboy `int_frete` doc (Flutter wire shape —
 *     string `documents/...` refs, ms-epoch `dataCadastro`), both with a
 *     7-day cut-off schedule so `getPrazoDespacho` always resolves;
 *   - a marketplace-managed pedido (`<prefix>-mkt-001`) whose `freteInicial`
 *     points at a Mercado Livre integração, for the read-only rendering.
 */
export async function seedPedidoFreteFixtures(prefix: string): Promise<{
  base: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  clienteId: string;
  enderecoPath: string;
  retiradaId: string;
  retiradaNome: string;
  motoboyId: string;
  motoboyNome: string;
  mktPedidoId: string;
}> {
  const base = await seedPedidoFixtures(prefix);
  const clienteId = `${prefix}-cli-001`;
  const enderecoId = `${prefix}-end-001`;
  const retiradaId = `${prefix}-fr-ret`;
  const retiradaNome = `${prefix}-frete-retirada`;
  const motoboyId = `${prefix}-fr-mot`;
  const motoboyNome = `${prefix}-frete-motoboy`;
  const mlIntId = `${prefix}-fr-ml`;
  const mktPedidoId = `${prefix}-mkt-001`;

  // Cut-off at 23:59 every weekday: the inclusive same-day check always
  // passes, so the autofilled prazoDespacho is deterministic (today 18:00).
  const horarioDeCorte = [1, 2, 3, 4, 5, 6, 7].map((diaDaSemana) => ({
    diaDaSemana,
    horaDeCorte: 23,
    minutosDeCorte: 59,
    prazoDePostagem: 0,
    horaPostagem: 18,
    minutosPostagem: 0,
  }));

  const intFreteBase = {
    ativo: true,
    filialIntegracaoFreteOuterRef: `documents/filiais/${prefix}-fil-001`,
    enderecoDeOrigem: null,
    dataCadastro: Date.now(),
    mapa: null,
    horarioDeCorte,
    prazoExtra: 0,
    client_id: null,
    client_secret: null,
  };

  const batch = db().batch();
  batch.set(db().collection('clientes').doc(clienteId).collection('enderecos').doc(enderecoId), {
    idExterno: null,
    logradouro: 'Av Paulista',
    numero: '1000',
    bairro: 'Bela Vista',
    complemento: null,
    cep: '01310100',
    codigoMunicipio: null,
    cidade: 'São Paulo',
    estado: 'SP',
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
  });
  batch.set(db().collection('int_frete').doc(retiradaId), {
    ...intFreteBase,
    tipo: 'retiradaNaLoja',
    nome: retiradaNome,
    faixaCep: null,
  });
  batch.set(db().collection('int_frete').doc(motoboyId), {
    ...intFreteBase,
    tipo: 'motoboy',
    nome: motoboyNome,
    faixaCep: [{ cepInicial: '01000000', cepFinal: '01999999', custo: 15, valor: 20, prazo: 1 }],
  });
  batch.set(db().collection('int_frete').doc(mlIntId), {
    ...intFreteBase,
    tipo: 'mercadoLivre',
    nome: `${prefix}-frete-ml`,
    faixaCep: null,
  });
  batch.set(db().collection('pedidos').doc(mktPedidoId), {
    ehSaida: true,
    estado: 'pago',
    numero: mktPedidoId,
    itens: {},
    itensIds: [],
    descontoTotal: 0,
    timestamp: millisToMicros(Date.now()),
    freteInicial: {
      externalId: 'ML-0001',
      externalOptionId: 'ml-opt-1',
      externalOptionIntegracao: 'mercadoLivre',
      externalOptionData: { shipment_id: 'SHP-123' },
      estado: 'postado',
      integracaoFreteOuterRef: `documents/int_frete/${mlIntId}`,
      modalidade: '0',
      codRastreio: 'BR123456789ML',
      valorCobrado: 25.9,
      custoCalculado: null,
      custoFinal: null,
      ehReverso: false,
      prazoExtra: 0,
      prazoDespacho: null,
      dataEntrega: null,
      dataPrevisaoEntrega: null,
      valor_assegurado: null,
      transportadora: null,
      veiculo: null,
      reboques: null,
      vagao: null,
      balsa: null,
      volumes: null,
      integracao_path: null,
      clienteRecebedorOuterReference: null,
      enderecoFreteOuterReference: null,
      ultimaModificacao: null,
    },
  });
  await batch.commit();

  return {
    base,
    clienteId,
    enderecoPath: `clientes/${clienteId}/enderecos/${enderecoId}`,
    retiradaId,
    retiradaNome,
    motoboyId,
    motoboyNome,
    mktPedidoId,
  };
}

/** Teardown for `seedPedidoFreteFixtures`. */
export async function cleanupPedidoFreteFixtures(prefix: string): Promise<void> {
  await cleanupEnderecos(`${prefix}-cli-001`);
  await Promise.all([cleanupPedidoFixtures(prefix), cleanupByNamePrefix('int_frete', prefix)]);
}

/**
 * Seed a pedido (with `numero = <prefix>-NNN`) plus one NFe doc in its
 * `nfev4` subcollection at the requested estado. Returns the pair of ids so
 * the test can mutate the NFe mid-run via `db().collection(...)...update(...)`.
 *
 * The NFe `timestamp` (ms since epoch) is what `NFCell`'s query orders by;
 * the helper stamps `Date.now()` so the seeded doc is the most-recent NFe.
 */
export async function seedPedidoWithNFe(
  prefix: string,
  index: number,
  estado: string,
): Promise<{ pedidoId: string; nfeId: string }> {
  const pedidoId = `${prefix}-${pad(index)}`;
  const nfeId = `${prefix}-${pad(index)}-nfe`;
  const now = Date.now();
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .set({
      ehSaida: true,
      estado: 'pago',
      numero: pedidoId,
      itens: {},
      itensIds: [],
      descontoTotal: 0,
      timestamp: millisToMicros(now),
      ultimaModificacao: millisToMicros(now),
      foiImpresso: false,
      // The TableView's NF column reads `pedido.id`, not these inner refs;
      // outer refs stay null so the cell exercises the snapshot path
      // without dragging a cliente lookup into the assertion.
      vendedorPedidoOuterRef: null,
      integracaoPedidoOuterRef: null,
      operacaoPedidoOuterRef: null,
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
      listaDePrecosOuterRef: null,
    });
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(nfeId)
    .set({
      numeracao: 1,
      serie: 1,
      tpEmis: 1,
      estado,
      chave: null,
      idLote: null,
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: null,
      nRec: null,
      retries: null,
      cStat: null,
      xMotivo: null,
      error: null,
      timestamp: now,
      ultima_modificacao: new Date(now).toISOString(),
    });
  return { pedidoId, nfeId };
}

/**
 * Clean up a pedido seeded by `seedPedidoWithNFe` together with the NFe
 * docs in its `nfev4` subcollection. Subcollections are not cascaded by
 * the Firestore SDK; we delete them explicitly.
 */
export async function cleanupPedidoWithNFe(pedidoId: string): Promise<void> {
  const nfeSnap = await db().collection('pedidos').doc(pedidoId).collection('nfev4').get();
  if (!nfeSnap.empty) {
    const batch = db().batch();
    nfeSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await db().collection('pedidos').doc(pedidoId).delete();
}

/**
 * Seed two variation groups for the produto-variações suite — Tamanhos
 * (P/M/G, ordem 1) and Cores (Azul/Verde, ordem 2, `permiteFotos`). Names are
 * prefix-scoped for the sweep; variant ids are fixed so the spec can assert
 * generated fake paths deterministically.
 */
export async function seedGruposDeVariacao(prefix: string): Promise<{
  tamanhosId: string;
  coresId: string;
}> {
  const col = db().collection('grupoDeVariacoes');
  const batch = db().batch();
  const now = new Date().toISOString();
  const tamanhosId = `${prefix}-tam`;
  const coresId = `${prefix}-cor`;
  batch.set(col.doc(tamanhosId), {
    nome: `${prefix}-Tamanhos`,
    codigo: 'tam',
    ordem: 1,
    tipo: 1,
    permiteFotos: false,
    variacoesIds: ['p', 'm', 'g'],
    variacoes: [
      { id: 'p', nome: 'P', codigo: 'P', timestamp: now },
      { id: 'm', nome: 'M', codigo: 'M', timestamp: now },
      { id: 'g', nome: 'G', codigo: 'G', timestamp: now },
    ],
    timestamp: now,
  });
  batch.set(col.doc(coresId), {
    nome: `${prefix}-Cores`,
    codigo: 'cor',
    ordem: 2,
    tipo: 2,
    permiteFotos: true,
    variacoesIds: ['az', 'vd'],
    variacoes: [
      { id: 'az', nome: 'Azul', codigo: 'AZ', timestamp: now },
      { id: 'vd', nome: 'Verde', codigo: 'VD', timestamp: now },
    ],
    timestamp: now,
  });
  await batch.commit();
  return { tamanhosId, coresId };
}

/**
 * Seed a parent produto wired to the groups from `seedGruposDeVariacao` —
 * `grupoDeVariacoesUid` (bare ids) + `variacoesUid` (fake paths, group-major:
 * Tamanhos P + Cores Azul/Verde). Gives the per-variant photo sections
 * something to render. Returns the parent id.
 */
export async function seedProdutoComVariacoes(
  prefix: string,
  grupos: { tamanhosId: string; coresId: string },
): Promise<{ produtoId: string }> {
  const produtoId = `${prefix}-pai`;
  const fake = (g: string, v: string) => `documents/grupoDeVariacoes/${g}/variacoes/${v}`;
  await db()
    .collection('produtos')
    .doc(produtoId)
    .set({
      nome: `${prefix}-pai`,
      sku: `${prefix.toUpperCase().replace(/-/g, '_')}_PAI`,
      paiId: null,
      ordem: null,
      grupoDeVariacoesUid: [grupos.tamanhosId, grupos.coresId],
      variacoesUid: [
        fake(grupos.tamanhosId, 'p'),
        fake(grupos.coresId, 'az'),
        fake(grupos.coresId, 'vd'),
      ],
      publicado: true,
      ehKit: false,
      ehKitVirtual: false,
      ofereceFreteGratis: false,
      permiteVendaSemEstoque: false,
      fotos: null,
      videos: null,
      timestamp: new Date().toISOString(),
    });
  return { produtoId };
}

/**
 * Seed a parent produto (`paiId: null`) plus one variation child
 * (`paiId: <parentId>`) — the fixture for the parents-only list filter
 * (#119) and the deletion-integrity flows (#117). Both names are
 * prefix-scoped for the sweep.
 */
export async function seedProdutoComFilho(prefix: string): Promise<{
  parentId: string;
  childId: string;
  parentNome: string;
  childNome: string;
  childSku: string;
}> {
  const parentId = `${prefix}-pai`;
  const childId = `${parentId}-filho`;
  const parentNome = `${prefix}-pai`;
  const childNome = `${prefix}-pai P`;
  const childSku = `${prefix.toUpperCase().replace(/-/g, '_')}_PAI_P`;
  const now = new Date().toISOString();
  const base = {
    publicado: true,
    ehKit: false,
    ehKitVirtual: false,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    fotos: null,
    videos: null,
    timestamp: now,
  };
  const batch = db().batch();
  batch.set(db().collection('produtos').doc(parentId), {
    ...base,
    nome: parentNome,
    sku: `${prefix.toUpperCase().replace(/-/g, '_')}_PAI`,
    paiId: null,
    ordem: null,
  });
  batch.set(db().collection('produtos').doc(childId), {
    ...base,
    nome: childNome,
    sku: childSku,
    paiId: parentId,
    ordem: 0,
  });
  await batch.commit();
  return { parentId, childId, parentNome, childNome, childSku };
}

/**
 * Seed one simple produto to use as a kit COMPONENT (`ehKit: false`) with a known
 * `custo`, so the Kit tab can add it and recompute the kit cost. Returns id/nome/sku.
 */
export async function seedComponenteKit(
  prefix: string,
  custo = 10,
): Promise<{ id: string; nome: string; sku: string }> {
  const id = `${prefix}-comp`;
  const nome = `${prefix}-comp`;
  const sku = `${prefix.toUpperCase().replace(/-/g, '_')}_COMP`;
  await db().collection('produtos').doc(id).set({
    nome,
    sku,
    custo,
    paiId: null,
    ordem: null,
    publicado: true,
    ehKit: false,
    ehKitVirtual: false,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    fotos: null,
    videos: null,
    timestamp: new Date().toISOString(),
  });
  return { id, nome, sku };
}

/**
 * Seed a kit produto whose `componentesKit` references `componentId` — the
 * Flutter wire shape: a map keyed by the component's doc id plus the
 * denormalized `componentesKitKeys` id array the delete guard queries.
 */
export async function seedKitReferencing(
  prefix: string,
  componentId: string,
): Promise<{ kitId: string; kitNome: string }> {
  const kitId = `${prefix}-kit`;
  const kitNome = `${prefix}-kit`;
  await db()
    .collection('produtos')
    .doc(kitId)
    .set({
      nome: kitNome,
      sku: `${prefix.toUpperCase().replace(/-/g, '_')}_KIT`,
      paiId: null,
      ordem: null,
      publicado: true,
      ehKit: true,
      ehKitVirtual: false,
      ofereceFreteGratis: false,
      permiteVendaSemEstoque: false,
      componentesKitKeys: [componentId],
      componentesKit: { [componentId]: { quantidade: 1, limitarEstoque: false } },
      fotos: null,
      videos: null,
      timestamp: new Date().toISOString(),
    });
  return { kitId, kitNome };
}

/**
 * Seed the graph the "Gerar Variações" edit-flow e2e needs:
 *  - a component produto `C` (ehKit:false, custo 10) with two variation children
 *    `C-P` (size P) and `C-M` (size M);
 *  - a kit `K` (ehKit:true) whose `componentesKit` references `C` (quantidade 2,
 *    custo 20 = 10×2 so the parent KitManager's cost recompute leaves the form
 *    pristine) with one variation child `K-P` (size P, no kit yet).
 *
 * No `grupoDeVariacoes` docs are written — the matcher only compares the trailing
 * variant id of each `variacoesUid`, so a synthetic grupo id in the fake path is
 * enough (the C1/overlap path used here never resolves a grupo). After Gerar +
 * save, `K-P.componentesKit` should key `C-P` (overlap on size P).
 */
export async function seedKitParaGerar(prefix: string): Promise<{
  kitId: string;
  varKitPId: string;
  varKitPNome: string;
  componentId: string;
  componentNome: string;
  varCompPId: string;
  varCompMId: string;
}> {
  const grupoTam = `${prefix}-tam`;
  const fake = (v: string) => `documents/grupoDeVariacoes/${grupoTam}/variacoes/${v}`;
  const sku = (s: string) => `${prefix.toUpperCase().replace(/-/g, '_')}_${s}`;
  const base = {
    publicado: true,
    ehKitVirtual: false,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    fotos: null,
    videos: null,
    timestamp: new Date().toISOString(),
  };

  const componentId = `${prefix}-comp`;
  const componentNome = `${prefix}-comp`;
  const varCompPId = `${componentId}-p`;
  const varCompMId = `${componentId}-m`;
  const kitId = `${prefix}-kit`;
  const varKitPId = `${kitId}-p`;
  const varKitPNome = `${prefix}-kit P`;

  const batch = db().batch();
  // Component parent + its two variation children (size P / M).
  batch.set(db().collection('produtos').doc(componentId), {
    ...base,
    nome: componentNome,
    sku: sku('COMP'),
    custo: 10,
    paiId: null,
    ordem: null,
    ehKit: false,
  });
  batch.set(db().collection('produtos').doc(varCompPId), {
    ...base,
    nome: `${componentNome} P`,
    sku: sku('COMP_P'),
    custo: 10,
    paiId: componentId,
    ordem: 0,
    ehKit: false,
    variacoesUid: [fake('p')],
  });
  batch.set(db().collection('produtos').doc(varCompMId), {
    ...base,
    nome: `${componentNome} M`,
    sku: sku('COMP_M'),
    custo: 12,
    paiId: componentId,
    ordem: 1,
    ehKit: false,
    variacoesUid: [fake('m')],
  });
  // Kit parent referencing the component, + its variation child (size P).
  batch.set(db().collection('produtos').doc(kitId), {
    ...base,
    nome: `${prefix}-kit`,
    sku: sku('KIT'),
    custo: 20,
    paiId: null,
    ordem: null,
    ehKit: true,
    componentesKit: { [componentId]: { quantidade: 2, limitarEstoque: true } },
    componentesKitKeys: [componentId],
  });
  batch.set(db().collection('produtos').doc(varKitPId), {
    ...base,
    nome: varKitPNome,
    sku: sku('KIT_P'),
    paiId: kitId,
    ordem: 0,
    ehKit: false,
    variacoesUid: [fake('p')],
  });
  await batch.commit();
  return { kitId, varKitPId, varKitPNome, componentId, componentNome, varCompPId, varCompMId };
}

/**
 * Seed a Mercado Livre variation-link doc under the produto — the Flutter
 * shape: `produtos/<id>/variacoesml/<x>` with `produtoVariacaoOuterRef`
 * pointing back at the produto (`pathNoDocuments`, see
 * `produtoTableProvider.dart:1557`). Makes the produto "marketplace-linked"
 * for the delete guard.
 */
export async function seedVariacaoMlLink(produtoId: string): Promise<void> {
  await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('variacoesml')
    .doc('mlb-test')
    .set({
      id: 123456789,
      produtoVariacaoOuterRef: `produtos/${produtoId}`,
      produtoMercadoLivreOuterRef: `produtos/${produtoId}/produtomercadolivre/mlb-item`,
      sku: null,
    });
}

/**
 * Delete every doc of one produto subcollection (Firestore never cascades —
 * link docs seeded by `seedVariacaoMlLink` must be swept before the produto).
 */
export async function cleanupProdutoSubcollection(
  produtoId: string,
  subcollection: string,
): Promise<void> {
  const snap = await db().collection('produtos').doc(produtoId).collection(subcollection).get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/** Doc id of the first produto whose `sku` equals `sku`, or null. */
export async function getProdutoIdBySku(sku: string): Promise<string | null> {
  const snap = await db().collection('produtos').where('sku', '==', sku).limit(1).get();
  return snap.docs[0]?.id ?? null;
}

/** Doc id of the first produto whose `nome` equals `nome`, or null. */
export async function getProdutoIdByNome(nome: string): Promise<string | null> {
  const snap = await db().collection('produtos').where('nome', '==', nome).limit(1).get();
  return snap.docs[0]?.id ?? null;
}

/** Full data of a produto doc, or null when missing. */
export async function getProdutoData(produtoId: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('produtos').doc(produtoId).get();
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

/** The `produtos/<id>/extraData/singleton` doc (Descrição + Google Merchant), or null. */
export async function getProdutoExtraData(
  produtoId: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('extraData')
    .doc('singleton')
    .get();
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

/**
 * The per-depósito estoque doc `produtos/<id>/estoques/est-<produtoId>-<depositoId>`
 * (`makeEstoqueUid`), or null. The Estoque tab edits it directly.
 */
export async function getProdutoEstoque(
  produtoId: string,
  depositoId: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(`est-${produtoId}-${depositoId}`)
    .get();
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

/**
 * The per-operação imposto doc `produtos/<id>/imposto/<operacaoId>` (doc id is
 * the operação id), or null. Saved atomically with the produto doc.
 */
export async function getProdutoImposto(
  produtoId: string,
  operacaoId: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('imposto')
    .doc(operacaoId)
    .get();
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

/**
 * All `historicoEstoque` movement records of a (produto, depósito) estoque doc
 * (`produtos/<id>/estoques/est-..-../historicoEstoque`), raw wire data.
 */
export async function listHistoricoEstoque(
  produtoId: string,
  depositoId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(`est-${produtoId}-${depositoId}`)
    .collection('historicoEstoque')
    .get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/**
 * Delete a produto's `estoques` docs AND their nested `historicoEstoque` records
 * (Firestore never cascades subcollections). Call per produto (parent + each
 * variation child) in teardown.
 */
export async function cleanupProdutoEstoque(produtoId: string): Promise<void> {
  const estoques = await db().collection('produtos').doc(produtoId).collection('estoques').get();
  if (estoques.empty) return;
  const batch = db().batch();
  for (const est of estoques.docs) {
    const hist = await est.ref.collection('historicoEstoque').get();
    hist.docs.forEach((h) => batch.delete(h.ref));
    batch.delete(est.ref);
  }
  await batch.commit();
}

/**
 * Seed two prefix-scoped `listaDePrecos` docs for the Preço/Custo suite:
 * "varejo" carries one deterministic formula (`C*L+T`, L=2 T=5, no weight
 * bands — custo 10 → 25) and "atacado" has none (Recalcular stays disabled).
 */
export async function seedListasDePreco(prefix: string): Promise<{
  varejoId: string;
  varejoNome: string;
  atacadoId: string;
  atacadoNome: string;
}> {
  const varejoId = `${prefix}-varejo`;
  const atacadoId = `${prefix}-atacado`;
  const now = new Date().toISOString();
  const batch = db().batch();
  batch.set(db().collection('listaDePrecos').doc(varejoId), {
    nome: varejoId,
    padrao: true,
    ativo: true,
    formulasCalculoPreco: [
      {
        limiar: 999999,
        formula: 'C*L+T',
        taxaFixa: 5,
        custoFixo: 0,
        margemDeLucro: 2,
        comissaoMarketplace: 0,
        imposto: 0,
        frete: 0,
        marketing: 0,
        faixasTaxaFixaPeso: null,
      },
    ],
    formulasPorCategoria: null,
    timestamp: now,
    ultimaModificacao: now,
  });
  batch.set(db().collection('listaDePrecos').doc(atacadoId), {
    nome: atacadoId,
    padrao: false,
    ativo: true,
    formulasCalculoPreco: null,
    formulasPorCategoria: null,
    timestamp: now,
    ultimaModificacao: now,
  });
  await batch.commit();
  return { varejoId, varejoNome: varejoId, atacadoId, atacadoNome: atacadoId };
}

/** All `historicoDePrecos` docs of a produto (unsorted). */
export async function listHistoricoPrecos(
  produtoId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDePrecos')
    .get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/** All `historicoDeCusto` records of a produto (raw wire data). */
export async function listHistoricoCusto(
  produtoId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDeCusto')
    .get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/** Seed one `historicoDeCusto` record (the old app's wire shape). */
export async function seedHistoricoCusto(produtoId: string, valor: number): Promise<void> {
  await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDeCusto')
    .doc('custo-test')
    .set({ valor, timestamp: Date.now() });
}

/**
 * Delete every doc in `collection` whose `field` starts with `prefix`. Picks
 * up both seeded docs and UI-created ones (which get Firestore auto-ids).
 */
export async function cleanupByFieldPrefix(
  collection: string,
  field: string,
  prefix: string,
): Promise<void> {
  const snap = await db()
    .collection(collection)
    .where(field, '>=', prefix)
    .where(field, '<', `${prefix}${PREFIX_MAX}`)
    .get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Delete every doc in `collection` whose `nome` starts with `prefix`. Picks
 * up both seeded docs and UI-created ones (which get Firestore auto-ids).
 */
export async function cleanupByNamePrefix(collection: string, prefix: string): Promise<void> {
  await cleanupByFieldPrefix(collection, 'nome', prefix);
}

/**
 * Delete every endereco subdoc of `clienteId`. The cliente itself is swept by
 * `cleanupByNamePrefix('clientes', ...)`, but Firestore does not cascade — the
 * `enderecos` subcollection must be cleared explicitly.
 */
export async function cleanupEnderecos(clienteId: string): Promise<void> {
  const snap = await db().collection('clientes').doc(clienteId).collection('enderecos').get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Count the endereco subdocs of `clienteId`. The endereco specs poll this to
 * confirm a UI-created/-deleted subdoc actually committed before asserting on
 * the table or running the address search.
 */
export async function enderecoCount(clienteId: string): Promise<number> {
  const snap = await db().collection('clientes').doc(clienteId).collection('enderecos').get();
  return snap.size;
}

/**
 * True once a document with the given `nome` exists in `collection`. The
 * create-flow specs poll this to confirm a UI-created doc actually committed
 * — Admin SDK reads are strongly consistent — before navigating on, so the
 * list query can't race ahead of the write.
 */
export async function docExistsByName(collection: string, nome: string): Promise<boolean> {
  return docExistsByField(collection, 'nome', nome);
}

/**
 * True once a document whose `field` equals `value` exists in `collection`.
 * Generalises `docExistsByName` for collections keyed on a different field
 * (e.g. `filiais.razaoSocial`).
 */
export async function docExistsByField(
  collection: string,
  field: string,
  value: string,
): Promise<boolean> {
  const snap = await db().collection(collection).where(field, '==', value).limit(1).get();
  return !snap.empty;
}
