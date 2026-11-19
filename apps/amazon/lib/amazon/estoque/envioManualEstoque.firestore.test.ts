/**
 * The manual stock push on a REAL Firestore — the emulator of `ci-amazon.yml`,
 * not the in-memory fake (step 12, PR 12-g). The offline suite drives every rung
 * against `testing/fakeDb.ts`; this file runs the body IN-PROCESS on the real
 * server and proves what only holds if the server behaves as the fake says:
 *
 *  - ★ the masked conta read answers the three fields the gate reads (its
 *    depósito in either stored form), and a missing or inactive conta is a 404;
 *  - ★ the children seek (`paiId ==`, `orderBy(nome)`, keys only) returns the
 *    anchor's children and drops a child stored without `nome`, as the fake
 *    says; each member's PROJECTED partition listing still carries the conta
 *    ref and the SKU; the conta's links are found in BOTH stored ref forms, and
 *    another conta's are not;
 *  - ★ a selected variation child and a família-de-um member hop ONE level: the
 *    rows name the ANCHOR, with the anchor's stored name, and the tasks carry
 *    identities only, each NAMED by its own fields; a nome-less child the seek
 *    drops is still a member once SELECTED; a child whose parent has no
 *    document is answered under its own id, nothing enqueued;
 *  - ★ the 30-SKU switch on real reads: 31 distinct SKUs refuse the whole
 *    selection, nothing enqueued.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the queries'
 * SHAPE and results, never their cost — the children seek rides the declared
 * `produtos (paiId ASC, nome ASC)` composite, pinned offline.
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the body as `ambiente`, never `process.env` (the lane sets it `off`). The
 * body makes no Amazon call and binds no client. The producer is the REAL one
 * over a RECORDING queue: nothing is enqueued onto a queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-estoque-manual-`, which no other suite seeds; the
 * conta is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; `produtos` and their `prodAmazon` are no trigger path. Every case wipes
 * what it seeds first, and the file leaves nothing behind.
 *
 * PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_ESTOQUE_AMAZON,
  INTEGRACAO_TIPO,
  envioEstoqueManualAmazonSchema,
  erroEnvioEstoqueManualAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { caminhoConta, loggerEspiao } from '../testing/fixtures';
import {
  type DepsEnvioManualEstoqueAmazon,
  MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON,
  enviarEstoqueManualAmazon,
} from './envioManualEstoque';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import { type TarefaEstoqueAmazon, nomeDaTarefaEstoque } from './tarefaEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-manual-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const DEPOSITO = `documents/depositos/${P}dep`;
const REFERENCIA = `${P}req-1`;
const URL_ROTA = 'http://localhost:3011/api/marketplace/amazon/enviar-estoque';

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE = Object.freeze({ AMAZON_CHAMADAS: 'on' });

function db(): Firestore {
  return getAdminFirestore();
}

/** Every produto this file may seed, so each case starts clean and the file ends clean. */
const PRODUTOS = new Set<string>();

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${id}`));
  await db().doc(caminhoConta(CONTA)).delete();
}

/** An INCOMPLETE Amazon conta (no filial, no `dataCadastro`), fields over it. */
async function semearConta(over: Record<string, unknown> = {}): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste do envio manual de estoque',
      ativo: true,
      padrao: false,
      selling_partner_id: null,
      depositoOuterRef: DEPOSITO,
      ...over,
    });
}

async function produto(id: string, dados: Record<string, unknown> = {}): Promise<void> {
  PRODUTOS.add(`${P}${id}`);
  await db()
    .doc(`produtos/${P}${id}`)
    .set({ nome: `Produto ${id}`, ...dados });
}

/** A link doc on `dono`, carrying a payload no read returns. */
async function vinculo(dono: string, sku: string, conta = REF_CONTA): Promise<void> {
  await db()
    .doc(`produtos/${P}${dono}/prodAmazon/${P}l-${sku}`)
    .set({ contaAmazonOuterRef: conta, sku, productDataJson: { pesado: 'x'.repeat(256) } });
}

/** Task ids the recording queue holds, and every task it accepted. */
let idsNaFila = new Set<string>();
let enfileiradas: { tarefa: TarefaEstoqueAmazon; id: string | undefined }[] = [];

const produtor = criarProdutorEstoqueAmazon({
  desligado: false,
  fila: () => ({
    enqueue: (tarefa, extras) => {
      const id = extras?.id;
      if (id !== undefined && idsNaFila.has(id)) {
        return Promise.reject(falhaDeTarefaJaExistente(id));
      }
      if (id !== undefined) idsNaFila.add(id);
      enfileiradas.push({ tarefa, id });
      return Promise.resolve();
    },
  }),
});

const deps: DepsEnvioManualEstoqueAmazon = {
  ambiente: AMBIENTE,
  db,
  filaDesligada: false,
  regiao: () => 'xx-tarefas-1',
  produtor: () => produtor,
  agora: () => Date.now(),
  gerarReferencia: () => REFERENCIA,
  logger: loggerEspiao().logger,
};

function enviar(...produtoIds: string[]) {
  return enviarEstoqueManualAmazon(
    new Request(URL_ROTA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        integracaoId: CONTA,
        produtoIds: produtoIds.map((id) => `${P}${id}`),
      }),
    }),
    deps,
  );
}

async function ok(...produtoIds: string[]) {
  const r = await enviar(...produtoIds);
  expect(r.status).toBe(200);
  return envioEstoqueManualAmazonSchema.parse(r.corpo);
}

describe.skipIf(!EMULATED)('the manual stock push on real Firestore (emulator)', () => {
  beforeEach(async () => {
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
    idsNaFila = new Set();
    enfileiradas = [];
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ a family on the real server: the anchor’s and its children’s links in BOTH ref forms, another conta’s left out, a nome-less child dropped by the seek; ONE named task per SKU, identities only', async () => {
    await semearConta();
    await produto('ancora');
    await produto('filho-a', { paiId: `${P}ancora` });
    await produto('filho-b', { paiId: `${P}ancora` });
    // Outside the schema: a child with no `nome` (the index's order filters it).
    PRODUTOS.add(`${P}sem-nome`);
    await db()
      .doc(`produtos/${P}sem-nome`)
      .set({ paiId: `${P}ancora` });
    await vinculo('ancora', `${P}SKU-ANCORA`);
    await vinculo('filho-a', `${P}SKU-A`, REF_CONTA_NUA);
    await vinculo('filho-b', `${P}SKU-B`);
    await vinculo('filho-b', `${P}SKU-OUTRA`, `documents/integracao/${P}outra-conta`);
    await vinculo('sem-nome', `${P}SKU-SEM-NOME`);

    const corpo = await ok('ancora');
    expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
      [`${P}ancora`, `${P}SKU-A`, 'enviado'],
      [`${P}ancora`, `${P}SKU-ANCORA`, 'enviado'],
      [`${P}ancora`, `${P}SKU-B`, 'enviado'],
    ]);
    expect(corpo.produtosSemEnvio).toEqual([]);
    expect(enfileiradas.map((e) => e.tarefa)).toEqual(
      [`${P}SKU-A`, `${P}SKU-ANCORA`, `${P}SKU-B`].map((sku) => ({
        v: 1,
        contaId: CONTA,
        sku,
        origem: 'manual',
        referencia: REFERENCIA,
        depositoId: null,
      })),
    );
    for (const { tarefa, id } of enfileiradas) expect(id).toBe(nomeDaTarefaEstoque(tarefa));

    // ★ The nome-less child SELECTED is a member all the same: its masked read
    // on the server answers a document without `nome`, and the anchor's label
    // read names the rows.
    enfileiradas = [];
    idsNaFila = new Set();
    const doFilho = await ok('sem-nome');
    expect(doFilho.listings.map((l) => [l.produtoId, l.produtoNome, l.sku])).toEqual(
      [`${P}SKU-A`, `${P}SKU-ANCORA`, `${P}SKU-B`, `${P}SKU-SEM-NOME`].map((sku) => [
        `${P}ancora`,
        'Produto ancora',
        sku,
      ]),
    );
    expect(enfileiradas.map((e) => e.tarefa.sku)).toContain(`${P}SKU-SEM-NOME`);
  });

  it('★ a selected variation child and a família-de-um member each hop ONE level: the rows name the ANCHOR; a produto with no link is answered under its own id', async () => {
    await semearConta({ depositoOuterRef: `depositos/${P}dep` });
    await produto('ancora');
    await produto('filho', { paiId: `${P}ancora` });
    await vinculo('ancora', `${P}SKU-1`);
    await produto('embrulho', { ehFamiliaDeUm: true, filhoUnicoId: `${P}membro` });
    await produto('membro', { paiId: `${P}embrulho` });
    await vinculo('embrulho', `${P}SKU-EMB`);
    await produto('solto');

    const corpo = await ok('filho', 'membro', 'solto');
    expect(corpo.listings).toEqual([
      {
        produtoId: `${P}ancora`,
        produtoNome: 'Produto ancora',
        sku: `${P}SKU-1`,
        resultado: 'enviado',
        mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON.enfileirado,
      },
      {
        produtoId: `${P}embrulho`,
        produtoNome: 'Produto embrulho',
        sku: `${P}SKU-EMB`,
        resultado: 'enviado',
        mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON.enfileirado,
      },
    ]);
    expect(corpo.produtosSemEnvio).toEqual([
      {
        produtoId: `${P}solto`,
        produtoNome: 'Produto solto',
        mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON['sem-vinculo'],
      },
    ]);
    expect(enfileiradas).toHaveLength(2);
  });

  it('★ a selected child whose parent has NO document on the server ⇒ under its own id, nothing enqueued', async () => {
    await semearConta();
    await produto('orfao', { paiId: `${P}pai-sumido` });
    await vinculo('orfao', `${P}SKU-ORFAO`);
    const corpo = await ok('orfao');
    expect(corpo).toEqual({
      listings: [],
      produtosSemEnvio: [
        {
          produtoId: `${P}orfao`,
          produtoNome: 'Produto orfao',
          mensagem: MENSAGEM_ENVIO_MANUAL_ESTOQUE_AMAZON['pai-ausente'],
        },
      ],
      pausadoAte: null,
    });
    expect(enfileiradas).toEqual([]);
  });

  it('★ 31 distinct SKUs on real reads ⇒ the whole selection refused, NOTHING enqueued (NEAR-MISS: 30 go)', async () => {
    await semearConta();
    await produto('ancora');
    for (let i = 0; i < 30; i += 1)
      await vinculo('ancora', `${P}SKU-${String(i).padStart(2, '0')}`);
    const trinta = await ok('ancora');
    expect(trinta.listings).toHaveLength(30);
    expect(enfileiradas).toHaveLength(30);

    enfileiradas = [];
    idsNaFila = new Set();
    await vinculo('ancora', `${P}SKU-30`);
    const r = await enviar('ancora');
    expect(r.status).toBe(400);
    expect(erroEnvioEstoqueManualAmazonSchema.parse(r.corpo)).toMatchObject({
      code: CODIGO_ERRO_ESTOQUE_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    expect(enfileiradas).toEqual([]);
  });

  // (That nothing past the conta is read on these arms is pinned offline.)
  it('★ the masked conta read on the server: a missing or inactive conta is a 404, a conta with no depósito a 400 — nothing enqueued', async () => {
    await produto('p1');
    await vinculo('p1', `${P}SKU-1`);
    const semConta = await enviar('p1');
    expect(semConta.status).toBe(404);

    await semearConta({ ativo: false });
    const inativa = await enviar('p1');
    expect(erroEnvioEstoqueManualAmazonSchema.parse(inativa.corpo).code).toBe(
      CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_NAO_ENCONTRADA,
    );

    await semearConta({ depositoOuterRef: null });
    const semDeposito = await enviar('p1');
    expect(semDeposito.status).toBe(400);
    expect(erroEnvioEstoqueManualAmazonSchema.parse(semDeposito.corpo).code).toBe(
      CODIGO_ERRO_ESTOQUE_AMAZON.CONTA_SEM_DEPOSITO,
    );
    expect(enfileiradas).toEqual([]);
  });
});
