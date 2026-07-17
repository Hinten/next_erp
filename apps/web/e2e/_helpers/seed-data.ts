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
 *
 * `ultimaModificacao` is stamped with a distinct, increasing value per row
 * (`Date.now() + i`): the `/clientes` default query orders by it descending, so
 * without it these docs would be skipped entirely (Firestore drops docs missing
 * the orderBy field). The increment also makes the default order deterministic —
 * the highest `i` sorts first.
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
      ultimaModificacao: Date.now() + i,
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
 * Seed `n` `metodo_pgto` (Mercado Pago account) docs. `hasLinkPagamento` and
 * `user_id` alternate so the boolean/connection-hint columns have both
 * states — a null `user_id` is the "Não conectada" state the panel and the
 * list column render for an account that hasn't completed OAuth yet.
 */
export async function seedMetodoPagamento(prefix: string, n: number): Promise<void> {
  const col = db().collection('metodo_pgto');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      tipo: 1,
      nome: `${prefix}-${pad(i)}`,
      hasLinkPagamento: i % 2 === 0,
      user_id: i % 2 === 0 ? 900_000_000 + i : null,
      dataCadastro: Date.now() * 1000,
    });
  }
  await batch.commit();
}

/** Teardown for `seedMetodoPagamento`. */
export async function cleanupMetodoPagamento(prefix: string): Promise<void> {
  await cleanupByNamePrefix('metodo_pgto', prefix);
}

/**
 * Seed `n` tabela-de-medidas (`tabMedi`) docs. `codigo`/`descricao` alternate
 * null/string so the Nome/Código columns and filters have something to bite
 * on. `dataCadastro` is ms-epoch (the Flutter wire format).
 */
export async function seedMedidas(prefix: string, n: number): Promise<void> {
  const col = db().collection('tabMedi');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      codigo: i % 2 === 0 ? `COD-${pad(i)}` : null,
      descricao: i % 3 === 0 ? `${prefix}-${pad(i)} descrição` : null,
      fotosArquivosIds: null,
      fotos: null,
      tabelasDeMedidasMercadoLivre: null,
      tabelasMedidasShopee: null,
      dataCadastro: Date.now(),
      ultimaModificacao: null,
    });
  }
  await batch.commit();
}

/**
 * Seed exactly one `tabMedi` doc (`<prefix>-mkt`) carrying NON-empty
 * marketplace maps — a Mercado Livre chart (keyed by ML conta id) and a Shopee
 * size-chart reference (keyed by Shopee conta id). These are authored by the
 * marketplace integrations, excluded from the CRUD form, and must survive an
 * edit untouched; the returned maps let the spec assert byte-equality.
 */
export async function seedMedidaComMarketplace(prefix: string): Promise<{
  id: string;
  nome: string;
  mercadoLivre: Record<string, unknown>;
  shopee: Record<string, unknown>;
}> {
  const id = `${prefix}-mkt`;
  const nome = `${prefix}-mkt`;
  const mercadoLivre = {
    'conta-ml-1': {
      tabelas: [{ id: '1594439', nome: 'Chart A', domain_id: 'MLB-PANTS', rows: [] }],
    },
  };
  const shopee = {
    'conta-shopee-1': [{ categoryId: 11012, size_chart_id: 700024639, name: 'Camisetas' }],
  };
  await db().collection('tabMedi').doc(id).set({
    nome,
    codigo: 'MKT-001',
    descricao: null,
    fotosArquivosIds: null,
    fotos: null,
    tabelasDeMedidasMercadoLivre: mercadoLivre,
    tabelasMedidasShopee: shopee,
    dataCadastro: Date.now(),
    ultimaModificacao: null,
  });
  return { id, nome, mercadoLivre, shopee };
}

/** Full data of the first `tabMedi` doc named `nome`, or null. */
export async function getTabMediByName(nome: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('tabMedi').where('nome', '==', nome).limit(1).get();
  const data = snap.docs[0]?.data();
  return data ? (data as Record<string, unknown>) : null;
}

/**
 * Seed one tabMedi carrying a SENT Mercado Livre chart keyed by the given
 * integração id, so the medidas editor's Mercado Livre tab renders a conta
 * card with an existing "Enviada" guia (no live ML backend needed). The chart
 * has two size rows so the "2 tamanhos" summary is assertable.
 */
export async function seedMedidaMlChart(
  prefix: string,
  integracaoId: string,
): Promise<{ id: string; nome: string; chartNome: string }> {
  const id = `${prefix}-mlchart`;
  const nome = `${prefix}-mlchart`;
  const chartNome = `${prefix}-guia`;
  await db()
    .collection('tabMedi')
    .doc(id)
    .set({
      nome,
      codigo: null,
      descricao: null,
      fotosArquivosIds: null,
      fotos: null,
      tabelasDeMedidasMercadoLivre: {
        [integracaoId]: {
          tabelas: [
            {
              id: '1594439',
              nome: chartNome,
              domain_id: 'MLB-T_SHIRTS',
              tipo: 'CLOTHING_MEASURE',
              main_attribute_id: 'SIZE',
              attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
              main_attribute: [],
              rows: [
                {
                  varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
                  id: '1594439:1',
                  attributes: [{ id: 'SIZE', value_name: 'M' }],
                },
                {
                  varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-g',
                  id: '1594439:2',
                  attributes: [{ id: 'SIZE', value_name: 'G' }],
                },
              ],
            },
          ],
        },
      },
      tabelasMedidasShopee: null,
      dataCadastro: Date.now(),
      ultimaModificacao: null,
    });
  return { id, nome, chartNome };
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
 * Seed `n` operação docs for the `/operacoes` CRUD suite. `tipo` alternates
 * entrada/saída and `movimentaEstoque`/`padrao` vary so the columns + sort have
 * something to bite on. Tax configs are omitted (now optional — the converter
 * parses without them).
 */
export async function seedOperacoes(prefix: string, n: number): Promise<void> {
  const col = db().collection('operacao');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      naturezaDaOperacao: `Venda ${pad(i)}`,
      tipo: i % 2 === 0 ? 1 : 0,
      ehServico: false,
      ehExterior: false,
      ehConsumidorFinal: true,
      padrao: i === 1,
      ativo: true,
      movimentaEstoque: i % 2 === 0,
      movimentaIndisponivelEstoque: true,
      ehFiscal: true,
      finNFe: 1,
      indPres: '2',
      indIntermed: '1',
      cfop: `510${i % 10}`,
      cfopInterestadual: `610${i % 10}`,
      origem: '0',
      NCM: null,
      CEST: null,
      unidade: 'UN',
      estadosDestino: null,
      estados: null,
      infCpl: null,
      timestamp: Date.now(),
    });
  }
  await batch.commit();
}

/** Full data of the first `operacao` doc named `nome`, or null. */
export async function getOperacaoByName(nome: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('operacao').where('nome', '==', nome).limit(1).get();
  const data = snap.docs[0]?.data();
  return data ? (data as Record<string, unknown>) : null;
}

/**
 * Delete an operação and its `regras` subcollection (Firestore never
 * cascades). Sweeps every operação on the prefix + their macros.
 */
export async function cleanupOperacoes(prefix: string): Promise<void> {
  const snap = await db()
    .collection('operacao')
    .where('nome', '>=', prefix)
    .where('nome', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  for (const opDoc of snap.docs) {
    const regras = await opDoc.ref.collection('regras').get();
    if (!regras.empty) {
      const b = db().batch();
      regras.docs.forEach((r) => b.delete(r.ref));
      await b.commit();
    }
  }
  await cleanupByNamePrefix('operacao', prefix);
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
 * Seed a small fixture set for a canais/<canal> suite: one filial, one
 * listaDePrecos, one deposito (each named `<prefix>-ref`), then `n`
 * Integracao docs with the given `tipo` referencing them. The returned ids
 * let tests pick the same docs in the `<CollectionSelect>` dropdowns during
 * the create flow. Shared by the Balcão (tipo 7) and Mercado Livre (tipo 1)
 * suites.
 */
async function seedIntegracaoFixtures(
  prefix: string,
  n: number,
  tipo: number,
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
      tipo,
      padrao: i === 1,
      nome: `${prefix}-${pad(i)}`,
      cpf_cnpj: null,
      idCadIntTran: null,
      ativo: i % 2 === 1,
      cor: null,
      modalidadeFreteImportacao: null,
      filialIntegracaoPedidoOuterRef: `documents/${filialRef.path}`,
      tabelaNormalOuterRef: `documents/${listaRef.path}`,
      tabelaPromocionalOuterRef: null,
      operacaoOuterRef: null,
      operacaoDevolucaoOuterRef: null,
      depositoOuterRef: `documents/${depositoRef.path}`,
      dataCadastro: now,
    });
  }
  await batch.commit();

  return { filialId, listaId, depositoId };
}

/** Balcão (tipo 7) fixture set — see `seedIntegracaoFixtures`. */
export async function seedBalcaoFixtures(
  prefix: string,
  n: number,
): Promise<{ filialId: string; listaId: string; depositoId: string }> {
  return seedIntegracaoFixtures(prefix, n, 7);
}

/** Mercado Livre (tipo 1) fixture set — see `seedIntegracaoFixtures`. */
export async function seedMercadoLivreFixtures(
  prefix: string,
  n: number,
): Promise<{ filialId: string; listaId: string; depositoId: string }> {
  return seedIntegracaoFixtures(prefix, n, 1);
}

/**
 * WhatsApp (tipo 6) fixture set — see `seedIntegracaoFixtures`, then patches
 * each doc with the flat WhatsApp fields (#528) the `/canais/whatsapp`
 * screen reads: `numero` (the TableView column) and `wa_id`/`phoneNumberId`
 * (the account identity). Messaging/business-hours fields are left null — the
 * "business-hours field smoke" test edits them via the UI instead of asserting
 * on seeded values. (`verificado` is intentionally NOT seeded: the list no
 * longer renders a "Conexão" column — live status lives on the [id] panel.)
 */
export async function seedWhatsappFixtures(
  prefix: string,
  n: number,
): Promise<{ filialId: string; listaId: string; depositoId: string }> {
  const refs = await seedIntegracaoFixtures(prefix, n, 6);
  const batch = db().batch();
  const col = db().collection('integracao');
  for (let i = 1; i <= n; i += 1) {
    batch.update(col.doc(`${prefix}-${pad(i)}`), {
      wa_id: `${prefix}-wa-${pad(i)}`,
      phoneNumberId: `${prefix}-wa-${pad(i)}`,
      numero: `5511999${pad(i)}`,
      mensagem_automatica: null,
      mensagem_inatividade: null,
      horario_funcionamento: null,
    });
  }
  await batch.commit();
  return refs;
}

/**
 * Teardown for `seedIntegracaoFixtures`: sweeps the seeded Integracao +
 * fixture filial/listaDePrecos/deposito docs, including any UI-created
 * Integracao row sharing the run-scoped prefix.
 */
async function cleanupIntegracaoFixtures(prefix: string): Promise<void> {
  await Promise.all([
    cleanupByNamePrefix('integracao', prefix),
    cleanupByFieldPrefix('filiais', 'razaoSocial', prefix),
    cleanupByNamePrefix('listaDePrecos', prefix),
    cleanupByNamePrefix('depositos', prefix),
  ]);
}

/** Teardown for `seedBalcaoFixtures`. */
export async function cleanupBalcaoFixtures(prefix: string): Promise<void> {
  await cleanupIntegracaoFixtures(prefix);
}

/** Teardown for `seedMercadoLivreFixtures`. */
export async function cleanupMercadoLivreFixtures(prefix: string): Promise<void> {
  await cleanupIntegracaoFixtures(prefix);
}

/** Teardown for `seedWhatsappFixtures`. */
export async function cleanupWhatsappFixtures(prefix: string): Promise<void> {
  await cleanupIntegracaoFixtures(prefix);
}

/* -------------------------------------------------------------------------- */
/*                       Chat inbox fixtures (PR-C2)                           */
/* -------------------------------------------------------------------------- */

/** The two etiqueta ARGB ints the chat inbox spec filters on. */
export const CHAT_ETIQUETA_RED = 0xfff44336; // 4294198070
export const CHAT_ETIQUETA_BLUE = 0xff2196f3;

export interface SeededConversa {
  id: string;
  nome: string;
  estadoConversa: number;
  corEtiqueta: number | null;
  previewText: string;
}

export interface SeededChat {
  /** Em-resposta conversa tagged RED, with a recent inbound message. */
  vermelha: SeededConversa;
  /** Não-respondido (pendente) conversa, no etiqueta. */
  pendente: SeededConversa;
  /** Em-resposta conversa tagged BLUE. */
  azul: SeededConversa;
}

/**
 * Seed one `mensagem` doc (ms-epoch `timestamp`) under a chat conversa. Wire
 * shape mirrors `mensagemSchema`; a customer inbound is `estadoEnvio: 7`.
 */
export async function seedMensagem(
  conversaId: string,
  id: string,
  data: {
    conteudo: string;
    timestampMs: number;
    tipo?: string;
    estadoEnvio?: number;
    userId?: string | null;
  },
): Promise<void> {
  await db()
    .collection('chat')
    .doc(conversaId)
    .collection('mensagem')
    .doc(id)
    .set({
      tipo: data.tipo ?? 'c',
      estadoEnvio: data.estadoEnvio ?? 7,
      conteudo: data.conteudo,
      canal: 0,
      user_id: data.userId ?? null,
      mid: null,
      midGroup: null,
      resposta: null,
      usarioMensagemOuterRef: null,
      urlAvatar: null,
      error: null,
      visualizado: null,
      transcription: null,
      anexo: null,
      anexo_url: null,
      timestamp: data.timestampMs,
      data_cadastro: data.timestampMs,
    });
}

/**
 * Seed the chat inbox suite fixture: three run-scoped `chat` conversas (one
 * em-resposta RED with a recent inbound message, one pendente, one em-resposta
 * BLUE), each ordered deterministically by `ultima_modificacao`. The RED
 * conversa carries a `mensagem` so its tile preview + the thread render seeded
 * text. `origem` is `whatsapp` (drives no query here — the spec browses "Todas").
 */
export async function seedConversas(prefix: string): Promise<SeededChat> {
  const now = Date.now();
  const vermelhaId = `${prefix}-conv-vermelha`;
  const pendenteId = `${prefix}-conv-pendente`;
  const azulId = `${prefix}-conv-azul`;
  const previewText = `${prefix} ultima mensagem`;

  const base = (id: string, estadoConversa: number, corEtiqueta: number | null, order: number) => ({
    id,
    doc: {
      id: null,
      sender_id: null,
      estadoConversa,
      origem: 'whatsapp',
      usarioOuterRef: null,
      integracaoOuterRef: null,
      pedidoOuterRef: null,
      incidenteOuterRef: null,
      produtoOuterRef: null,
      usuarios: null,
      data_cadastro: now,
      ultima_modificacao: now + order,
      ultimaModificacaoIntegracao: now + order,
      prazo_resposta: now + order,
      recebido_fora_atendimento: null,
      recebido_durante_atendimento: null,
      nome: id,
      urlAvatar: '',
      cor_etiqueta: corEtiqueta,
      atendido: false,
      externalLink: null,
      internalLink: null,
      versao: null,
      mensagensIdMap: null,
      mensagensId: null,
    },
  });

  const rows = [
    base(vermelhaId, 1, CHAT_ETIQUETA_RED, 3),
    base(pendenteId, 0, null, 2),
    base(azulId, 1, CHAT_ETIQUETA_BLUE, 1),
  ];
  const batch = db().batch();
  for (const r of rows) batch.set(db().collection('chat').doc(r.id), r.doc);
  await batch.commit();

  await seedMensagem(vermelhaId, `${prefix}-msg-001`, {
    conteudo: previewText,
    timestampMs: now,
    estadoEnvio: 7,
  });

  return {
    vermelha: {
      id: vermelhaId,
      nome: vermelhaId,
      estadoConversa: 1,
      corEtiqueta: CHAT_ETIQUETA_RED,
      previewText,
    },
    pendente: {
      id: pendenteId,
      nome: pendenteId,
      estadoConversa: 0,
      corEtiqueta: null,
      previewText,
    },
    azul: {
      id: azulId,
      nome: azulId,
      estadoConversa: 1,
      corEtiqueta: CHAT_ETIQUETA_BLUE,
      previewText,
    },
  };
}

/**
 * Teardown for `seedConversas`: delete each seeded conversa's `mensagem`
 * subcollection (Firestore never cascades) then the conversa docs — swept by
 * the run-scoped `nome` prefix, so UI-created rows on the prefix go too.
 */
export async function cleanupConversas(prefix: string): Promise<void> {
  const snap = await db()
    .collection('chat')
    .where('nome', '>=', prefix)
    .where('nome', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  for (const convDoc of snap.docs) {
    const msgs = await convDoc.ref.collection('mensagem').get();
    if (!msgs.empty) {
      const b = db().batch();
      msgs.docs.forEach((m) => b.delete(m.ref));
      await b.commit();
    }
  }
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
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
  listaNome: string;
  listaPreco: number;
}> {
  const clienteId = `${prefix}-cli-001`;
  const operacaoId = `${prefix}-op-001`;
  const integracaoId = `${prefix}-int-001`;
  const produtoId = `${prefix}-pro-001`;
  const listaId = `${prefix}-lista-001`;
  const clienteNome = `${prefix}-cli-001`;
  // Run-unique valid CNPJ: the quick-create dedup spec fills it expecting
  // exactly ONE blocking candidate (this fixture) in the shared collection.
  const clienteCpfCnpj = validTestCnpj(runDigits(12));
  const operacaoNome = `${prefix}-op-001`;
  const integracaoNome = `${prefix}-int-001`;
  const produtoNome = `${prefix}-pro-001`;
  const produtoSku = `${prefix.toUpperCase().replace(/-/g, '_')}_SKU_001`;
  const listaNome = `${prefix}-lista-001`;
  // Seeded list price for the produto in this lista — the item-entry UI looks it
  // up on pick and autofills `precoDeVenda` (instead of the 0.01 placeholder).
  const listaPreco = 33.5;

  const batch = db().batch();
  const clienteNow = Date.now();
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
    timestamp: clienteNow,
    // Stamped so the fixture cliente shows in `/clientes` (default sort is
    // `ultimaModificacao desc`; Firestore skips docs missing the field).
    ultimaModificacao: clienteNow,
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
  batch.set(db().collection('listaDePrecos').doc(listaId), {
    nome: listaNome,
    padrao: true,
    ativo: true,
    formulasCalculoPreco: null,
    formulasPorCategoria: null,
    timestamp: Date.now(),
    ultimaModificacao: Date.now(),
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
    // Price in the seeded lista — keyed by the ListaDePrecos doc id. The
    // item-entry UI reads `precos[listaId].valor` to autofill `precoDeVenda`.
    precos: { [listaId]: { valor: listaPreco } },
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
    listaNome,
    listaPreco,
  };
}

/**
 * Fixtures for the pedido→estoque TRIGGER e2e (#409, emulator lane): depósito +
 * saída operação (both stock flags) + an integração wiring them together + one
 * produto + the pedido itself. Unlike `seedPedidoFixtures` (which predates the
 * sync), the integração carries `depositoOuterRef`/`operacaoOuterRef` — the
 * config `sincronizarEstoquePedido` resolves.
 *
 * The pedido is seeded at `estado: 'iniciado'` ON PURPOSE: in the emulator,
 * Admin SDK writes ALSO fire `onPedidoEstoqueSync`, and `iniciado` has no stock
 * effect — the seed write just warms the function. `operacaoPedidoOuterRef`
 * stays null so the sync exercises the integração-default resolution path. The
 * item carries every field the pedido editor's Zod converter requires
 * (`precoDeVenda` has no default), since the spec opens the real editor.
 */
export async function seedPedidoEstoqueFixtures(prefix: string): Promise<{
  depositoId: string;
  produtoId: string;
  pedidoId: string;
  quantidade: number;
}> {
  const dep = await seedDepositoAtivo(prefix);
  const operacaoId = `${prefix}-op-001`;
  const integracaoId = `${prefix}-int-001`;
  const produtoId = `${prefix}-pro-001`;
  const pedidoId = `${prefix}-ped-001`;
  const quantidade = 5;
  const precoDeVenda = 33.5;
  const now = Date.now();

  const batch = db().batch();
  batch.set(db().collection('operacao').doc(operacaoId), {
    nome: operacaoId,
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
    timestamp: now,
  });
  batch.set(db().collection('integracao').doc(integracaoId), {
    tipo: 7, // balcao
    padrao: false,
    nome: integracaoId,
    cpf_cnpj: null,
    idCadIntTran: null,
    ativo: true,
    cor: null,
    modalidadeFreteImportacao: null,
    filialIntegracaoPedidoOuterRef: null,
    tabelaNormalOuterRef: null,
    tabelaPromocionalOuterRef: null,
    operacaoOuterRef: `documents/operacao/${operacaoId}`,
    operacaoDevolucaoOuterRef: `documents/operacao/${operacaoId}`,
    depositoOuterRef: `documents/depositos/${dep.id}`,
    dataCadastro: now,
  });
  batch.set(db().collection('produtos').doc(produtoId), {
    nome: produtoId,
    sku: `${prefix.toUpperCase().replace(/-/g, '_')}_EST_001`,
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
    precos: null,
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
  batch.set(db().collection('pedidos').doc(pedidoId), {
    ehSaida: true,
    estado: 'iniciado',
    numero: pedidoId,
    itens: {
      [produtoId]: [
        {
          produtoUid: produtoId,
          ordem: 1,
          ensureUniqueId: null,
          mktplaceId: null,
          sku: `${prefix.toUpperCase().replace(/-/g, '_')}_EST_001`,
          gtin: null,
          nomeDeVenda: produtoId,
          precoDeVenda,
          descontoUnitario: 0,
          quantidade,
          custo: null,
          timestamp: null,
          imposto: null,
        },
      ],
    },
    itensIds: [produtoId],
    descontoTotal: 0,
    valorCobrado: precoDeVenda * quantidade,
    timestamp: millisToMicros(now),
    ultimaModificacao: millisToMicros(now),
    foiImpresso: false,
    freteInicial: null,
    estoqueAplicado: null,
    dataIndisponivelEstoque: null,
    dataRemocaoEstoque: null,
    vendedorPedidoOuterRef: null,
    integracaoPedidoOuterRef: `documents/integracao/${integracaoId}`,
    operacaoPedidoOuterRef: null,
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
    listaDePrecosOuterRef: null,
  });
  await batch.commit();

  return { depositoId: dep.id, produtoId, pedidoId, quantidade };
}

/** Pedido doc + Admin `updateTime` (the no-retrigger stabilization proof, #409). */
export async function getPedidoDoc(pedidoId: string): Promise<{
  data: Record<string, unknown> | null;
  updateTimeMs: number | null;
}> {
  const snap = await db().collection('pedidos').doc(pedidoId).get();
  return {
    data: (snap.data() as Record<string, unknown> | undefined) ?? null,
    updateTimeMs: snap.updateTime?.toMillis() ?? null,
  };
}

/**
 * Teardown for `seedPedidoEstoqueFixtures`. Order matters in the emulator: the
 * pedido is deleted first (its snapshot is null by then, so the deletion-
 * reversal trigger no-ops), then estoques + fixture docs.
 */
export async function cleanupPedidoEstoqueFixtures(
  prefix: string,
  produtoId: string,
): Promise<void> {
  await db().collection('pedidos').doc(`${prefix}-ped-001`).delete();
  await cleanupProdutoEstoque(produtoId);
  await Promise.all([
    cleanupByNamePrefix('operacao', prefix),
    cleanupByNamePrefix('integracao', prefix),
    cleanupByNamePrefix('produtos', prefix),
    cleanupByNamePrefix('depositos', prefix),
  ]);
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
    cleanupByNamePrefix('listaDePrecos', prefix),
  ]);
}

/**
 * Fixtures for the pedido print e2e (#342 / PR #319): one cliente, one produto,
 * one integração, and TWO saved pedidos sharing the run prefix — one NOT yet
 * printed (`foiImpresso: false`, `dtImpressao: null`) and one ALREADY printed
 * (`foiImpresso: true`, `dtImpressao` set). Each pedido carries one
 * fully-shaped item so:
 *  - the orçamento capture and the comum batch build assemble a real sheet, and
 *  - the pedido editor's Zod converter parses when the orçamento test opens
 *    `/pedidos/<id>/editar` (`precoDeVenda` has no default — mirrors
 *    `seedPedidoEstoqueFixtures`).
 *
 * The already-printed pedido drives the comum "reprint?" confirm guard: the
 * `/pedidos` TableView projects only the columns' fields, so `foiImpresso` may
 * be absent — `dtImpressao` (the "Imp." column) is the reliable signal the
 * action reads, so it is set alongside `foiImpresso`.
 */
export async function seedPedidoImpressaoFixtures(prefix: string): Promise<{
  clienteId: string;
  produtoId: string;
  integracaoId: string;
  naoImpressoId: string;
  naoImpressoNumero: string;
  impressoId: string;
  impressoNumero: string;
}> {
  const clienteId = `${prefix}-cli-001`;
  const produtoId = `${prefix}-pro-001`;
  const integracaoId = `${prefix}-int-001`;
  const naoImpressoId = `${prefix}-001`;
  const impressoId = `${prefix}-002`;
  const sku = `${prefix.toUpperCase().replace(/-/g, '_')}_IMP_001`;
  const now = Date.now();
  const nowMicros = millisToMicros(now);

  const item = {
    produtoUid: produtoId,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku,
    gtin: null,
    nomeDeVenda: produtoId,
    precoDeVenda: 33.5,
    descontoUnitario: 0,
    quantidade: 2,
    custo: null,
    timestamp: null,
    imposto: null,
  };

  // Shared pedido body — the two docs differ only in `numero` + the print flags.
  const pedidoBase = {
    ehSaida: true,
    estado: 'iniciado',
    itens: { [produtoId]: [item] },
    itensIds: [produtoId],
    descontoTotal: 0,
    valorCobrado: 67,
    timestamp: nowMicros,
    ultimaModificacao: nowMicros,
    freteInicial: null,
    estoqueAplicado: null,
    dataIndisponivelEstoque: null,
    dataRemocaoEstoque: null,
    vendedorPedidoOuterRef: null,
    integracaoPedidoOuterRef: `documents/integracao/${integracaoId}`,
    operacaoPedidoOuterRef: null,
    clientePedidoOuterRef: `documents/clientes/${clienteId}`,
    enderecoFiscalOuterRef: null,
    listaDePrecosOuterRef: null,
    observacoesInternas: null,
  };

  const batch = db().batch();
  batch.set(db().collection('clientes').doc(clienteId), {
    tipo: '1',
    nome: clienteId,
    cpf_cnpj: validTestCnpj(runDigits(12)),
    idEstrangeiro: null,
    ie: null,
    imun: null,
    isUF: null,
    email: null,
    telefone: null,
    observacoesInternas: null,
    timestamp: now,
    ultimaModificacao: now,
    nome_embedding: null,
    telefone_embedding: null,
    userCliente: null,
  });
  batch.set(db().collection('integracao').doc(integracaoId), {
    tipo: 7, // balcao
    padrao: false,
    nome: integracaoId,
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
    dataCadastro: now,
  });
  batch.set(db().collection('produtos').doc(produtoId), {
    nome: produtoId,
    sku,
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
    precos: null,
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
  batch.set(db().collection('pedidos').doc(naoImpressoId), {
    ...pedidoBase,
    numero: naoImpressoId,
    foiImpresso: false,
    dtImpressao: null,
  });
  batch.set(db().collection('pedidos').doc(impressoId), {
    ...pedidoBase,
    numero: impressoId,
    foiImpresso: true,
    dtImpressao: nowMicros,
  });
  await batch.commit();

  return {
    clienteId,
    produtoId,
    integracaoId,
    naoImpressoId,
    naoImpressoNumero: naoImpressoId,
    impressoId,
    impressoNumero: impressoId,
  };
}

/** Teardown for `seedPedidoImpressaoFixtures` (sweeps by the run prefix). */
export async function cleanupPedidoImpressaoFixtures(prefix: string): Promise<void> {
  await cleanupPedidoFixtures(prefix);
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
  await db().collection('pedidos').doc(pedidoId).collection('nfev4').doc(nfeId).set({
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
    ultima_modificacao: now,
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
 * Fixture set for the /nfe/comunicacoes suite: one filial (the page's
 * FilialPicker target), one pedido carrying a single emitted nfev4 doc
 * (deterministic 44-digit chave, denormalized `filialId`, distinctive
 * `numeracao` — the fields the nNF / pedido filter modes resolve through),
 * and three `filiais/{filialId}/enviNfe` audit docs:
 *
 *  - lote send  — estado '3' (Concluído),  cStat '100', targets `chave`
 *  - consulta   — estado '2' (Respondido), targets `chave`
 *  - transporte — estado 'e' (Erro) + error text, targets `chaveErro`
 *                 (a second chave, so filters can prove they exclude it)
 *
 * Timestamps are staggered so the list's `orderBy timestamp desc` is
 * deterministic — the erro doc is the newest and renders first.
 */
export async function seedEnviNfeFixtures(prefix: string): Promise<{
  filialId: string;
  pedidoId: string;
  pedidoNumero: string;
  nfeId: string;
  numeracao: number;
  chave: string;
  chaveErro: string;
  msgConcluidoId: string;
  msgRespondidoId: string;
  msgErroId: string;
}> {
  const filialId = `${prefix}-filial`;
  const pedidoId = `${prefix}-ped-001`;
  const nfeId = `${pedidoId}-nfe`;
  const msgConcluidoId = `${prefix}-msg-1`;
  const msgRespondidoId = `${prefix}-msg-2`;
  const msgErroId = `${prefix}-msg-3`;
  const numeracao = 777001;
  // 44 digits — the schema validates length only, not the check digit. Cross-
  // run isolation comes from the filial-scoped subcollection + the run-scoped
  // `filialId` equality on the nfev4 collection-group lookup.
  const chave = `${'1'.repeat(38)}777001`;
  const chaveErro = `${'2'.repeat(38)}777002`;
  const now = Date.now();

  // Filial — shape from `seedFiliais`.
  await db()
    .collection('filiais')
    .doc(filialId)
    .set({
      razaoSocial: filialId,
      fantasia: null,
      cnae: null,
      cnpj: '77000000000101',
      ie: '770000001',
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

  // Pedido + nfev4 child — reuse `seedPedidoWithNFe` (passing `<prefix>-ped`
  // yields the same `<prefix>-ped-001` / `-nfe` ids), then patch the nfev4 doc
  // with the emitted-NFe fields the enviNfe filter resolution reads (`chave`,
  // denormalized `filialId`, `numeracao` for the nNF collection-group lookup).
  await seedPedidoWithNFe(`${prefix}-ped`, 1, 'a');
  await db().collection('pedidos').doc(pedidoId).collection('nfev4').doc(nfeId).update({
    numeracao,
    chave,
    filialId,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
  });

  const enviNfe = db().collection('filiais').doc(filialId).collection('enviNfe');
  const batch = db().batch();
  batch.set(enviNfe.doc(msgConcluidoId), {
    targetsChnfe: [chave],
    idLote: 1,
    indSinc: '1',
    xml_enviado: '<enviNFe versao="4.00"><idLote>1</idLote></enviNFe>',
    xml_retorno: JSON.stringify({
      retEnviNFe: { cStat: '104', protNFe: { infProt: { cStat: '100', chNFe: chave } } },
    }),
    nRec: null,
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    error: null,
    tpEmis: 1,
    estado: '3',
    timestamp: now,
    ultima_modificacao: now,
  });
  batch.set(enviNfe.doc(msgRespondidoId), {
    targetsChnfe: [chave],
    idLote: null,
    indSinc: null,
    xml_enviado: null,
    xml_retorno: JSON.stringify({
      retConsReciNFe: { cStat: '105', xMotivo: 'Lote em processamento' },
    }),
    nRec: '351000000777001',
    cStat: '105',
    xMotivo: 'Lote em processamento',
    error: null,
    tpEmis: 1,
    estado: '2',
    timestamp: now + 1_000,
    ultima_modificacao: now + 1_000,
  });
  batch.set(enviNfe.doc(msgErroId), {
    targetsChnfe: [chaveErro],
    idLote: 2,
    indSinc: '0',
    xml_enviado: '<enviNFe versao="4.00"><idLote>2</idLote></enviNFe>',
    xml_retorno: null,
    nRec: null,
    cStat: null,
    xMotivo: null,
    error: 'ECONNRESET: falha de transporte ao enviar o lote',
    tpEmis: 1,
    estado: 'e',
    timestamp: now + 2_000,
    ultima_modificacao: now + 2_000,
  });
  await batch.commit();

  return {
    filialId,
    pedidoId,
    pedidoNumero: pedidoId,
    nfeId,
    numeracao,
    chave,
    chaveErro,
    msgConcluidoId,
    msgRespondidoId,
    msgErroId,
  };
}

/**
 * Clean up everything `seedEnviNfeFixtures` wrote. Subcollections are not
 * cascaded by the Firestore SDK (same caveat as `cleanupPedidoWithNFe`):
 * sweep the filial's `enviNfe` docs explicitly, then reuse
 * `cleanupPedidoWithNFe` for the pedido + its `nfev4` docs.
 */
export async function cleanupEnviNfeFixtures(prefix: string): Promise<void> {
  const filialId = `${prefix}-filial`;
  const enviSnap = await db().collection('filiais').doc(filialId).collection('enviNfe').get();
  if (!enviSnap.empty) {
    const batch = db().batch();
    enviSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await db().collection('filiais').doc(filialId).delete();
  await cleanupPedidoWithNFe(`${prefix}-ped-001`);
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
  // grupoDeVariacoes datetimes are millisecondsSinceEpoch INT (#484/#486).
  const now = Date.now();
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
 * `suffix` distinguishes multiple components under one prefix (default keeps the
 * historical `<prefix>-comp` id).
 */
export async function seedComponenteKit(
  prefix: string,
  custo = 10,
  suffix = 'comp',
): Promise<{ id: string; nome: string; sku: string }> {
  const id = `${prefix}-${suffix}`;
  const nome = `${prefix}-${suffix}`;
  const sku = `${prefix.toUpperCase().replace(/-/g, '_')}_${suffix.toUpperCase()}`;
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
 * Seed a per-depósito estoque doc `produtos/<id>/estoques/est-<produtoId>-<depositoId>`
 * with the full wire shape the app's converter parses (see the shape asserted in
 * `produto-estoque.emulator.e2e.spec.ts`). Quantities are Admin-seeded — display
 * tests don't go through the `aplicarEstoque` callable.
 */
export async function seedEstoqueDoc(
  produtoId: string,
  depositoId: string,
  quantidade: number,
  quantidadeReservada = 0,
): Promise<void> {
  await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(`est-${produtoId}-${depositoId}`)
    .set({
      parentId: produtoId,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      quantidade,
      quantidadeReservada,
      localizacao: null,
      variacoes: null,
      ultimaModificacao: Date.now(),
      dataCriacao: Date.now(),
    });
}

/**
 * Seed the graph the kit available-stock e2e needs (#238): one active depósito,
 * two `limitarEstoque` components with stock there (c1: 10−1 res → 9/2 = 4.5
 * buildable; c2: 11 → 11/3 ≈ 3.67 buildable = the min) and a kit produto
 * (quantidades 2 and 3) holding 1 pre-assembled unit of its own — so the
 * Estoque tab's Disponível cell must read `1,00 (4,67)`.
 */
export async function seedKitEstoqueFixtures(prefix: string): Promise<{
  kitId: string;
  comp1Id: string;
  comp2Id: string;
  depositoId: string;
  depositoNome: string;
}> {
  const dep = await seedDepositoAtivo(prefix);
  const comp1 = await seedComponenteKit(prefix, 10, 'comp1');
  const comp2 = await seedComponenteKit(prefix, 10, 'comp2');

  const kitId = `${prefix}-kit`;
  await db()
    .collection('produtos')
    .doc(kitId)
    .set({
      nome: `${prefix}-kit`,
      sku: `${prefix.toUpperCase().replace(/-/g, '_')}_KIT`,
      paiId: null,
      ordem: null,
      publicado: true,
      ehKit: true,
      ehKitVirtual: false,
      ofereceFreteGratis: false,
      permiteVendaSemEstoque: false,
      componentesKitKeys: [comp1.id, comp2.id],
      componentesKit: {
        [comp1.id]: { quantidade: 2, limitarEstoque: true },
        [comp2.id]: { quantidade: 3, limitarEstoque: true },
      },
      fotos: null,
      videos: null,
      timestamp: new Date().toISOString(),
    });

  await seedEstoqueDoc(kitId, dep.id, 1, 0);
  await seedEstoqueDoc(comp1.id, dep.id, 10, 1);
  await seedEstoqueDoc(comp2.id, dep.id, 11, 0);

  return {
    kitId,
    comp1Id: comp1.id,
    comp2Id: comp2.id,
    depositoId: dep.id,
    depositoNome: dep.nome,
  };
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
 * shape: `produtos/<id>/variacaoMercadoLivre/<x>` with `produtoVariacaoOuterRef`
 * pointing back at the produto. The STORED form is `documents/`-prefixed
 * (`pathWithDocuments` — `OuterRefField.toJson`; the provider feeds
 * `pathNoDocuments` into the constructor, but `fromJson` re-prefixes before
 * persisting). Makes the produto "marketplace-linked" for the delete guard.
 */
export async function seedVariacaoMlLink(produtoId: string): Promise<void> {
  await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('variacaoMercadoLivre')
    .doc('mlb-test')
    .set({
      id: 123456789,
      produtoVariacaoOuterRef: `documents/produtos/${produtoId}`,
      produtoMercadoLivreOuterRef: `documents/produtos/${produtoId}/produtoMercadoLivre/mlb-item`,
      sku: null,
    });
}

/**
 * Seed one plain produto plus a PUBLISHED `produtoMercadoLivre` link doc bound
 * to the given integração (the old Flutter wire shape: `contaOuterRef` as the
 * `documents/`-prefixed doc-path string, short-code `estado`), so the produto
 * editor's Mercado Livre tab has a published row to render without any live
 * ML backend.
 */
export async function seedProdutoMlPublicado(
  prefix: string,
  integracaoId: string,
): Promise<{ produtoId: string; nome: string; mlItemId: string }> {
  const produtoId = `${prefix}-prod`;
  const nome = `${prefix}-prod`;
  const mlItemId = 'MLB3609679155';
  const now = Date.now();
  const batch = db().batch();
  batch.set(db().collection('produtos').doc(produtoId), {
    nome,
    sku: `${prefix.toUpperCase().replace(/-/g, '_')}_ML`,
    publicado: true,
    ehKit: false,
    ehKitVirtual: false,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    fotos: null,
    videos: null,
    paiId: null,
    ordem: null,
    timestamp: new Date().toISOString(),
  });
  batch.set(
    db().collection('produtos').doc(produtoId).collection('produtoMercadoLivre').doc(mlItemId),
    {
      contaOuterRef: `documents/integracao/${integracaoId}`,
      channels: ['marketplace'],
      estado: 'p',
      id: mlItemId,
      sku: null,
      descricao: null,
      site_id: 'MLB',
      title: nome,
      category_id: 'MLB31447',
      condition: 'new',
      listing_type_id: 'gold_special',
      crossdocking: 0,
      freteGratis: false,
      precoPublicado: 79.9,
      tarifaFrete: null,
      comissao: null,
      isUserProductModel: false,
      video_id: null,
      attributes: null,
      errors: null,
      ultimaModificacao: now,
      dataCadastro: now,
    },
  );
  await batch.commit();
  return { produtoId, nome, mlItemId };
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
 * Seed `n` listaDePrecos docs for the `/listas-de-precos` CRUD suite. `padrao`
 * is true only on the first row and `ativo` alternates, so the boolean column
 * filters have both states to bite on. The composite fields
 * (`formulasCalculoPreco` / `formulasPorCategoria`) start null — the create
 * flow exercises their editors through the UI.
 */
export async function seedListasDePrecos(prefix: string, n: number): Promise<void> {
  const col = db().collection('listaDePrecos');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    const now = Date.now();
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      padrao: i === 1,
      ativo: i % 2 === 0,
      formulasCalculoPreco: null,
      formulasPorCategoria: null,
      timestamp: now,
      ultimaModificacao: now + i,
    });
  }
  await batch.commit();
}

/** Full data of the first `listaDePrecos` doc named `nome`, or null. */
export async function getListaDePrecosByName(
  nome: string,
): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('listaDePrecos').where('nome', '==', nome).limit(1).get();
  const data = snap.docs[0]?.data();
  return data ? (data as Record<string, unknown>) : null;
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
