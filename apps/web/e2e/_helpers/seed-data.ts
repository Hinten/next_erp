/**
 * Mock-data seeding for the TableView/ObjectView e2e suites. Writes docs
 * straight to Firestore via the Admin SDK (bypassing rules), then sweeps
 * them out by `nome` prefix afterwards.
 *
 * Every test doc — seeded here OR created through the UI during a test —
 * has its `nome` start with the run- and worker-scoped prefix from
 * `e2ePrefix()`, so a single prefix sweep cleans the whole suite without
 * tracking ids.
 */
import { millisToMicros } from '@delfrance/core/datetime';
import { db } from '@delfrance/test-fixtures';
import { getRunId, workerIndex } from './run-id';

/** High Unicode code point — upper bound for a Firestore prefix range query. */
const PREFIX_MAX = String.fromCharCode(0xffff);

/**
 * Run-scoped, worker-scoped, tag-scoped `nome` prefix. The run id keeps
 * parallel CI runs from clobbering each other; the worker index keeps a RETRY
 * from being clobbered by the attempt it replaces; the tag separates suites
 * (cli / cat).
 *
 * ⚠️ Both the worker segment and its POSITION are load-bearing.
 *
 * The worker segment exists because Playwright runs each retry of a
 * `describe.serial` group in a fresh worker while the previous worker is still
 * draining its `afterAll` — and it does NOT serialize the two. With a prefix
 * that was only run-scoped, the dying worker's prefix sweep deleted the
 * fixtures the retry had just re-seeded, so the retry loaded a pedido whose
 * produto no longer existed and every expected row came up "Produto não
 * encontrado". Observed on run 31718522686: two of the three attempts of
 * `despacho-checkout.vendas` died that way, ~7.5s apart, each missing a
 * DIFFERENT seeded doc. `TEST_WORKER_INDEX` changes on every retry, so the
 * namespaces are now disjoint and a late sweep can only reach its own.
 *
 * The segment goes BEFORE the tag because the sweep is a `>= p && < p+￿`
 * range, i.e. a plain startsWith, and the worker index is not fixed-width.
 * Tag-last, worker 3's `e2e-<run>-chk-w3` is a string prefix of worker 31's
 * `e2e-<run>-chk-w31`, so w3's cleanup deletes w31's fixtures — the same bug
 * one level down. Worker-first, the `-` before the tag bounds the range and
 * they stay disjoint. Double digits are reachable: the index counts up across
 * retries, not just to `workers: 4` (run 31718522686 reached w6).
 *
 * It also fixes a second, pre-existing hazard: several tags are string prefixes
 * of another (`ped` ⊂ `pedpag` / `peddev` / `ped-estoque`, `ml` ⊂ `mlpub`,
 * `nfe` ⊂ `nfelock`, …), so `pedidos.vendas`'s cleanup used to delete
 * `pedidos-pagamento.vendas`'s produtos whenever the two ran concurrently.
 * Distinct workers now keep them apart; two specs sharing a worker still share
 * that hazard, but they run strictly sequentially, so their hooks cannot
 * interleave.
 *
 * Still `e2e-<runId>-`-prefixed, so the run-level sweeps in `stale-sweep.ts`
 * (`sweepCurrentRunFixtures`, `reclaimPredecessorRun`) keep matching and a
 * worker that dies before `afterAll` is still reclaimed at end of run.
 */
export function e2ePrefix(tag: string): string {
  return `e2e-${getRunId()}-w${workerIndex()}-${tag}`;
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
 * The CNPJ every fixture cliente carries — run- AND worker-scoped.
 *
 * ⚠️ The worker half is what keeps the quick-create dedup spec honest, and it
 * is a SEPARATE axis from {@link e2ePrefix}: a doc *id* is prefix-derived, but
 * an *identity* value is not, so scoping one does not scope the other.
 *
 * `seedPedidoFixtures` alone is called by seven specs, and five of those plus
 * `imp` / `chk` / `anex` all sit in the **vendas** lane, each seeding its own
 * `<prefix>-cli-001`. Run-scoped only, all of them carry the SAME CNPJ, and
 * `checkClienteDuplicates` queries `where('cpf_cnpj','==',x)` with **no
 * `orderBy`** and `CANDIDATE_LIMIT = 5` (`lib/clientes/dedup.ts:158`) — so the
 * blocking list comes back in **key order** and the modal renders one
 * "Usar cliente existente" row per candidate. `pedidos.vendas`'s dedup test
 * takes `.first()` and then asserts its OWN fixture name, so it depends on
 * winning that ordering, and with enough live copies its cliente falls outside
 * the 5-row window entirely.
 *
 * Worker-scoping makes the spec's own comment true for the first time —
 * "exactly ONE blocking candidate". Only one spec runs per worker at a time and
 * its `afterAll` precedes the next spec's `beforeAll` in that same process, so
 * at most one live cliente can carry any given CNPJ.
 *
 * `validTestCnpj` recomputes the check digits, so any 12-digit seed stays
 * valid; a double-digit worker index just shifts the run half left by one.
 */
export function fixtureClienteCnpj(): string {
  return validTestCnpj(`${runDigits(10)}${workerIndex().padStart(2, '0')}`);
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
 * Seed one tabMedi carrying two Mercado Livre charts keyed by the given
 * integração id, so the medidas editor's Mercado Livre tab renders a conta card
 * without a live ML backend:
 *
 *  - a SENT guia ("Enviada") with two size rows carrying real BODY_MEASURE
 *    values, so both the "2 tamanhos" summary and the measurement grid are
 *    assertable;
 *  - a second guia stamped `exclusaoSolicitadaEm`, the state a chart sits in
 *    while ML decides (up to 24h) whether it is still linked to a listing.
 */
export async function seedMedidaMlChart(
  prefix: string,
  integracaoId: string,
): Promise<{ id: string; nome: string; chartNome: string; excluindoNome: string }> {
  const id = `${prefix}-mlchart`;
  const nome = `${prefix}-mlchart`;
  const chartNome = `${prefix}-guia`;
  const excluindoNome = `${prefix}-excluindo`;
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
              tipo: 'BODY_MEASURE',
              main_attribute_id: 'SIZE',
              attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
              main_attribute: [],
              rows: [
                {
                  varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
                  id: '1594439:1',
                  attributes: [
                    { id: 'SIZE', value_name: 'M' },
                    { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '90', unit_id: 'cm' },
                    { id: 'CHEST_CIRCUMFERENCE_TO', value_name: '94', unit_id: 'cm' },
                  ],
                },
                {
                  varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-g',
                  id: '1594439:2',
                  attributes: [
                    { id: 'SIZE', value_name: 'G' },
                    { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '95', unit_id: 'cm' },
                    { id: 'CHEST_CIRCUMFERENCE_TO', value_name: '99', unit_id: 'cm' },
                  ],
                },
              ],
            },
            {
              id: '1594440',
              nome: excluindoNome,
              domain_id: 'MLB-T_SHIRTS',
              tipo: 'BODY_MEASURE',
              main_attribute_id: 'SIZE',
              attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
              main_attribute: [],
              // Stamped by `requestSizeChartDeletion` once ML accepted the
              // removal REQUEST; the guia stays until a re-read confirms.
              exclusaoSolicitadaEm: Date.now(),
              rows: [
                {
                  varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-p',
                  id: '1594440:1',
                  attributes: [{ id: 'SIZE', value_name: 'P' }],
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
  return { id, nome, chartNome, excluindoNome };
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
 * Full operação wire body (so `operacaoCollection`'s converter parses it on
 * read) with `seedOperacaoAtiva`'s saída defaults; `over` states a seed's
 * deltas from that baseline.
 */
function operacaoBody(nome: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...over,
  };
}

/**
 * Seed one ACTIVE + padrão Operação (`<prefix>-op`) — the Impostos tab lists
 * active operações and the produto imposto is scoped per operação. Full wire
 * shape so `operacaoCollection`'s converter parses it on read.
 */
export async function seedOperacaoAtiva(prefix: string): Promise<{ id: string; nome: string }> {
  const id = `${prefix}-op`;
  const nome = `${prefix}-op`;
  await db().collection('operacao').doc(id).set(operacaoBody(nome));
  return { id, nome };
}

/**
 * Seed one ACTIVE **entrada** operação (`tipo: 0`) able to emit a devolução
 * NF-e (`ehFiscal: true`, `finNFe: 4`) — the operação the devolução flows
 * resolve via the integração's `operacaoDevolucaoOuterRef` (or the entrada
 * default), and the only kind the entrada form's OperacaoPicker lists.
 * Mirrors `seedOperacaoAtiva`'s wire shape with entrada CFOPs. `padrao` stays
 * false so the shared staging `findOperacaoEntradaPadrao` fallback is not
 * hijacked from concurrent suites.
 */
export async function seedOperacaoEntrada(
  prefix: string,
  suffix = 'opdev',
): Promise<{ id: string; nome: string }> {
  const id = `${prefix}-${suffix}`;
  const nome = `${prefix}-${suffix}`;
  await db()
    .collection('operacao')
    .doc(id)
    .set(
      operacaoBody(nome, {
        naturezaDaOperacao: 'Devolução de venda',
        tipo: 0,
        padrao: false,
        finNFe: 4,
        cfop: '1202',
        cfopInterestadual: '2202',
      }),
    );
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
 * Seed `n` `webchat` docs. `nome` = `<prefix>-NNN`; every field the ObjectView
 * exposes is left at its schema default (null/preset) — the suite's own tests
 * edit `mensagens_padrao` / `horario_funcionamento` / colors through the UI
 * rather than asserting on seeded values.
 */
export async function seedWebchatFixtures(prefix: string, n: number): Promise<void> {
  const col = db().collection('webchat');
  const batch = db().batch();
  for (let i = 1; i <= n; i += 1) {
    batch.set(col.doc(`${prefix}-${pad(i)}`), {
      nome: `${prefix}-${pad(i)}`,
      url: null,
      posicionamento: 'direita',
      icone: 'mensagem',
      saudacao: null,
      corBorda: '#e5e7eb',
      corIcone: '#2563eb',
      corCabecalho: '#2563eb',
      corBolhaInatividade: '#dc2626',
      corCorpoChat: '#ffffff',
      corTextoChat: '#111827',
      horario_funcionamento: null,
      mensagens_padrao: null,
      mensagens_inatividade: null,
      timestamp: Date.now(),
      ultimaModificacao: Date.now(),
    });
  }
  await batch.commit();
}

/** Teardown for `seedWebchatFixtures`. */
export async function cleanupWebchatFixtures(prefix: string): Promise<void> {
  await cleanupByNamePrefix('webchat', prefix);
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
 * text.
 *
 * ⚠️ `origem` must stay `whatsapp`, and that is now load-bearing rather than
 * arbitrary. It drives no query (the spec browses "Todas"), but since #817 it
 * drives the COMPOSER: `whatsapp` is the only origem with `temEnvio: true`, so
 * any other value makes the composer render a read-only notice and the
 * "entra na conversa e responde" spec fails on a missing input.
 */
/**
 * How far in the past a seeded conversa's `prazo_resposta` sits. Only has to
 * beat every other pendente conversa staging accumulates; a year is far past
 * any real deadline and past the 3h fixture age gate, so no leftover fixture
 * from a concurrent lane can sort ahead of it either.
 */
const PRAZO_BACKDATE_MS = 365 * 24 * 60 * 60 * 1000;

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
      // ⚠️ BACKDATED, and deliberately the opposite direction to the two fields
      // above. `ultima_modificacao` is future-dated because the Todas and
      // Atendimento tabs sort it DESC, so a future value lands the fixture on
      // page 1. The Pendentes tab sorts `prazo_resposta` **ASC**
      // (`DEFAULT_ORDEM` / `ORDER_SPEC` in lib/chat/conversaConstraints.ts), so
      // the same future value sorted the fixture LAST — behind every other
      // pendente conversa in staging, with `CONVERSA_PAGE_SIZE = 200` above it.
      // A past prazo is also what the field MEANS here: an overdue deadline
      // belongs at the top of a most-urgent-first list.
      prazo_resposta: now - PRAZO_BACKDATE_MS + order,
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

export interface SeededSearchMessages {
  /** Run-scoped token both seeded messages contain (the global-search query). */
  token: string;
  /** Conversa + message id + ordering ts of the OLD (jump-to) match. */
  oldConversaId: string;
  oldMsgId: string;
  oldTs: number;
  /** Conversa + message id of the RECENT match (a different conversa). */
  recentConversaId: string;
  recentMsgId: string;
}

/**
 * Seed two `mensagem` docs carrying a run-scoped TOKEN — an OLD one in the BLUE
 * conversa and a RECENT one in the RED conversa — for the cross-conversation
 * search e2e (PR-C5). Both are timestamped in the near FUTURE (`now + offset`)
 * so they always land in the global search's newest 300-doc page regardless of
 * the shared staging collection's volume (the same trick as the conversa seed's
 * `ultima_modificacao: now + order`); the OLD one sorts BELOW the recent one
 * within the pair, so both conversas surface grouped, recent-first.
 */
export async function seedSearchMessages(
  prefix: string,
  _seeded: SeededChat,
): Promise<SeededSearchMessages> {
  const token = `${prefix}-tokenbusca`;
  const now = Date.now();
  // Future-dated so both land in the newest-300 global collection-group page
  // regardless of the shared staging collection's volume.
  const oldTs = now + 1_000;
  const recentTs = now + 500_000;
  const oldMsgId = `${prefix}-msg-antiga`;
  const recentMsgId = `${prefix}-msg-recente`;
  // DEDICATED conversas: injecting the token messages into the main seeded
  // conversas displaced their newest message and broke the tile-preview
  // assertion (the preview is the newest doc). Prefix-scoped names keep them
  // inside cleanupConversas' sweep range.
  const oldConversaId = `${prefix}-conv-busca-antiga`;
  const recentConversaId = `${prefix}-conv-busca-recente`;

  const convDoc = (id: string) => ({
    id: null,
    sender_id: null,
    estadoConversa: 1,
    origem: 'whatsapp',
    usarioOuterRef: null,
    integracaoOuterRef: null,
    pedidoOuterRef: null,
    incidenteOuterRef: null,
    produtoOuterRef: null,
    usuarios: null,
    data_cadastro: now,
    ultima_modificacao: now,
    ultimaModificacaoIntegracao: now,
    prazo_resposta: now,
    recebido_fora_atendimento: null,
    recebido_durante_atendimento: null,
    nome: id,
    urlAvatar: '',
    cor_etiqueta: null,
    atendido: false,
    externalLink: null,
    internalLink: null,
    versao: null,
    mensagensIdMap: null,
    mensagensId: null,
  });
  const batch = db().batch();
  batch.set(db().collection('chat').doc(oldConversaId), convDoc(oldConversaId));
  batch.set(db().collection('chat').doc(recentConversaId), convDoc(recentConversaId));
  await batch.commit();

  await seedMensagem(oldConversaId, oldMsgId, {
    conteudo: `mensagem antiga com ${token}`,
    timestampMs: oldTs,
    estadoEnvio: 7,
  });
  await seedMensagem(recentConversaId, recentMsgId, {
    conteudo: `mensagem recente com ${token}`,
    timestampMs: recentTs,
    estadoEnvio: 7,
  });

  return {
    token,
    oldConversaId,
    oldMsgId,
    oldTs,
    recentConversaId,
    recentMsgId,
  };
}

/**
 * Teardown for `seedConversas`: delete each seeded conversa's `mensagem`
 * subcollection (Firestore never cascades) then the conversa docs — swept by
 * the run-scoped `nome` prefix, so UI-created rows on the prefix go too.
 * (`seedSearchMessages`' extra docs live under the same conversas → swept here.)
 */
export async function cleanupConversas(prefix: string): Promise<void> {
  const snap = await db()
    .collection('chat')
    .where('nome', '>=', prefix)
    .where('nome', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  // Firestore batches cap at 500 ops — chunk every delete pass so a message-
  // heavy conversa (bulk-action events, retries) can never blow the teardown.
  const BATCH_CAP = 450;
  const deleteChunked = async (refs: FirebaseFirestore.DocumentReference[]) => {
    for (let i = 0; i < refs.length; i += BATCH_CAP) {
      const b = db().batch();
      refs.slice(i, i + BATCH_CAP).forEach((r) => b.delete(r));
      await b.commit();
    }
  };
  for (const convDoc of snap.docs) {
    const msgs = await convDoc.ref.collection('mensagem').get();
    await deleteChunked(msgs.docs.map((m) => m.ref));
  }
  await deleteChunked(snap.docs.map((d) => d.ref));
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
  const clienteCpfCnpj = fixtureClienteCnpj();
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
    // Firestore `orderBy` SKIPS docs missing the field, and /produtos now
    // defaults to `ultimaModificacao desc` (#159) — an unstamped fixture is
    // invisible in the list. Admin `.set()` bypasses Zod, so the schema
    // default cannot fill this in for us.
    ultimaModificacao: Date.now(),
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
    ultimaModificacao: Date.now(),
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
    cpf_cnpj: fixtureClienteCnpj(),
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
    ultimaModificacao: Date.now(),
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
 *     points at a Mercado Livre integração, for the read-only rendering;
 *   - a Motoboy-freight pedido (`<prefix>-mot-001`), for the carrier-less
 *     generic-label etiqueta row action.
 */
export async function seedPedidoFreteFixtures(prefix: string): Promise<{
  base: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  clienteId: string;
  enderecoPath: string;
  retiradaId: string;
  retiradaNome: string;
  motoboyId: string;
  motoboyNome: string;
  mlIntId: string;
  mlContaId: string;
  mktPedidoId: string;
  motPedidoId: string;
}> {
  const base = await seedPedidoFixtures(prefix);
  const clienteId = `${prefix}-cli-001`;
  const enderecoId = `${prefix}-end-001`;
  const retiradaId = `${prefix}-fr-ret`;
  const retiradaNome = `${prefix}-frete-retirada`;
  const motoboyId = `${prefix}-fr-mot`;
  const motoboyNome = `${prefix}-frete-motoboy`;
  const mlIntId = `${prefix}-fr-ml`;
  const mlContaId = `${prefix}-conta-ml`;
  const mktPedidoId = `${prefix}-mkt-001`;
  const motPedidoId = `${prefix}-mot-001`;

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
    contaMercadoLivreMercadoEnviosOuterRef: null,
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
  // The ML conta this freight doc belongs to. In production the pair is created by
  // the `onIntegracaoMercadoLivreChanged` trigger (#782), which mirrors the conta
  // onto the freight doc and stamps the back-ref — so the fixture seeds BOTH, and
  // the back-ref in the canonical `documents/integracao/<id>` form the trigger and
  // the order importer agree on. Omitting it (as this fixture used to) validated a
  // shape the product never produces.
  batch.set(db().collection('integracao').doc(mlContaId), {
    tipo: 1, // INTEGRACAO_TIPO.mercadoLivre
    padrao: false,
    nome: `${prefix}-conta-ml`,
    cpf_cnpj: null,
    idCadIntTran: null,
    ativo: true,
    cor: null,
    modalidadeFreteImportacao: null,
    filialIntegracaoPedidoOuterRef: `documents/filiais/${prefix}-fil-001`,
    tabelaNormalOuterRef: null,
    tabelaPromocionalOuterRef: null,
    operacaoOuterRef: null,
    operacaoDevolucaoOuterRef: null,
    depositoOuterRef: null,
    dataCadastro: Date.now(),
  });
  batch.set(db().collection('int_frete').doc(mlIntId), {
    ...intFreteBase,
    tipo: 'mercadoLivre',
    nome: `${prefix}-frete-ml`,
    faixaCep: null,
    contaMercadoLivreMercadoEnviosOuterRef: `documents/integracao/${mlContaId}`,
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
      // Real ML importers (legacy and new) NEVER write externalOptionId (nor
      // printLabelId) — the fetch-label UI must light up off
      // externalOptionIntegracao alone, and this fixture pins that shape.
      externalOptionId: null,
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
  // Motoboy-freight pedido — carrier-less, so its etiqueta is the on-demand
  // generic PDF (no printLabelId, no buy step): `EtiquetaRowAction` must
  // light up 'imprimir' off `FREIGHT_TIPO_CAPS.motoboy` alone.
  batch.set(db().collection('pedidos').doc(motPedidoId), {
    ehSaida: true,
    estado: 'pago',
    numero: motPedidoId,
    itens: {},
    itensIds: [],
    descontoTotal: 0,
    timestamp: millisToMicros(Date.now()),
    clientePedidoOuterRef: `documents/clientes/${clienteId}`,
    freteInicial: {
      externalId: null,
      externalOptionId: null,
      externalOptionIntegracao: null,
      externalOptionData: null,
      estado: 'iniciado',
      integracaoFreteOuterRef: `documents/int_frete/${motoboyId}`,
      modalidade: '0',
      codRastreio: null,
      valorCobrado: 15,
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
      enderecoFreteOuterReference: `documents/clientes/${clienteId}/enderecos/${enderecoId}`,
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
    mlIntId,
    mlContaId,
    mktPedidoId,
    motPedidoId,
  };
}

/**
 * Teardown for `seedPedidoFreteFixtures`. The marketplace fixture pedido is
 * seeded with a NON-null `freteInicial` already at `postado`, so the
 * `onPedidoChanged` trigger appends a `historicoFtIni` row for it — and,
 * because that same trigger records an opening row on create, a
 * `historicoEstadoPedido` row too. Both are swept BEFORE
 * `cleanupPedidoFixtures` deletes the parents, which never cascades.
 * (The pedidos this suite creates through `/pedidos/novo` mint a counter
 * `numero` without the run prefix, so no prefix sweep has ever reached them —
 * pre-existing, and the reason this pass is scoped by `numero` like the rest.)
 */
export async function cleanupPedidoFreteFixtures(prefix: string): Promise<void> {
  await cleanupEnderecos(`${prefix}-cli-001`);
  await cleanupPedidoSubcollectionByPrefix('historicoFtIni', prefix);
  await cleanupPedidoSubcollectionByPrefix('historicoEstadoPedido', prefix);
  await Promise.all([
    cleanupPedidoFixtures(prefix),
    cleanupByNamePrefix('int_frete', prefix),
    // The ML conta seeded alongside the marketplace freight doc (#782).
    cleanupByNamePrefix('integracao', prefix),
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
  await seedNfeForPedido(pedidoId, nfeId, { estado });
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
 * Seed one `nfev4` doc under an EXISTING pedido — the same wire body
 * `seedPedidoWithNFe` writes (that helper couples the NF-e to its own pedido
 * seed), so a spec can attach an NF-e at any estado/chave/numeração to an
 * already-seeded pedido (e.g. an APROVADA NF-e whose chave the devolução flows
 * must carry into `chNFeReferenciadas`).
 */
export async function seedNfeForPedido(
  pedidoId: string,
  nfeId: string,
  opts: { estado: string; chave?: string | null; numeracao?: number },
): Promise<void> {
  const now = Date.now();
  await db()
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(nfeId)
    .set({
      numeracao: opts.numeracao ?? 1,
      serie: 1,
      tpEmis: 1,
      estado: opts.estado,
      chave: opts.chave ?? null,
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
}

/**
 * Sweep the devolução graph linked to an origin pedido: every devolução whose
 * `saidasRelacionadas` contains `originId`, and every troca saída linked to
 * each of those devoluções (skipping the origin itself). Query-based on the
 * link fields — these docs mint counter numeros (no run prefix in `numero`),
 * so a prefix sweep can't find them. Covers every retry attempt of a spec.
 */
export async function cleanupDevolucoesLinkedTo(originId: string): Promise<void> {
  const devolucoes = await db()
    .collection('pedidos')
    .where('saidasRelacionadas', 'array-contains', originId)
    .get();
  for (const dev of devolucoes.docs) {
    const saidas = await db()
      .collection('pedidos')
      .where('entradasRelacionadas', 'array-contains', dev.id)
      .get();
    for (const saida of saidas.docs) {
      if (saida.id !== originId) await saida.ref.delete();
    }
    await dev.ref.delete();
  }
}

/**
 * Point an integração's `operacaoDevolucaoOuterRef` at an operação (the
 * Flutter-ODM `documents/…` doc-path string), so the devolução flows resolve
 * a deterministic operação instead of the shared-staging entrada default.
 */
export async function linkIntegracaoOperacaoDevolucao(
  integracaoId: string,
  operacaoId: string,
): Promise<void> {
  await db()
    .collection('integracao')
    .doc(integracaoId)
    .update({ operacaoDevolucaoOuterRef: `documents/operacao/${operacaoId}` });
}

/**
 * Delete every doc of one pedido subcollection (Firestore never cascades) —
 * the pedido counterpart of `cleanupProdutoSubcollection`, for the `nfev4` /
 * `incidentes` docs the devolução flows seed or write on an origin pedido.
 */
export async function cleanupPedidoSubcollection(
  pedidoId: string,
  subcollection: string,
): Promise<void> {
  const snap = await db().collection('pedidos').doc(pedidoId).collection(subcollection).get();
  if (snap.empty) return;
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

/**
 * Sweep one subcollection off EVERY pedido whose `numero` starts with `prefix`
 * — for the trigger-written trails (`historicoEstadoPedido`, `historicoFtIni`)
 * a teardown cannot enumerate by hand: the rows appear asynchronously, on
 * whichever pedidos the run happened to touch. Same prefix range the parent
 * sweep uses, so it reaches exactly the docs `cleanupPedidoFixtures` is about
 * to delete — and it must run BEFORE that, or the rows outlive their parent.
 */
async function cleanupPedidoSubcollectionByPrefix(
  subcollection: string,
  prefix: string,
): Promise<void> {
  const snap = await db()
    .collection('pedidos')
    .where('numero', '>=', prefix)
    .where('numero', '<', `${prefix}${PREFIX_MAX}`)
    .get();
  await Promise.all(snap.docs.map((d) => cleanupPedidoSubcollection(d.id, subcollection)));
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
      ultimaModificacao: Date.now(),
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
    ultimaModificacao: Date.now(),
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
    ultimaModificacao: Date.now(),
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
      ultimaModificacao: Date.now(),
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
      ultimaModificacao: Date.now(),
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
    ultimaModificacao: Date.now(),
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
    ultimaModificacao: Date.now(),
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
    // The conta-link denorm the bulk stock push reads to decide which channels
    // a selection touches (#819). Without it the produto looks unlinked and the
    // dialog reports "Produto não tem integrações".
    integracoesComProduto: [integracaoId],
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
 * Seed a produto published as a **User-Products FAMILY** (#1142): a parent link
 * whose `id` is ML's numeric family key, plus one `variacaoMercadoLivre` member
 * per variation — each with its own `itemId` and its own raw ML status, which is
 * where a family's real state lives.
 *
 * ⚠️ The member links go under the PARENT produto here, not under variation
 * children. Publish writes them under each child, but the editor reads them by
 * `produtoMercadoLivreOuterRef` through a collection-group query, so the parent
 * is a valid — and much cheaper — place to seed them: no child produtos to
 * create, and none to sweep afterwards. The one thing that must be faithful is
 * the ref, because that is the key the query matches on.
 *
 * The statuses are deliberately DIFFERENT from each other and from the parent's,
 * so an assertion cannot pass by reading the family summary instead of the
 * member rows.
 */
export async function seedProdutoMlFamilia(
  prefix: string,
  integracaoId: string,
): Promise<{
  produtoId: string;
  familyId: string;
  membros: Array<{ itemId: string; cor: string }>;
}> {
  const produtoId = `${prefix}-familia`;
  const familyId = '6264141844942250';
  const membros = [
    { itemId: 'MLB4000000001', cor: 'Azul', status: 'active', sub: [] as string[] },
    { itemId: 'MLB4000000002', cor: 'Verde', status: 'paused', sub: ['out_of_stock'] },
  ];
  const now = Date.now();
  const batch = db().batch();
  batch.set(db().collection('produtos').doc(produtoId), {
    ultimaModificacao: now,
    nome: produtoId,
    sku: `${prefix.toUpperCase().replace(/-/g, '_')}_FAM`,
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
    integracoesComProduto: [integracaoId],
  });
  batch.set(
    db().collection('produtos').doc(produtoId).collection('produtoMercadoLivre').doc(familyId),
    {
      contaOuterRef: `documents/integracao/${integracaoId}`,
      channels: ['marketplace'],
      estado: 'p',
      // ⚠️ The FAMILY id, not an item id — that is the shape that made a
      // member's status unreachable before #1142.
      id: familyId,
      sku: null,
      descricao: null,
      site_id: 'MLB',
      title: produtoId,
      category_id: 'MLB31447',
      condition: 'new',
      listing_type_id: 'gold_special',
      crossdocking: 0,
      freteGratis: false,
      precoPublicado: 79.9,
      tarifaFrete: null,
      comissao: null,
      isUserProductModel: true,
      video_id: null,
      attributes: null,
      errors: null,
      status: 'active',
      sub_status: [],
      ultimaModificacao: now,
      dataCadastro: now,
    },
  );
  for (const m of membros) {
    batch.set(
      db().collection('produtos').doc(produtoId).collection('variacaoMercadoLivre').doc(m.itemId),
      {
        id: null,
        itemId: m.itemId,
        userProductId: null,
        contaOuterRef: `documents/integracao/${integracaoId}`,
        produtoVariacaoOuterRef: `documents/produtos/${produtoId}`,
        produtoMercadoLivreOuterRef: `documents/produtos/${produtoId}/produtoMercadoLivre/${familyId}`,
        sku: `${m.itemId}-SKU`,
        attributes: [{ id: 'COLOR', name: 'Cor', value_name: m.cor }],
        status: m.status,
        sub_status: m.sub,
        moderacoes: null,
      },
    );
  }
  await batch.commit();
  return { produtoId, familyId, membros: membros.map((m) => ({ itemId: m.itemId, cor: m.cor })) };
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

/**
 * Patch arbitrary fields on an existing produto doc via a raw Admin `update`
 * (bypasses the collection's Zod-parsing handle, same as every other
 * Admin-seeded write in this file) — for fixture setup the real editor UI
 * has no field for yet (`propagatePriceToChildren`) or that must land on a
 * produto without going through it (a variation child's `precos`, to prove
 * the child never gets its own price history).
 */
export async function setProdutoFields(
  produtoId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db().collection('produtos').doc(produtoId).update(patch);
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
 * Seed an OPEN balanço over `depositoId`. Open is `estado: null` — the workflow
 * lock is server-owned and has no stored "aberto" value.
 */
export async function seedBalancoAberto(
  prefix: string,
  depositoId: string,
): Promise<{ id: string; nome: string }> {
  const nome = `${prefix}-contagem`;
  const ref = await db()
    .collection('balanco')
    .add({
      nome,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      estado: null,
      dataFinalizado: null,
      finalizacao: null,
      timestamp: Date.now(),
      ultimaModificacao: Date.now(),
    });
  return { id: ref.id, nome };
}

/** The raw balanço doc, or null. */
export async function getBalanco(balancoId: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection('balanco').doc(balancoId).get();
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

/** Every `movimentos` doc of a balanço, raw wire data. */
export async function listMovimentosBalanco(
  balancoId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db().collection('balanco').doc(balancoId).collection('movimentos').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/** The finalize snapshot, flattened across shards: produtoId → report item. */
export async function getRelatorioBalanco(
  balancoId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const snap = await db().collection('balanco').doc(balancoId).collection('relatorios').get();
  const itens: Record<string, Record<string, unknown>> = {};
  for (const doc of snap.docs) {
    Object.assign(itens, (doc.data() as { itens?: Record<string, never> }).itens ?? {});
  }
  return itens;
}

/**
 * Delete a balanço and its two subcollections. `onBalancoDeleted` would sweep
 * them, but teardown must not depend on a trigger being deployed.
 */
export async function cleanupBalanco(balancoId: string): Promise<void> {
  const ref = db().collection('balanco').doc(balancoId);
  for (const sub of ['movimentos', 'relatorios']) {
    const docs = await ref.collection(sub).get();
    if (docs.empty) continue;
    const batch = db().batch();
    docs.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await ref.delete();
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

/**
 * All `historicoDeModificacoes` docs of a produto (unsorted, raw wire data) —
 * the unified modification-history entries `onProdutoChanged` writes, one per
 * produto write, each recording only the top-level fields that changed.
 */
export async function listHistoricoModificacoes(
  produtoId: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db()
    .collection('produtos')
    .doc(produtoId)
    .collection('historicoDeModificacoes')
    .get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
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

/* -------------------------------------------------------------------------- */
/*        Despacho — Checkout screen fixtures (PR 8, e2e vendas suite)         */
/* -------------------------------------------------------------------------- */

/** A produtos doc shaped like the other pedido fixtures (converter-parseable). */
function checkoutProdutoDoc(nome: string, sku: string, ehKit = false) {
  return {
    ultimaModificacao: Date.now(),
    nome,
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
    ehKit,
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
  };
}

/** One flattened `pedido.itens` line entry (mirrors `seedPedidoImpressaoFixtures`). */
function checkoutItem(produtoId: string, sku: string, nome: string, ordem: number) {
  return {
    produtoUid: produtoId,
    ordem,
    ensureUniqueId: null,
    mktplaceId: null,
    sku,
    gtin: null,
    nomeDeVenda: nome,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
  };
}

/**
 * A `freteInicial` block in the Flutter wire shape (mirrors the marketplace
 * frete in `seedPedidoFreteFixtures`). `estado` is seeded inside the
 * `ALLOWED_FRETE_ESTADOS` set the save gate accepts (`emSeparacao`), so Salvar
 * never trips the "frete não está em Despacho autorizado…" confirm dialog; the
 * transaction then flips it to `checkFinalizado`. `printLabelId` +
 * `integracaoFreteOuterRef` are only set for the Melhor Envio reprint pedidos.
 */
function checkoutFrete(opts: {
  printLabelId?: string | null;
  integracaoFreteOuterRef?: string | null;
}) {
  return {
    externalId: null,
    printLabelId: opts.printLabelId ?? null,
    externalOptionId: null,
    externalOptionIntegracao: null,
    externalOptionData: null,
    estado: 'emSeparacao',
    integracaoFreteOuterRef: opts.integracaoFreteOuterRef ?? null,
    modalidade: '0',
    codRastreio: null,
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
  };
}

export interface CheckoutFixtures {
  clienteId: string;
  integracaoId: string;
  /** the Melhor Envio `int_frete` the reprint pedidos (A/B) point their frete at. */
  intFreteMelId: string;
  /** the shared single-line produto used by the happy / wrong / A / B pedidos. */
  lineProdutoId: string;
  lineSku: string;
  /** a valid produto NOT on any pedido — scanned in the wrong-product test. */
  extraProdutoId: string;
  extraSku: string;
  /** happy-path pedido (1 line). */
  happyId: string;
  happyNumero: string;
  /** kit pedido (1 whole-kit line) + its component/kit skus. */
  kitPedidoId: string;
  kitPedidoNumero: string;
  kitId: string;
  kitSku: string;
  componentId: string;
  /** wrong-product pedido (1 line; scanning the extra produto errors). */
  wrongId: string;
  wrongNumero: string;
  /** the two Melhor Envio pedidos for the wrong-label reprint regression. */
  pedidoAId: string;
  pedidoANumero: string;
  labelA: string;
  pedidoBId: string;
  pedidoBNumero: string;
  labelB: string;
  /** 120-line bulk pedido + every line's sku, in ordem order. */
  bulkId: string;
  bulkNumero: string;
  bulkSkus: string[];
  /** every pedido id the suite checks out (for `checkout` subcollection cleanup). */
  checkoutPedidoIds: string[];
}

/**
 * Fixtures for the despacho/checkout screen e2e (`despacho-checkout.vendas`).
 *
 * Seeds one cliente + integração, one Melhor Envio `int_frete`, the produtos the
 * five tests scan, and six saída pedidos — all `estado: 'pago'` with a non-null
 * `freteInicial` in an allowed estado so Salvar reaches the transaction:
 *
 *  - happy:  1 line (`lineProduto`), no frete integração.
 *  - kit:    1 whole-kit line; the kit + its component exist as their own
 *            produto docs (the checkout loads components in a wave-2 fetch).
 *  - wrong:  1 line; plus an `extraProduto` NOT on the pedido to scan.
 *  - A / B:  1 line each; frete points at the Melhor Envio `int_frete` and
 *            carries a DISTINCT `printLabelId` (`…-LABEL-A` / `…-LABEL-B`). The
 *            `/imprimir` payload has no pedidoId, so the label id IS the pedido
 *            identity the wrong-label regression asserts on.
 *  - bulk:   120 distinct single-unit lines (the real Firestore load path).
 */
export async function seedCheckoutFixtures(prefix: string): Promise<CheckoutFixtures> {
  const UP = prefix.toUpperCase().replace(/-/g, '_');
  const now = Date.now();
  const nowMicros = millisToMicros(now);

  const clienteId = `${prefix}-cli`;
  const integracaoId = `${prefix}-int`;
  const intFreteMelId = `${prefix}-me`;

  const lineProdutoId = `${prefix}-pro`;
  const lineSku = `${UP}_PRO`;
  const extraProdutoId = `${prefix}-extra`;
  const extraSku = `${UP}_EXTRA`;

  // Kit produtos: reuse the shared kit helpers so the component exists as its
  // own doc (the checkout's wave-2 fetch loads it) and the kit carries the
  // `componentesKit` map + `componentesKitKeys` the engine reads.
  const component = await seedComponenteKit(prefix, 10, 'kitcomp');
  const kit = await seedKitReferencing(prefix, component.id);
  const kitSku = `${UP}_KIT`;

  const happyId = `${prefix}-h`;
  const kitPedidoId = `${prefix}-kp`;
  const wrongId = `${prefix}-w`;
  const pedidoAId = `${prefix}-pa`;
  const pedidoBId = `${prefix}-pb`;
  const bulkId = `${prefix}-bulk`;
  const labelA = `${prefix}-LABEL-A`;
  const labelB = `${prefix}-LABEL-B`;

  const bulkSkus = Array.from({ length: 120 }, (_, i) => `${UP}_B_${pad(i + 1)}`);

  // Shared pedido scaffold (differs per pedido only in numero + itens + frete).
  const pedidoBase = {
    ehSaida: true,
    estado: 'pago', // save gate ESTADO_PEDIDO_PAGO
    descontoTotal: 0,
    valorCobrado: 10,
    timestamp: nowMicros,
    ultimaModificacao: nowMicros,
    estoqueAplicado: null,
    dataIndisponivelEstoque: null,
    dataRemocaoEstoque: null,
    foiImpresso: false,
    dtImpressao: null,
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
    cpf_cnpj: fixtureClienteCnpj(),
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

  // Melhor Envio int_frete — reprintCheckoutEtiqueta dereferences this via the
  // pedido's `integracaoFreteOuterRef` (a RAW getDoc: only `tipo` is read), then
  // dispatches to the melhorEnvios provider which POSTs `/imprimir`.
  batch.set(db().collection('int_frete').doc(intFreteMelId), {
    tipo: 'melhorEnvios',
    nome: intFreteMelId,
    ativo: true,
    filialIntegracaoFreteOuterRef: null,
    enderecoDeOrigem: null,
    dataCadastro: now,
    mapa: null,
    faixaCep: null,
    horarioDeCorte: null,
    prazoExtra: 0,
    client_id: null,
    client_secret: null,
  });

  // Produtos: the shared line produto + the unexpected extra produto. (The kit +
  // component were already committed above by the kit helpers.)
  batch.set(
    db().collection('produtos').doc(lineProdutoId),
    checkoutProdutoDoc(lineProdutoId, lineSku),
  );
  batch.set(
    db().collection('produtos').doc(extraProdutoId),
    checkoutProdutoDoc(extraProdutoId, extraSku),
  );
  // Stamp the kit produto's own SKU so a whole-kit scan resolves by SKU.
  batch.update(db().collection('produtos').doc(kit.kitId), { sku: kitSku });

  // 120 bulk produtos.
  bulkSkus.forEach((sku, i) => {
    const id = `${bulkId}-p${pad(i + 1)}`;
    batch.set(db().collection('produtos').doc(id), checkoutProdutoDoc(id, sku));
  });

  // Pedidos --------------------------------------------------------------------
  const oneLine = (produtoId: string, sku: string) => ({
    itens: { [produtoId]: [checkoutItem(produtoId, sku, produtoId, 1)] },
    itensIds: [produtoId],
  });

  batch.set(db().collection('pedidos').doc(happyId), {
    ...pedidoBase,
    numero: happyId,
    ...oneLine(lineProdutoId, lineSku),
    freteInicial: checkoutFrete({}),
  });
  batch.set(db().collection('pedidos').doc(kitPedidoId), {
    ...pedidoBase,
    numero: kitPedidoId,
    ...oneLine(kit.kitId, kitSku),
    freteInicial: checkoutFrete({}),
  });
  batch.set(db().collection('pedidos').doc(wrongId), {
    ...pedidoBase,
    numero: wrongId,
    ...oneLine(lineProdutoId, lineSku),
    freteInicial: checkoutFrete({}),
  });
  batch.set(db().collection('pedidos').doc(pedidoAId), {
    ...pedidoBase,
    numero: pedidoAId,
    ...oneLine(lineProdutoId, lineSku),
    freteInicial: checkoutFrete({
      printLabelId: labelA,
      integracaoFreteOuterRef: `documents/int_frete/${intFreteMelId}`,
    }),
  });
  batch.set(db().collection('pedidos').doc(pedidoBId), {
    ...pedidoBase,
    numero: pedidoBId,
    ...oneLine(lineProdutoId, lineSku),
    freteInicial: checkoutFrete({
      printLabelId: labelB,
      integracaoFreteOuterRef: `documents/int_frete/${intFreteMelId}`,
    }),
  });

  // 120-line bulk pedido.
  const bulkItens: Record<string, unknown[]> = {};
  const bulkItensIds: string[] = [];
  bulkSkus.forEach((sku, i) => {
    const id = `${bulkId}-p${pad(i + 1)}`;
    bulkItens[id] = [checkoutItem(id, sku, id, i + 1)];
    bulkItensIds.push(id);
  });
  batch.set(db().collection('pedidos').doc(bulkId), {
    ...pedidoBase,
    numero: bulkId,
    itens: bulkItens,
    itensIds: bulkItensIds,
    freteInicial: checkoutFrete({}),
  });

  await batch.commit();

  return {
    clienteId,
    integracaoId,
    intFreteMelId,
    lineProdutoId,
    lineSku,
    extraProdutoId,
    extraSku,
    happyId,
    happyNumero: happyId,
    kitPedidoId,
    kitPedidoNumero: kitPedidoId,
    kitId: kit.kitId,
    kitSku,
    componentId: component.id,
    wrongId,
    wrongNumero: wrongId,
    pedidoAId,
    pedidoANumero: pedidoAId,
    labelA,
    pedidoBId,
    pedidoBNumero: pedidoBId,
    labelB,
    bulkId,
    bulkNumero: bulkId,
    bulkSkus,
    checkoutPedidoIds: [happyId, kitPedidoId, wrongId, pedidoAId, pedidoBId, bulkId],
  };
}

/**
 * Teardown for `seedCheckoutFixtures`. Firestore never cascades, so every
 * pedido that was checked out must have its subcollections swept BEFORE the
 * parent pedido sweep (`cleanupPedidoFixtures` deletes the pedido doc but not
 * its subcollections). Three of them:
 *  - `checkout`, one doc per conference;
 *  - `historicoFtIni` — every fixture pedido here is seeded with a NON-null
 *    `freteInicial` (`checkoutFrete`, estado `emSeparacao`) and `saveCheckout`
 *    drives it to `checkFinalizado` on EVERY conference, so
 *    `onPedidoChanged` appends a freight-audit row per pedido per run;
 *  - `historicoEstadoPedido` — the SAME trigger records an opening row on
 *    create, and every fixture pedido here is seeded at `pago`, so each run
 *    also mints one estado row per pedido. Leaking since #697; swept here
 *    because it is the identical failure and one line from the frete sweep.
 * Also sweeps the Melhor Envio `int_frete`.
 */
export async function cleanupCheckoutFixtures(prefix: string, pedidoIds: string[]): Promise<void> {
  await Promise.all(
    pedidoIds.flatMap((id) => [
      cleanupPedidoSubcollection(id, 'checkout'),
      cleanupPedidoSubcollection(id, 'historicoFtIni'),
      cleanupPedidoSubcollection(id, 'historicoEstadoPedido'),
    ]),
  );
  await Promise.all([cleanupPedidoFixtures(prefix), cleanupIntFreteFixtures(prefix)]);
}

/* -------------------------------------------------------------------------- */
/*     Pedidos — Download Anexos bulk action fixtures (#550)                  */
/* -------------------------------------------------------------------------- */

/**
 * Fixtures for the bulk "Download Anexos" action:
 *  - parent produto with one `anexos` entry pointing at a seeded `arquivos` doc
 *  - variation child (`paiId` = parent) with no own anexos
 *  - product with no anexos
 *  - pedido whose line points at the **variation** (forces parent fallback)
 *  - pedido whose product has no anexos (empty path)
 *
 * The arquivo `url` is a deterministic HTTPS placeholder; e2e specs `page.route`
 * it so Playwright never needs a real Storage object / CORS round-trip.
 */
export async function seedPedidoAnexosFixtures(prefix: string): Promise<{
  parentProdutoId: string;
  variationProdutoId: string;
  noAnexoProdutoId: string;
  arquivoId: string;
  arquivoUrl: string;
  arquivoFileName: string;
  withAnexoPedidoId: string;
  withAnexoNumero: string;
  noAnexoPedidoId: string;
  noAnexoNumero: string;
  clienteId: string;
  integracaoId: string;
}> {
  const clienteId = `${prefix}-cli-001`;
  const integracaoId = `${prefix}-int-001`;
  const parentProdutoId = `${prefix}-pro-parent`;
  const variationProdutoId = `${prefix}-pro-var`;
  const noAnexoProdutoId = `${prefix}-pro-empty`;
  const arquivoId = `${prefix}-arq-001`;
  const arquivoUrl = `https://e2e-anexo.invalid/${prefix}/manual.pdf`;
  const arquivoFileName = `${prefix}-manual.pdf`;
  const withAnexoPedidoId = `${prefix}-ped-anexo`;
  const noAnexoPedidoId = `${prefix}-ped-empty`;
  const now = Date.now();
  const nowMicros = millisToMicros(now);
  const skuParent = `${prefix.toUpperCase().replace(/-/g, '_')}_PAR`;
  const skuVar = `${prefix.toUpperCase().replace(/-/g, '_')}_VAR`;
  const skuEmpty = `${prefix.toUpperCase().replace(/-/g, '_')}_EMP`;

  const item = (produtoId: string, sku: string) => ({
    produtoUid: produtoId,
    ordem: 1,
    ensureUniqueId: null,
    mktplaceId: null,
    sku,
    gtin: null,
    nomeDeVenda: produtoId,
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
  });

  const pedidoBody = (produtoId: string, sku: string, numero: string) => ({
    ehSaida: true,
    estado: 'iniciado',
    numero,
    itens: { [produtoId]: [item(produtoId, sku)] },
    itensIds: [produtoId],
    descontoTotal: 0,
    valorCobrado: 10,
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
    foiImpresso: false,
    dtImpressao: null,
  });

  const produtoBody = (nome: string, sku: string, extra: Record<string, unknown> = {}) => ({
    ultimaModificacao: Date.now(),
    nome,
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
    ...extra,
  });

  const batch = db().batch();
  batch.set(db().collection('clientes').doc(clienteId), {
    tipo: '1',
    nome: clienteId,
    cpf_cnpj: fixtureClienteCnpj(),
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
    tipo: 7,
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
  batch.set(db().collection('arquivos').doc(arquivoId), {
    filetype: 'document',
    filepath: `produtos/${parentProdutoId}/anexos`,
    filename: `${arquivoId}.pdf`,
    originalFilename: arquivoFileName,
    contentType: 'application/pdf',
    url: arquivoUrl,
    externalIds: [],
    criadoEm: nowMicros,
    resizeState: null,
    uploadState: 'finalized',
    markedForDeletionAt: null,
  });
  batch.set(
    db().collection('produtos').doc(parentProdutoId),
    produtoBody(parentProdutoId, skuParent, {
      anexos: [{ arquivoOuterRef: `arquivos/${arquivoId}` }],
    }),
  );
  batch.set(
    db().collection('produtos').doc(variationProdutoId),
    produtoBody(variationProdutoId, skuVar, {
      paiId: parentProdutoId,
      anexos: null,
    }),
  );
  batch.set(
    db().collection('produtos').doc(noAnexoProdutoId),
    produtoBody(noAnexoProdutoId, skuEmpty, { anexos: null }),
  );
  batch.set(
    db().collection('pedidos').doc(withAnexoPedidoId),
    pedidoBody(variationProdutoId, skuVar, withAnexoPedidoId),
  );
  batch.set(
    db().collection('pedidos').doc(noAnexoPedidoId),
    pedidoBody(noAnexoProdutoId, skuEmpty, noAnexoPedidoId),
  );
  await batch.commit();

  return {
    parentProdutoId,
    variationProdutoId,
    noAnexoProdutoId,
    arquivoId,
    arquivoUrl,
    arquivoFileName,
    withAnexoPedidoId,
    withAnexoNumero: withAnexoPedidoId,
    noAnexoPedidoId,
    noAnexoNumero: noAnexoPedidoId,
    clienteId,
    integracaoId,
  };
}

/** Teardown for `seedPedidoAnexosFixtures`. */
export async function cleanupPedidoAnexosFixtures(
  prefix: string,
  arquivoId: string,
): Promise<void> {
  await db()
    .collection('arquivos')
    .doc(arquivoId)
    .delete()
    .catch(() => undefined);
  await cleanupPedidoFixtures(prefix);
}
