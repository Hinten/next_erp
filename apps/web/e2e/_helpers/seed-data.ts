/**
 * Mock-data seeding for the TableView/ObjectView e2e suites. Writes docs
 * straight to Firestore via the Admin SDK (bypassing rules), then sweeps
 * them out by `nome` prefix afterwards.
 *
 * Every test doc — seeded here OR created through the UI during a test —
 * has its `nome` start with the run-scoped prefix from `e2ePrefix()`, so a
 * single prefix sweep cleans the whole suite without tracking ids.
 */
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
      cpf_cnpj: String(10000000000 + i),
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: i % 2 === 0 ? `${prefix}-${pad(i)}@example.com` : null,
      telefone: null,
      observacoesInternas: null,
      timestamp: new Date().toISOString(),
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
      timestamp: new Date().toISOString(),
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
      timestamp: new Date().toISOString(),
    });
  }
  await batch.commit();
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
      dataCadastro: new Date().toISOString(),
      ultimaModificacao: new Date().toISOString(),
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
      timestamp: new Date().toISOString(),
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
  const operacaoNome = `${prefix}-op-001`;
  const integracaoNome = `${prefix}-int-001`;
  const produtoNome = `${prefix}-pro-001`;
  const produtoSku = `${prefix.toUpperCase().replace(/-/g, '_')}_SKU_001`;

  const batch = db().batch();
  batch.set(db().collection('clientes').doc(clienteId), {
    tipo: '1',
    nome: clienteNome,
    cpf_cnpj: '12345678901',
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: null,
    telefone: null,
    observacoesInternas: null,
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
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
    dataCadastro: new Date().toISOString(),
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
  await db().collection('pedidos').doc(pedidoId).set({
    ehSaida: true,
    estado: 'pago',
    numero: pedidoId,
    itens: {},
    itensIds: [],
    descontoTotal: 0,
    timestamp: now,
    ultimaModificacao: now,
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
 * (#119). Both names are prefix-scoped for the sweep.
 */
export async function seedProdutoComFilho(prefix: string): Promise<{
  parentNome: string;
  childNome: string;
}> {
  const parentId = `${prefix}-pai`;
  const parentNome = `${prefix}-pai`;
  const childNome = `${prefix}-pai P`;
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
  batch.set(db().collection('produtos').doc(`${parentId}-filho`), {
    ...base,
    nome: childNome,
    sku: `${prefix.toUpperCase().replace(/-/g, '_')}_PAI_P`,
    paiId: parentId,
    ordem: 0,
  });
  await batch.commit();
  return { parentNome, childNome };
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
