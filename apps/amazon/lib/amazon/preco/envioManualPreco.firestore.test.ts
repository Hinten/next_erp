/**
 * The four price routes' bodies on a REAL Firestore — the emulator of
 * `ci-amazon.yml`, not the in-memory fake (step 13, PR 13-g). The offline suite
 * drives every step against `testing/fakeDb.ts`; this file runs the bodies
 * IN-PROCESS on the real server and proves what only holds if the server
 * behaves as the fake says:
 *
 *  - ★ the masked conta read answers the gate's fields and the normal tabela
 *    in either stored ref form, and a conta whose normal tabela ref names
 *    another collection is refused, nothing enqueued (the offline suite counts
 *    the reads: none of the selection);
 *  - ★ the manual push's selection on real reads: the anchor's and its
 *    children's links in BOTH conta ref forms, another conta's left out, a
 *    child the seek drops (no `nome`) not reached; ONE named price task per
 *    SENDABLE SKU, identities, the consent and the request's clock only; a SKU
 *    outside the task's target grammar `pulado`; 31 sendable SKUs refuse the
 *    whole selection, nothing enqueued;
 *  - ★ the run routes on the real server: the start CREATES the run (the
 *    caller as `solicitadaPor`), a second click answers 409 with its id and
 *    leaves the server's commit unmoved, the status reads it under masks the
 *    SERVER projects, the cancel lands `cancelada` on the server, and with no
 *    run the status and the cancel answer 404; the queue valve closed claims
 *    nothing on the server.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the queries'
 * SHAPE and results, never their cost (the children seek rides the declared
 * `produtos (paiId ASC, nome ASC)` composite, pinned offline).
 *
 * ⚠️ D11. The read switch is ON in exactly one place: the object literal handed
 * to the bodies as `ambiente`, never `process.env` (the lane sets it `off`). No
 * body makes an Amazon call or binds a client. The producers are the REAL ones
 * over RECORDING queues: nothing is enqueued onto a queue the lane dispatches.
 *
 * ⚠️ The emulator is SHARED (`vitest.tasks.config.ts`'s rules): every document
 * id here starts with `e2e-preco-envio-`, which no other suite seeds; the conta
 * is INCOMPLETE (no filial, no `dataCadastro`), so the conta trigger only
 * reads; `produtos`, their `prodAmazon`, the run and the lease are no trigger
 * path. Every case wipes what it seeds first, and the file leaves nothing
 * behind. PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_PRECO_AMAZON,
  INTEGRACAO_TIPO,
  envioPrecoManualAmazonSchema,
  erroPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import type { OpcoesDaTarefaListingAmazon } from '../listings/produtorListing';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import { caminhoConta, loggerEspiao } from '../testing/fixtures';
import {
  type DepsConsultaAtualizacaoPrecosAmazon,
  type DepsEnvioManualPrecoAmazon,
  type DepsInicioAtualizacaoPrecosAmazon,
  MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON,
  cancelarAtualizacaoPrecosAmazon,
  enviarPrecoManualAmazon,
  iniciarAtualizacaoPrecosAmazon,
  resumoAtualizacaoPrecosAmazon,
} from './envioManualPreco';
import { criarProdutorExecucaoPrecoAmazon } from './inicioExecucaoPreco';
import { criarProdutorPrecoAmazon } from './produtorPreco';
import {
  type TarefaPaginaPrecoAmazon,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  nomePaginaPrecoAmazon,
} from './tarefaPreco';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-preco-envio-';
/** The conta of this file — an id no other suite seeds. */
const CONTA = `${P}conta`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_CONTA_NUA = `integracao/${CONTA}`;
const RUN = `precosAmazon/${CONTA}`;
const VEZ = `feedsAmazonEmCurso/preco-${CONTA}`;
const REFERENCIA = `${P}req-1`;
const UID = `${P}uid`;
const BASE = 'http://localhost:3011/api/marketplace/amazon';

/** The ONE place the switch is on: an object literal (module header). */
const AMBIENTE = Object.freeze({ AMAZON_CHAMADAS: 'on' });

function db(): Firestore {
  return getAdminFirestore();
}

/** Every produto this file may seed, so each case starts clean and the file ends clean. */
const PRODUTOS = new Set<string>();

async function limpar(): Promise<void> {
  for (const id of PRODUTOS) await db().recursiveDelete(db().doc(`produtos/${id}`));
  await db().recursiveDelete(db().doc(RUN));
  await db().doc(VEZ).delete();
  await db().doc(caminhoConta(CONTA)).delete();
}

/** An INCOMPLETE Amazon conta (no filial, no `dataCadastro`), fields over it. */
async function semearConta(over: Record<string, unknown> = {}): Promise<void> {
  await db()
    .doc(caminhoConta(CONTA))
    .set({
      tipo: INTEGRACAO_TIPO.amazon,
      nome: 'Conta de teste do envio de preço',
      ativo: true,
      padrao: false,
      selling_partner_id: null,
      tabelaNormalOuterRef: `documents/listaDePrecos/${P}tabela`,
      ...over,
    });
}

async function produto(id: string, dados: Record<string, unknown> = {}): Promise<void> {
  PRODUTOS.add(`${P}${id}`);
  await db()
    .doc(`produtos/${P}${id}`)
    .set({
      nome: `Produto ${id}`,
      precos: { [`${P}tabela`]: { valor: 123.45 } },
      ...dados,
    });
}

/** A link doc on `dono`, carrying a payload no read returns. */
async function vinculo(dono: string, sku: string, conta = REF_CONTA, id = sku): Promise<void> {
  await db()
    .doc(`produtos/${P}${dono}/prodAmazon/${P}l-${id}`)
    .set({ contaAmazonOuterRef: conta, sku, productDataJson: { pesado: 'x'.repeat(256) } });
}

/** A queue that records every enqueue and, like Cloud Tasks, refuses a held name. */
function filaGravadora<T>() {
  const ids = new Set<string>();
  const enfileiradas: { tarefa: T; opcoes: OpcoesDaTarefaListingAmazon | undefined }[] = [];
  return {
    enfileiradas,
    fila: {
      enqueue: (tarefa: T, opcoes?: OpcoesDaTarefaListingAmazon): Promise<void> => {
        if (opcoes?.id !== undefined) {
          if (ids.has(opcoes.id)) return Promise.reject(falhaDeTarefaJaExistente(opcoes.id));
          ids.add(opcoes.id);
        }
        enfileiradas.push({ tarefa, opcoes });
        return Promise.resolve();
      },
    },
  };
}

let filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
let filaPaginas = filaGravadora<TarefaPaginaPrecoAmazon>();
let relogio = Date.now();

const depsManual = (): DepsEnvioManualPrecoAmazon => ({
  ambiente: AMBIENTE,
  db,
  filaDesligada: false,
  regiao: () => 'xx-tarefas-1',
  produtor: () => criarProdutorPrecoAmazon({ fila: () => filaPreco.fila, desligado: false }),
  agora: () => relogio,
  gerarReferencia: () => REFERENCIA,
  logger: loggerEspiao().logger,
});

const depsInicio = (filaDesligada = false): DepsInicioAtualizacaoPrecosAmazon => ({
  ambiente: AMBIENTE,
  db,
  filaDesligada,
  regiao: () => 'xx-tarefas-1',
  produtor: () =>
    criarProdutorExecucaoPrecoAmazon({ fila: () => filaPaginas.fila, desligado: false }),
  agora: () => relogio,
  gerarExecucaoId: () => `${P}exec-${String(relogio)}`,
  logger: loggerEspiao().logger,
});

const depsConsulta = (): DepsConsultaAtualizacaoPrecosAmazon => ({
  ambiente: AMBIENTE,
  db,
  agora: () => relogio,
  logger: loggerEspiao().logger,
});

function post(caminho: string, corpo: unknown): Request {
  return new Request(`${BASE}/${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function enviar(...produtoIds: string[]) {
  return enviarPrecoManualAmazon(
    post('enviar-precos', {
      integracaoId: CONTA,
      produtoIds: produtoIds.map((id) => `${P}${id}`),
    }),
    depsManual(),
  );
}

const iniciar = (filaDesligada = false) =>
  iniciarAtualizacaoPrecosAmazon(
    post('atualizar-precos', { integracaoId: CONTA, baixarPreco: true }),
    UID,
    depsInicio(filaDesligada),
  );

const status = () =>
  resumoAtualizacaoPrecosAmazon(
    new Request(`${BASE}/atualizar-precos/status?integracaoId=${CONTA}`, { method: 'GET' }),
    depsConsulta(),
  );

const cancelar = () =>
  cancelarAtualizacaoPrecosAmazon(
    post('atualizar-precos/cancelar', { integracaoId: CONTA }),
    depsConsulta(),
  );

describe.skipIf(!EMULATED)('the price routes on real Firestore (emulator)', () => {
  beforeEach(async () => {
    expect(process.env.AMAZON_CHAMADAS).not.toBe('on');
    filaPreco = filaGravadora<TarefaPrecoSkuAmazon>();
    filaPaginas = filaGravadora<TarefaPaginaPrecoAmazon>();
    relogio = Date.now();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ the manual push on the real server: a family’s links in BOTH ref forms, another conta’s left out, a nome-less child not reached; ONE named task per sendable SKU, identities only; a 41-code-point SKU `pulado`', async () => {
    await semearConta();
    await produto('ancora');
    await produto('filho-a', { paiId: `${P}ancora` });
    await produto('filho-b', { paiId: `${P}ancora` });
    PRODUTOS.add(`${P}sem-nome`);
    await db()
      .doc(`produtos/${P}sem-nome`)
      .set({ paiId: `${P}ancora` });
    await vinculo('ancora', `${P}SKU-ANCORA`);
    await vinculo('filho-a', `${P}SKU-A`, REF_CONTA_NUA);
    await vinculo('filho-b', `${P}SKU-B`);
    await vinculo('filho-b', `${P}SKU-OUTRA`, `documents/integracao/${P}outra-conta`);
    await vinculo('filho-b', 'L'.repeat(41), REF_CONTA, 'longo');
    await vinculo('sem-nome', `${P}SKU-SEM-NOME`);

    const r = await enviar('ancora');
    expect(r.status).toBe(200);
    const corpo = envioPrecoManualAmazonSchema.parse(r.corpo);
    expect(corpo.listings.map((l) => [l.produtoId, l.sku, l.resultado])).toEqual([
      [`${P}ancora`, 'L'.repeat(41), 'pulado'],
      [`${P}ancora`, `${P}SKU-A`, 'enviado'],
      [`${P}ancora`, `${P}SKU-ANCORA`, 'enviado'],
      [`${P}ancora`, `${P}SKU-B`, 'enviado'],
    ]);
    expect(corpo.listings[0]?.mensagem).toBe(MENSAGEM_ENVIO_MANUAL_PRECO_AMAZON['fora-do-formato']);
    expect(corpo.listings[1]?.produtoNome).toBe('Produto ancora');
    for (const { tarefa, opcoes } of filaPreco.enfileiradas) {
      expect(tarefa).toEqual({
        v: 1,
        tipo: 'preco-sku',
        contaId: CONTA,
        sku: tarefa.sku,
        origem: 'manual',
        referencia: REFERENCIA,
        parte: null,
        baixarPreco: false,
        solicitadoEmMs: relogio,
        codigosAntes: [],
      });
      expect(opcoes).toEqual({ id: nomeDaTarefaPrecoAmazon(tarefa) });
    }
    expect(filaPreco.enfileiradas).toHaveLength(3);
  });

  it('★ the conta on the real server: a bare-form normal tabela passes; a ref to another collection ⇒ 400, nothing more enqueued (NEAR-MISS pair)', async () => {
    await semearConta({ tabelaNormalOuterRef: `listaDePrecos/${P}tabela` });
    await produto('p1');
    await vinculo('p1', `${P}SKU-1`);
    expect((await enviar('p1')).status).toBe(200);
    await semearConta({ tabelaNormalOuterRef: `documents/depositos/${P}dep` });
    const r = await enviar('p1');
    expect(r.status).toBe(400);
    expect(erroPrecoAmazonSchema.parse(r.corpo)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.CONTA_SEM_TABELA_NORMAL,
    });
    expect(filaPreco.enfileiradas).toHaveLength(1);
  });

  it('★ the 30-SKU switch on real reads: 31 sendable SKUs refuse the WHOLE selection, nothing enqueued', async () => {
    await semearConta();
    await produto('p1');
    for (let i = 0; i < 31; i += 1) await vinculo('p1', `${P}SKU-${String(i).padStart(2, '0')}`);
    const r = await enviar('p1');
    expect(r.status).toBe(400);
    expect(erroPrecoAmazonSchema.parse(r.corpo)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: { limite: 30, unidade: 'anuncios', encontrados: 31 },
    });
    expect(filaPreco.enfileiradas).toEqual([]);
  });

  it('★ the run routes on the real server: the start CREATES the run for the caller, a second click is 409 with its id and moves nothing, the status reads it, the cancel lands `cancelada`', async () => {
    await semearConta();
    const inicio = await iniciar();
    expect(inicio.status).toBe(202);
    if (inicio.status !== 202) throw new Error('esperado 202');
    const { execucaoId } = inicio.corpo;
    const criado = await db().doc(RUN).get();
    expect(criado.data()).toMatchObject({
      execucaoId,
      fase: 'paginando',
      baixarPreco: true,
      confirmarReducaoEmMassa: false,
      solicitadaPor: UID,
    });
    expect(filaPaginas.enfileiradas.map((e) => e.opcoes?.id)).toEqual([
      nomePaginaPrecoAmazon(CONTA, execucaoId, 0),
    ]);

    const segunda = await iniciar();
    expect(segunda.status).toBe(409);
    expect(erroPrecoAmazonSchema.parse(segunda.corpo)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId,
    });
    const depois = await db().doc(RUN).get();
    expect(criado.updateTime).toBeDefined();
    expect(depois.updateTime?.toMillis()).toBe(criado.updateTime?.toMillis());
    expect(depois.updateTime?.nanoseconds).toBe(criado.updateTime?.nanoseconds);

    const resumo = await status();
    expect(resumo.status).toBe(200);
    expect(resumoExecucaoPrecoAmazonSchema.parse(resumo.corpo)).toMatchObject({
      execucaoId,
      fase: 'paginando',
      baixarPreco: true,
      parada: false,
      feedEmCurso: null,
    });

    const cancelado = await cancelar();
    expect(cancelado).toEqual({ status: 200, corpo: { execucaoId, fase: 'cancelada' } });
    expect((await db().doc(RUN).get()).data()).toMatchObject({ execucaoId, fase: 'cancelada' });
    expect((await status()).corpo).toMatchObject({ fase: 'cancelada' });
  });

  it('★ the queue valve closed claims NOTHING on the server (503 `fila-desligada`); with no run the status and the cancel answer 404', async () => {
    await semearConta();
    const r = await iniciar(true);
    expect(r.status).toBe(503);
    expect(erroPrecoAmazonSchema.parse(r.corpo)).toMatchObject({
      code: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      motivo: 'fila-desligada',
    });
    expect((await db().doc(RUN).get()).exists).toBe(false);
    expect(filaPaginas.enfileiradas).toEqual([]);
    for (const resposta of [await status(), await cancelar()]) {
      expect(resposta.status).toBe(404);
      expect(erroPrecoAmazonSchema.parse(resposta.corpo)).toMatchObject({
        code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA,
      });
    }
    // NEAR-MISS: the same conta with the valve open IS claimed.
    expect((await iniciar()).status).toBe(202);
    expect((await db().doc(RUN).get()).exists).toBe(true);
  });
});
