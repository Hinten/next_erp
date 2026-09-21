import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemViolationInfoPayloadSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
// ⚠️ The REAL FakeDb and the REAL `escreverAviso`/`resolverAviso` underneath
// `avisoAnuncio.ts`: what is under test is the PATCH and the PLANO this handler
// hands over, and a mocked writer cannot show either.
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { MOTIVO_AVISO_ANUNCIO, chaveAnuncioComViolacao } from './avisoAnuncio';
import {
  ACAO_PUSH_ANUNCIO,
  alvoDoPushDeAnuncio,
  tratarPushDeAnuncio,
  type AlvoDePushDeAnuncioShopee,
} from './pushAnuncio';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or buyer.   */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP_ID = 987654;
const ITEM_ID = 2500139861;
const PAI = 'prod-pai';
const LINK = 'link-1';
const REF_CONTA = `documents/integracao/${CONTA}`;
const LINK_PATH = `produtos/${PAI}/prodshopee/${LINK}`;

const [, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

const AGORA_MS = 1_789_000_000_000;
/** Wire SECONDS, comfortably past the 2020 floor. */
const PRAZO_S = 1_789_600_000;
const PRAZO_MS = PRAZO_S * 1000;
const AGENDADO_S = 1_789_100_000;

const CHAVE_AVISO = chaveAnuncioComViolacao(CONTA, PAI);
const AVISO_PATH = `avisos/${CHAVE_AVISO}`;

/**
 * Recognisable stand-ins for the provider PROSE that must never reach a log line
 * (`redact.ts` denies `violation_reason`, `suggestion` and `fail_message` by
 * NAME). A real one reads as a full pt-BR sentence naming the product.
 */
const PROSA_RAZAO = 'PROSA-RAZAO: o titulo deste anuncio copia o de outra loja';
const PROSA_SUGESTAO = 'PROSA-SUGESTAO: mova o anuncio para a categoria sugerida';

function semearLink(db: FakeDb, extra: Record<string, unknown> = {}): void {
  db.seed(LINK_PATH, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta Básica',
    item_id: ITEM_ID,
    ...extra,
  });
}

/** One `get_item_base_info` row — only the fields step 11 reads. */
function linhaBase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_status: 'NORMAL',
    deboost: false,
    has_model: false,
    scheduled_publish_time: null,
    ...over,
  };
}

/** One `item_status_details[]` / deboost row, as BOTH surfaces send it. */
function detalhe(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    violation_type: 'Spam',
    violation_reason: PROSA_RAZAO,
    suggestion: PROSA_SUGESTAO,
    fix_deadline_time: PRAZO_S,
    update_time: PRAZO_S,
    ...over,
  };
}

/** One `get_item_violation_info` row. */
function linhaViolacao(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_status: 'BANNED',
    deboost: false,
    item_status_details: [detalhe()],
    ...over,
  };
}

interface ClienteFake {
  readonly client: ShopeeClient;
  /** Every call, in ORDER — the op and the ids it asked for. */
  readonly chamadas: { op: string; ids: readonly number[] }[];
}

/**
 * A `ShopeeClient` answering the two operations this module owns. Every other
 * member is absent on purpose: reaching for one is a routing bug, and a
 * `TypeError` naming it is a better signal than a silent `undefined`.
 */
function clienteQueResponde(
  opts: {
    base?: readonly (Record<string, unknown> | null)[] | Error;
    violacao?: readonly (Record<string, unknown> | null)[] | Error;
  } = {},
): ClienteFake {
  const chamadas: { op: string; ids: readonly number[] }[] = [];
  const client = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      chamadas.push({ op: 'get_item_base_info', ids: p.itemIds });
      const b = opts.base ?? [linhaBase()];
      if (b instanceof Error) return Promise.reject(b);
      return Promise.resolve(shopeeItemBaseInfoPayloadSchema.parse({ item_list: b }));
    },
    getItemViolationInfo: (p: { itemIds: readonly number[] }) => {
      chamadas.push({ op: 'get_item_violation_info', ids: p.itemIds });
      const v = opts.violacao ?? [];
      if (v instanceof Error) return Promise.reject(v);
      return Promise.resolve(shopeeItemViolationInfoPayloadSchema.parse({ item_list: v }));
    },
  } as unknown as ShopeeClient;
  return { client, chamadas };
}

function erroApi(code: string, kind = SHOPEE_ERROR_KIND.other): ShopeeApiError {
  return new ShopeeApiError(`shopee recusou (${code})`, {
    code,
    kind,
    httpStatus: 200,
    path: '/api/v2/product/get_item_base_info',
  });
}

/** The push `data` of a code 16, with the prose leaves the handler must not log. */
function corpoPush16(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { item_id: ITEM_ID, item_status: 'BANNED', deboost: false, ...over };
}

function alvo(over: Partial<AlvoDePushDeAnuncioShopee> = {}): AlvoDePushDeAnuncioShopee {
  return {
    integracaoId: CONTA,
    shopId: SHOP_ID,
    itemId: ITEM_ID,
    code: 16,
    agendadoParaMs: null,
    nowMs: AGORA_MS,
    diagnostico: {
      temDetalhesDeStatus: false,
      temDetalhesDeDeboost: false,
      grafiaDeboosted: false,
    },
    carimboMs: AGORA_MS - 1_000,
    detalhesDoPush: { status: [], deboost: [] },
    ...over,
  };
}

/** The alvo the parser really builds for a body — no hand-written diagnostics. */
function alvoDoCorpo(
  code: number,
  data: Record<string, unknown>,
  over: Partial<AlvoDePushDeAnuncioShopee> = {},
): AlvoDePushDeAnuncioShopee {
  const lido = alvoDoPushDeAnuncio(code, data);
  if (!lido.ok) throw new Error(`fixture: o parser recusou o corpo (${lido.motivo})`);
  return alvo({
    code,
    itemId: lido.itemId,
    agendadoParaMs: lido.agendadoParaMs,
    diagnostico: lido.diagnostico,
    detalhesDoPush: {
      status: Array.isArray(data.item_status_details) ? data.item_status_details : [],
      deboost: Array.isArray(data.deboost_details)
        ? data.deboost_details
        : Array.isArray(data.deboosted_details)
          ? data.deboosted_details
          : [],
    },
    ...over,
  });
}

const infos: unknown[][] = [];
const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  infos.length = 0;
  avisos.length = 0;
});

const TAG_DO_BRACO = '[shopee/anuncios] entrega de anúncio';
function linhasDoBraco(): Record<string, unknown>[] {
  return infos
    .filter((args) => args[0] === TAG_DO_BRACO)
    .map((args) => args[1] as Record<string, unknown>);
}

/** The whole log of a run, flattened, so a "never appears" claim is total. */
function logInteiro(): string {
  return [...infos, ...avisos]
    .map((args) => args.map((a) => JSON.stringify(a)).join(' '))
    .join('|');
}

/** The one link patch of a run. */
function patchDoLink(db: FakeDb): Record<string, unknown> {
  const escritas = db.writes.filter((w) => w.path === LINK_PATH);
  expect(escritas).toHaveLength(1);
  return escritas[0]!.patch;
}

/* -------------------------------------------------------------------------- */
/*                        1–4 — the parser (pure, total)                       */
/* -------------------------------------------------------------------------- */

describe('alvoDoPushDeAnuncio', () => {
  it('1 — lê item_id nos dois codes e NADA mais do corpo', () => {
    // O push é um PONTEIRO: `item_status`, `deboost` e `item_name` estão no corpo
    // e NENHUM deles entra no alvo como dado. O handler re-lê.
    const corpo = {
      item_id: ITEM_ID,
      item_status: 'BANNED',
      item_name: 'Camiseta Básica',
      deboost: true,
      shop_id: SHOP_ID,
    };

    for (const code of [16, 27]) {
      const r = alvoDoPushDeAnuncio(code, corpo);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r).toEqual({
        ok: true,
        itemId: ITEM_ID,
        code,
        agendadoParaMs: null,
        diagnostico: {
          temDetalhesDeStatus: false,
          temDetalhesDeDeboost: false,
          grafiaDeboosted: false,
        },
      });
      // ⚠️ `shop_id` NÃO é lido aqui: o push 18 o traz só no envelope e o push 30
      // o traz nos DOIS lugares, então um parser que o lesse estaria supondo um
      // envelope uniforme que nenhuma página promete. O braço o levanta.
      expect(JSON.stringify(r)).not.toContain('shop_id');
      expect(JSON.stringify(r)).not.toContain('BANNED');
    }
  });

  it('1b — um item_id em STRING é lido (o serializador que cita um campo não custa o recurso)', () => {
    const r = alvoDoPushDeAnuncio(16, { item_id: String(ITEM_ID) });
    expect(r.ok && r.itemId).toBe(ITEM_ID);
  });

  it('2 — ⚠️ aceita as DUAS grafias: deboost_details (tabela) e deboosted_details (amostra)', () => {
    const tabela = alvoDoPushDeAnuncio(16, {
      item_id: ITEM_ID,
      deboost_details: [detalhe()],
    });
    const amostra = alvoDoPushDeAnuncio(16, {
      item_id: ITEM_ID,
      deboosted_details: [detalhe()],
    });

    expect(tabela.ok && tabela.diagnostico).toEqual({
      temDetalhesDeStatus: false,
      temDetalhesDeDeboost: true,
      grafiaDeboosted: false,
    });
    // A grafia da AMOSTRA é a única coisa que distingue as duas, e o booleano é o
    // único registro de qual chegou.
    expect(amostra.ok && amostra.diagnostico).toEqual({
      temDetalhesDeStatus: false,
      temDetalhesDeDeboost: true,
      grafiaDeboosted: true,
    });
  });

  it('2b — ⚠️ NEAR-MISS: "deboost_detail" no singular NÃO casa', () => {
    // Aceitar uma chave quase-igual deixaria um typo — nosso ou da Shopee —
    // decidir o que o operador ouve sobre um anúncio.
    const r = alvoDoPushDeAnuncio(16, { item_id: ITEM_ID, deboost_detail: [detalhe()] });
    expect(r.ok && r.diagnostico).toEqual({
      temDetalhesDeStatus: false,
      temDetalhesDeDeboost: false,
      grafiaDeboosted: false,
    });
  });

  it('3 — sem item_id ⇒ !ok, com motivo, e o braço nunca chega ao handler', () => {
    // ⚠️ `0` entra na MESMA recusa: a Shopee zero-fila um numérico ausente, e um
    // `0` chegando ao resolvedor rodaria uma consulta conta-escopada por um
    // `item_id: 0` armazenado — um vínculo que não aponta para listagem nenhuma
    // (a armadilha do `model_id: 0`, uma coleção ao lado).
    for (const corpo of [
      {},
      { item_id: null },
      { item_id: 'abacaxi' },
      { item_id: 0 },
      { item_id: -1 },
    ]) {
      const r = alvoDoPushDeAnuncio(16, corpo);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.motivo).toContain('item_id');
      // O motivo carrega CAMINHOS e prosa fixa — nunca um valor e nunca um corpo.
      expect(r.ok === false && r.motivo).not.toContain('abacaxi');
    }
    // E o alvo de um corpo recusado não existe: o handler não é chamado, porque
    // não há `itemId` para construí-lo.
    expect(() => alvoDoCorpo(16, { item_id: 0 })).toThrow('o parser recusou');
  });

  it('3b — um push_code que não é 16 nem 27 é recusado', () => {
    const r = alvoDoPushDeAnuncio(12, { item_id: ITEM_ID });
    expect(r.ok === false && r.motivo).toContain('push_code');
  });

  it('4 — code 27 lê scheduled_publish_time em SEGUNDOS e devolve MILLIS', () => {
    const r = alvoDoPushDeAnuncio(27, {
      item_id: ITEM_ID,
      scheduled_publish_time: AGENDADO_S,
    });
    expect(r.ok && r.agendadoParaMs).toBe(AGENDADO_S * 1000);

    // ⚠️ O code 16 não documenta agendamento nenhum: levantá-lo de um corpo que
    // não deveria trazê-lo carimbaria `agendamentoFalhouEm` de um campo que
    // ninguém sabe de onde veio.
    const dezesseis = alvoDoPushDeAnuncio(16, {
      item_id: ITEM_ID,
      scheduled_publish_time: AGENDADO_S,
    });
    expect(dezesseis.ok && dezesseis.agendadoParaMs).toBeNull();
  });

  it('4b — ⚠️ um 0 (zero-fill) vira null, e um valor pré-2020 também', () => {
    for (const bruto of [0, null, 1_500_000_000]) {
      const r = alvoDoPushDeAnuncio(27, { item_id: ITEM_ID, scheduled_publish_time: bruto });
      expect(r.ok && r.agendadoParaMs).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                      5–8 — the read decides, never the push                 */
/* -------------------------------------------------------------------------- */

describe('tratarPushDeAnuncio — code 16', () => {
  it('5 — o handler re-lê get_item_base_info: o corpo do push não decide status nenhum', async () => {
    // ⚠️ M-38. O push FALSO diz BANNED; a leitura diz NORMAL; o vínculo tem de
    // ler NORMAL. É o defeito do legado em uma linha: ele escrevia a string
    // "UNLIST" que o push nunca trouxe.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [linhaBase({ item_status: 'NORMAL' })] });

    // ⚠️ O corpo carrega `item_status_details[]`, como uma entrega de push 18 de
    // verdade: sem ele `detalhesDoPush.status` fica VAZIO e todo leitor derivado
    // do push que o alvo alcança responde a mesma coisa que o correto, de graça.
    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ item_status_details: [detalhe()] })),
      {
        clientFor: () => Promise.resolve(cli.client),
        increment,
      },
    );

    const patch = patchDoLink(db);
    expect(patch).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    expect(patch.item_status).toBe('NORMAL');
    expect(JSON.stringify(patch)).not.toContain('BANNED');
    // E o conjunto de chaves é FECHADO: nada levantado de `detalhesDoPush` entra.
    expect(Object.keys(patch).sort()).toEqual([
      'deboost',
      'estadoAnuncio',
      'item_status',
      'ultimaModificacao',
      'violacoesLidasEm',
      'violations',
    ]);
    expect(r.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.ativo);
    expect(JSON.stringify(db.store[LINK_PATH]?.data)).not.toContain('BANNED');
    // A ORDEM é parte do contrato: a leitura autoritativa vem antes do detalhe.
    expect(cli.chamadas.map((c) => c.op)).toEqual([
      'get_item_base_info',
      'get_item_violation_info',
    ]);
  });

  it('6 — ⚠️ push 18 amostra 3: NORMAL + deboost true grava ativo com deboost, e NÃO mata o anúncio', async () => {
    // ⚠️ M-29. `deboost` é ORTOGONAL: a listagem está viva e vendável, só o
    // ranking de busca caiu. Dobrar isso em `pausado` mataria um anúncio vivo.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'NORMAL', deboost: true })],
      violacao: [linhaViolacao({ item_status: 'NORMAL', item_status_details: null })],
    });

    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ deboost: true, deboosted_details: [detalhe()] })),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    expect(patchDoLink(db)).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      deboost: true,
    });
    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.deboostRegistrado);
    // O aviso é levantado com o motivo do REMÉDIO certo — mover a categoria.
    expect(db.store[AVISO_PATH]?.data).toMatchObject({
      motivo: MOTIVO_AVISO_ANUNCIO.deboost,
      params: { violacao: 'rebaixamento na busca' },
    });
  });

  it('6b — ⚠️ a STRING "FALSE" do sandbox não é um deboost', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [linhaBase({ deboost: 'FALSE' })] });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.deboost).toBe(false);
    expect(patchDoLink(db)).toMatchObject({ deboost: false });
  });

  it('7 — sem vínculo ⇒ ignorado-sem-vinculo com produtoId null, e ZERO escritas', async () => {
    // Nenhum vínculo, nenhuma chamada: o ERP não gerencia esta listagem, e a
    // leitura barata vem primeiro porque a re-tentativa do braço gastaria uma
    // chamada por tentativa por nada.
    const db = new FakeDb();
    const cli = clienteQueResponde();

    const r = await tratarPushDeAnuncio(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r).toMatchObject({
      kind: 'anuncio',
      acao: ACAO_PUSH_ANUNCIO.ignoradoSemVinculo,
      produtoId: null,
      estadoAnuncio: null,
      violacoes: 0,
      avisoResultado: null,
      avisoResolvido: false,
    });
    expect(cli.chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(Object.keys(db.store)).toEqual([]);
  });

  it('8 — o vínculo é resolvido pelo composto DECLARADO (item_id, conta) — nunca global', async () => {
    // Um vínculo do MESMO item_id em OUTRA conta não pode ser tocado: era
    // exatamente a consulta global do legado, que com duas integrações no mesmo
    // item_id escolhia uma arbitrariamente.
    const db = new FakeDb();
    semearLink(db);
    db.seed(`produtos/prod-de-outra/prodshopee/link-9`, {
      contaProdutoShopeeOuterRef: `documents/integracao/int-2`,
      item_name: 'Camiseta de outra conta',
      item_id: ITEM_ID,
    });
    const cli = clienteQueResponde();

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.produtoId).toBe(PAI);
    const consulta = db.consultasCompletas.at(0);
    expect(consulta?.fonte).toBe(`group:${INDICE_LISTAGEM.collectionGroup}`);
    // As DUAS cláusulas do composto declarado, na ordem dele — a segunda é o que
    // torna a consulta conta-escopada.
    expect(consulta?.clausulas.map(([campo]) => campo)).toEqual([...INDICE_LISTAGEM.campos]);
    expect(consulta?.clausulas[1]?.[2]).toBe(REF_CONTA);
    // ⚠️ NÚMERO, nunca `String(itemId)` — que não casa nada, silenciosamente.
    expect(typeof consulta?.clausulas[0]?.[2]).toBe('number');
    // Nada foi escrito para a outra conta.
    expect(db.writes.map((w) => w.path)).not.toContain('produtos/prod-de-outra/prodshopee/link-9');
  });
});

/* -------------------------------------------------------------------------- */
/*                   9–11 — the violation pull, and its fallback               */
/* -------------------------------------------------------------------------- */

describe('o detalhe de violação é best-effort', () => {
  it('9 — a recusa do violation info mantém os detalhes DO PUSH, e violacoesLidas é false', async () => {
    // A recusa documentada (`item_status does not match latest violation`) é uma
    // das três formas da mesma coisa. O pull é MENOS autoritativo num item em
    // movimento, não mais — e os detalhes do push são o que a Shopee mandou sobre
    // este evento. O STATUS continua vindo da leitura.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: erroApi('error_param'),
    });

    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ item_status_details: [detalhe()] })),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    expect(r.violacoesLidas).toBe(false);
    expect(r.violacoes).toBe(1);
    const patch = patchDoLink(db);
    expect(patch.item_status).toBe('BANNED');
    expect(patch.violations).toEqual([
      expect.objectContaining({ violation_type: 'Spam', kind: 'status' }),
    ]);
    // A recusa avisa com o CÓDIGO da Shopee e nada mais.
    expect(avisos.some((a) => JSON.stringify(a).includes('error_param'))).toBe(true);
  });

  it('9b — uma linha com fail_error vale o mesmo que a recusa de envelope', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao({ fail_error: 'error_item', item_status_details: null })],
    });

    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ item_status_details: [detalhe()] })),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    expect(r.violacoesLidas).toBe(false);
    expect(r.violacoes).toBe(1);
  });

  it('9c — ⚠️ sem linha para o item pedido é o MESMO veredito: não é uma leitura', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao({ item_id: 999, item_status_details: null })],
    });

    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ item_status_details: [detalhe()] })),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    expect(r.violacoesLidas).toBe(false);
    expect(r.violacoes).toBe(1);
  });

  it('9d — ⚠️ um erro transitório do violation info SOBE: ele não é best-effort para tudo', async () => {
    // Uma cota, um reauth, uma queda de rede e um schema quebrado não são
    // propriedades desta listagem (regra 6). O braço os classifica.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      violacao: new ShopeeRateLimitError('cota', {
        code: 'error_limit',
        kind: 'daily',
        httpStatus: 200,
        path: '/api/v2/product/get_item_violation_info',
      }),
    });

    await expect(
      tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
        clientFor: () => Promise.resolve(cli.client),
        increment,
      }),
    ).rejects.toBeInstanceOf(ShopeeRateLimitError);
    // Nada foi escrito: a falha aconteceu antes do patch.
    expect(db.writes).toEqual([]);
  });

  it('10 — violacoesDeDetalhes marca kind status/deboost e só o deboost carrega suggested_category', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED', deboost: true })],
      violacao: [
        linhaViolacao({
          item_status_details: [
            detalhe({ suggested_category: [{ category_id: 100_017, category_name: 'Camisetas' }] }),
          ],
          deboost_details: [
            detalhe({
              violation_type: 'Mall Listing Improvement',
              suggested_category: [{ category_id: 100_018, category_name: 'Regatas' }],
            }),
          ],
        }),
      ],
    });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.violacoes).toBe(2);
    const violations = patchDoLink(db).violations as Record<string, unknown>[];
    // O status vem PRIMEIRO, e é o `kind` que separa os dois lados.
    expect(violations.map((v) => v.kind)).toEqual(['status', 'deboost']);
    expect(violations[0]?.suggested_category).toBeNull();
    expect(violations[1]?.suggested_category).toEqual([
      { category_id: 100_018, category_name: 'Regatas' },
    ]);
  });

  it('11 — fix_deadline_time vira MILLIS; days_to_fix continua null — nada é derivado', async () => {
    // ⚠️ M-39. Derivar `days_to_fix` de `fix_deadline_time` precisa de um relógio,
    // perde o valor original e NÃO é idempotente: o mesmo push, re-entregue um dia
    // depois, daria outro número e o vínculo seria reescrito sem evento nenhum.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao()],
    });

    await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    const violations = patchDoLink(db).violations as Record<string, unknown>[];
    expect(violations[0]).toMatchObject({
      fix_deadline_time: PRAZO_MS,
      update_time: PRAZO_MS,
      days_to_fix: null,
    });
    // E o prazo do aviso é o MESMO número em ms, convertido uma única vez.
    expect(db.store[AVISO_PATH]?.data).toMatchObject({ prazo: PRAZO_MS * 1000 });
  });
});

/* -------------------------------------------------------------------------- */
/*                        12–14 — the aviso, and the patch                     */
/* -------------------------------------------------------------------------- */

describe('o aviso', () => {
  it('12 — um code 16 LIMPO (NORMAL, sem deboost, sem violações) RESOLVE o aviso', async () => {
    // ⚠️ Este braço existe porque o push 18 dispara nas DUAS direções: uma
    // listagem cujo rebaixamento foi retirado entrega um code 16 com
    // `deboost: false`, e ler isso como "nada a fazer" deixa o aviso de pé para
    // sempre.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase()],
      violacao: [
        linhaViolacao({
          item_status: 'NORMAL',
          item_status_details: null,
        }),
      ],
    });

    // Uma linha ABERTA, escrita por uma entrega anterior.
    await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ item_status_details: [detalhe()] }), {
        carimboMs: AGORA_MS - 10_000,
      }),
      {
        clientFor: () =>
          Promise.resolve(
            clienteQueResponde({
              base: [linhaBase({ item_status: 'BANNED' })],
              violacao: erroApi('error_param'),
            }).client,
          ),
        increment,
      },
    );
    expect(db.store[AVISO_PATH]?.data).toMatchObject({ resolvidoEm: null });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.anuncioNormalizado);
    // Uma TRANSIÇÃO: `true` só quando havia linha aberta e esta entrega a fechou.
    expect(r.avisoResolvido).toBe(true);
    expect(db.store[AVISO_PATH]?.data).toMatchObject({
      resolucaoMotivo: 'anuncio-normalizado',
    });
  });

  it('12b — ⚠️ uma leitura LIMPA que não está VIVA (em revisão) NÃO resolve', async () => {
    // `em_revisao` é exatamente onde a listagem fica entre a correção do vendedor
    // e a decisão da Shopee. O patch entra; fechar a linha diria ao operador que o
    // problema passou enquanto o anúncio continua não vendendo.
    const db = new FakeDb();
    semearLink(db);
    db.seed(AVISO_PATH, {
      tipo: 'anuncioComViolacao',
      conta: CONTA,
      entidade: PAI,
      severidade: 'atencao',
      canal: 'shopee',
      params: {},
      motivo: MOTIVO_AVISO_ANUNCIO.violacao,
      destinatarioUid: null,
      urlInterna: null,
      urlExterna: null,
      prazo: null,
      relogioEvento: null,
      criadoEm: (AGORA_MS - 10_000) * 1000,
      atualizadoEm: (AGORA_MS - 10_000) * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
    const cli = clienteQueResponde({ base: [linhaBase({ item_status: 'REVIEWING' })] });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.anuncioNormalizado);
    expect(r.avisoResolvido).toBe(false);
    expect(patchDoLink(db)).toMatchObject({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.emRevisao,
    });
    expect(db.store[AVISO_PATH]?.data).toMatchObject({ resolvidoEm: null, ocorrencias: 1 });
  });

  it('12c — ⚠️ uma derrubada COM deboost avisa violacao, nunca rebaixamento', async () => {
    // Os dois braços de W1 §8.4 se sobrepõem numa entrega BANNED que traz
    // `deboost: true`, e o motivo escolhe o REMÉDIO do operador: uma violação se
    // resolve no Seller Centre, um rebaixamento movendo a categoria. Chamar uma
    // derrubada de "rebaixamento na busca" manda o operador para o lugar errado.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED', deboost: true })],
      violacao: [linhaViolacao()],
    });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.violacaoRegistrada);
    expect(db.store[AVISO_PATH]?.data).toMatchObject({
      motivo: MOTIVO_AVISO_ANUNCIO.violacao,
      // O PRIMEIRO `violation_type`, e nunca a prosa.
      params: { violacao: 'Spam', anuncio: String(ITEM_ID) },
    });
  });

  it('13 — code 27 grava agendamentoFalhouEm e levanta o aviso com motivo agendamento-falhou, sem prazo', async () => {
    // ⚠️ O push carrega NENHUMA razão — três campos em `data`, nenhum deles um
    // código de erro ou uma mensagem — então o aviso diz exatamente isso e aponta
    // para a listagem. Inventar uma causa seria pior que nenhuma.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [linhaBase({ item_status: 'UNLIST' })] });

    const r = await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(27, { item_id: ITEM_ID, scheduled_publish_time: AGENDADO_S }),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.agendamentoRegistrado);
    // UMA chamada: o code 27 não lê violação nenhuma.
    expect(cli.chamadas.map((c) => c.op)).toEqual(['get_item_base_info']);
    expect(r.violacoesLidas).toBe(false);
    // ⚠️ O carimbo é o relógio da ENTREGA (`nowMs`) — "quando uma publicação
    // agendada foi REPORTADA como falha", que é o que `shopeeLink.ts` declara —
    // e NUNCA o `scheduled_publish_time`, que é quando ela estava marcada. São
    // duas grandezas diferentes e um campo só não carrega as duas.
    expect(patchDoLink(db)).toEqual({
      item_status: 'UNLIST',
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      deboost: false,
      agendamentoFalhouEm: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
    expect(patchDoLink(db).agendamentoFalhouEm).not.toBe(AGENDADO_S * 1000);
    expect(db.store[AVISO_PATH]?.data).toMatchObject({
      motivo: MOTIVO_AVISO_ANUNCIO.agendamentoFalhou,
      params: { violacao: 'publicação agendada falhou' },
      // SEM prazo: o push não traz deadline nenhum.
      prazo: null,
    });
  });

  it('13b — ⚠️ NEAR-MISS: um code 27 SEM agendamento utilizável carimba nowMs e NÃO apaga o anterior', async () => {
    // `agendadoParaMsDe` responde null para um valor ausente, zero-filled ou
    // pré-2020, e a escrita é uma sobrescrita simples: carimbar o agendamento
    // fazia um segundo code 27 sem horário utilizável APAGAR o registro que o
    // primeiro deixou, e o vínculo ficava sem prova nenhuma de que uma publicação
    // agendada havia falhado.
    const db = new FakeDb();
    semearLink(db, { agendamentoFalhouEm: AGORA_MS - 86_400_000 });
    const cli = clienteQueResponde({ base: [linhaBase({ item_status: 'UNLIST' })] });

    const entrega = alvoDoCorpo(27, { item_id: ITEM_ID, scheduled_publish_time: 0 });
    expect(entrega.agendadoParaMs).toBeNull();

    await tratarPushDeAnuncio(asDb(db), entrega, {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    const patch = patchDoLink(db);
    expect(patch.agendamentoFalhouEm).toBe(AGORA_MS);
    expect(patch.agendamentoFalhouEm).not.toBeNull();
    expect(db.store[LINK_PATH]?.data).toMatchObject({ agendamentoFalhouEm: AGORA_MS });
  });

  it('14 — uma reentrega idêntica reescreve a MESMA leitura, sem mover violacoesLidasEm, e o aviso responde ignorado', async () => {
    // Idempotência por RE-BUSCA: a mesma leitura produz a mesma leitura escrita,
    // e a marca d'água do relógio do evento derruba a segunda entrega.
    //
    // ⚠️ PAR (regra O10): a segunda entrega é o primeiro patch MENOS
    // `violacoesLidasEm` — o campo significa "quando a lista armazenada MUDOU",
    // e na reentrega ela não mudou. Todo o resto continua sendo reescrito: este
    // braço re-busca em vez de diffar, então sempre grava a sua leitura.
    const db = new FakeDb();
    semearLink(db);
    const deps = {
      clientFor: () =>
        Promise.resolve(
          clienteQueResponde({
            base: [linhaBase({ item_status: 'BANNED' })],
            violacao: [linhaViolacao()],
          }).client,
        ),
      increment,
    };
    const entrega = alvoDoCorpo(16, corpoPush16());

    const primeira = await tratarPushDeAnuncio(asDb(db), entrega, deps);
    const patch1 = db.writes.filter((w) => w.path === LINK_PATH).at(-1)?.patch;

    const segunda = await tratarPushDeAnuncio(asDb(db), entrega, deps);
    const patch2 = db.writes.filter((w) => w.path === LINK_PATH).at(-1)?.patch;

    // A primeira entrega MOVE o carimbo: o vínculo não tinha lista nenhuma.
    expect(patch1).toMatchObject({ violacoesLidasEm: AGORA_MS });
    // A segunda não: as linhas são as mesmas.
    expect(patch2).not.toHaveProperty('violacoesLidasEm');
    const { violacoesLidasEm: _carimbo, ...semCarimbo } = patch1 as Record<string, unknown>;
    expect(patch2).toEqual(semCarimbo);
    expect(primeira.avisoResultado).toBe('criado');
    // ⚠️ `ignorado`, não `repetido`: o mesmo `relogioEvento` não é mais fresco que
    // o armazenado, e `ocorrencias` não se move.
    expect(segunda.avisoResultado).toBe('ignorado');
    expect(db.store[AVISO_PATH]?.data).toMatchObject({ ocorrencias: 1 });
  });

  it('14b — ⚠️ NEAR-MISS: uma linha com violation_type DIFERENTE move violacoesLidasEm', async () => {
    // O par de 14 mostra que o fold APLICA; este mostra onde ele PARA. Se a
    // comparação dobrasse demais — ignorando o tipo, por exemplo — uma violação
    // nova entraria com o carimbo da antiga, e o painel do operador diria que a
    // leitura é de dias atrás.
    const db = new FakeDb();
    semearLink(db);
    const primeiroCli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao()],
    });
    const entrega = alvoDoCorpo(16, corpoPush16());
    const ultimoPatch = (): Record<string, unknown> | undefined =>
      db.writes.filter((w) => w.path === LINK_PATH).at(-1)?.patch;
    await tratarPushDeAnuncio(asDb(db), entrega, {
      clientFor: () => Promise.resolve(primeiroCli.client),
      increment,
    });
    expect(ultimoPatch()).toMatchObject({ violacoesLidasEm: AGORA_MS });

    const DEPOIS_MS = AGORA_MS + 60_000;
    const segundoCli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [
        linhaViolacao({ item_status_details: [detalhe({ violation_type: 'Prohibited' })] }),
      ],
    });
    await tratarPushDeAnuncio(
      asDb(db),
      alvo({ ...entrega, nowMs: DEPOIS_MS, carimboMs: DEPOIS_MS }),
      { clientFor: () => Promise.resolve(segundoCli.client), increment },
    );

    expect(ultimoPatch()).toMatchObject({ violacoesLidasEm: DEPOIS_MS });
  });
});

/* -------------------------------------------------------------------------- */
/*                 15 — the one log line, and the flat patch                   */
/* -------------------------------------------------------------------------- */

describe('o registro e a forma do patch', () => {
  it('15 — o handler emite UMA linha de log, com booleanos e contagens — nenhum valor do corpo', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao()],
    });

    await tratarPushDeAnuncio(
      asDb(db),
      alvoDoCorpo(16, corpoPush16({ deboosted_details: [detalhe()] })),
      { clientFor: () => Promise.resolve(cli.client), increment },
    );

    const linhas = linhasDoBraco();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      integracaoId: CONTA,
      shopId: SHOP_ID,
      itemId: ITEM_ID,
      code: 16,
      produtoId: PAI,
      acao: ACAO_PUSH_ANUNCIO.violacaoRegistrada,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.banido,
      deboost: false,
      violacoes: 1,
      descartadas: 0,
      violacoesLidas: true,
      temDetalhesDeStatus: false,
      temDetalhesDeDeboost: true,
      grafiaDeboosted: true,
      divergePushVsPull: false,
      temCarimbo: true,
    });
    // ⚠️ Nenhuma prosa do provedor em NENHUMA linha do log — as três folhas estão
    // na denylist de redação por NOME, e um log de task não é onde elas voltam.
    const tudo = logInteiro();
    expect(tudo).not.toContain('PROSA-RAZAO');
    expect(tudo).not.toContain('PROSA-SUGESTAO');
    expect(tudo).not.toContain('Camiseta Básica');
  });

  it('15b — ⚠️ o patch de ciclo de vida é PLANO: nenhum objeto aninhado', async () => {
    // ⚠️ M-41. `mergeIfExists` é `update()` mais um narrow de NOT_FOUND, e ele
    // LANÇA um TypeError num objeto aninhado ou numa chave com ponto —
    // `ultimaPublicacao` e `falhaPublicacao` são objetos e pertencem à família
    // `aplicarLinkDaListagem` → `merge` do publicador (C15). `violations[]` é um
    // ARRAY e passa, e a substituição inteira é a intenção.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase({ item_status: 'BANNED' })],
      violacao: [linhaViolacao()],
    });

    await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    const patch = patchDoLink(db);
    expect(Object.keys(patch).sort()).toEqual([
      'deboost',
      'estadoAnuncio',
      'item_status',
      'ultimaModificacao',
      'violacoesLidasEm',
      'violations',
    ]);
    for (const [chave, valor] of Object.entries(patch)) {
      expect(chave).not.toContain('.');
      const aninhado =
        typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? chave : null;
      expect(aninhado).toBeNull();
    }
  });

  it('15c — um item_status que a Shopee inventar custa UM campo, nunca o anúncio', async () => {
    // `itemStatusDeLink`'s própria regra: o schema do vínculo declara o enum de
    // seis membros, então um valor novo grava `null` ali e `estadoAnuncio:
    // desconhecido` é o registro durável dele.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [linhaBase({ item_status: 'CONGELADO' })] });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.desconhecido);
    expect(patchDoLink(db)).toMatchObject({
      item_status: null,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.desconhecido,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         the removido arm (both codes)                       */
/* -------------------------------------------------------------------------- */

describe('a listagem que a Shopee não tem mais', () => {
  it('error_item_not_found ⇒ removido, e o item_status NÃO é escrito', async () => {
    // O handler não LEU status nenhum, e escrever um que ele inventou é
    // exatamente o defeito do legado.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: erroApi('error_item_not_found') });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.ignoradoRemovido);
    // ⚠️ PAR (regra O10): o vínculo semeado não tinha violação nenhuma, e a
    // leitura de um anúncio que a Shopee não tem mais também é a lista VAZIA —
    // nada mudou, então `violacoesLidasEm` não se move. O braço abaixo mostra o
    // outro lado.
    expect(patchDoLink(db)).toEqual({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      ultimaModificacao: AGORA_MS,
    });
    // Nenhuma chamada de violação: não há listagem sobre a qual perguntar.
    expect(cli.chamadas.map((c) => c.op)).toEqual(['get_item_base_info']);
  });

  it('⚠️ um vínculo que TINHA violações move violacoesLidasEm ao virar removido', async () => {
    // O outro lado do par: a lista armazenada deixa de descrever qualquer coisa
    // quando o anúncio some, e isso É uma mudança. As linhas em si ficam — são o
    // único registro do que a listagem foi recusada por ser.
    const db = new FakeDb();
    semearLink(db, {
      violations: [
        {
          violation_type: 'Spam',
          violation_reason: PROSA_RAZAO,
          suggestion: PROSA_SUGESTAO,
          fix_deadline_time: PRAZO_MS,
          update_time: PRAZO_MS,
          kind: 'status',
          days_to_fix: null,
          suggested_category: null,
        },
      ],
    });
    const cli = clienteQueResponde({ base: erroApi('error_item_not_found') });

    await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(patchDoLink(db)).toEqual({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      violacoesLidasEm: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
    // E as linhas armazenadas NÃO são apagadas.
    expect(db.store[LINK_PATH]?.data).toHaveProperty('violations');
  });

  it('⚠️ o código com prefixo de módulo é o MESMO veredito', async () => {
    // A sonda mediu o prefixo `product.` real no fio; comparar só o código nu
    // re-lançaria um veredito que este handler é dono de decidir.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: erroApi('product.error_item_not_found') });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });
    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.ignoradoRemovido);
  });

  it('⚠️ NEAR-MISS: uma resposta VAZIA (nenhuma linha para o id) é o MESMO removido', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [] });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });
    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.ignoradoRemovido);
    expect(r.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
  });

  it('⚠️ e uma linha ILEGÍVEL (o sentinela por-linha) também — não é uma leitura', async () => {
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({ base: [null] });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(16, corpoPush16()), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });
    expect(r.acao).toBe(ACAO_PUSH_ANUNCIO.ignoradoRemovido);
  });

  it('resolve o aviso com motivo anuncio-removido', async () => {
    const db = new FakeDb();
    semearLink(db);
    db.seed(AVISO_PATH, {
      tipo: 'anuncioComViolacao',
      conta: CONTA,
      entidade: PAI,
      severidade: 'atencao',
      canal: 'shopee',
      params: {},
      motivo: MOTIVO_AVISO_ANUNCIO.violacao,
      destinatarioUid: null,
      urlInterna: null,
      urlExterna: null,
      prazo: null,
      relogioEvento: null,
      criadoEm: (AGORA_MS - 10_000) * 1000,
      atualizadoEm: (AGORA_MS - 10_000) * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
    });
    const cli = clienteQueResponde({ base: erroApi('error_item_not_found') });

    const r = await tratarPushDeAnuncio(asDb(db), alvoDoCorpo(27, { item_id: ITEM_ID }), {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    // ⚠️ UM braço para os dois codes: carimbar `agendamentoFalhouEm` numa
    // listagem que a Shopee não tem mais seria um carimbo num fantasma.
    expect(r.avisoResolvido).toBe(true);
    expect(db.store[AVISO_PATH]?.data).toMatchObject({ resolucaoMotivo: 'anuncio-removido' });
    expect(patchDoLink(db)).not.toHaveProperty('agendamentoFalhouEm');
  });

  it('um vínculo apagado no meio não é ressuscitado', async () => {
    // `mergeIfExists` é `update()` mais o narrow de NOT_FOUND: o documento não
    // volta, a entrega não falha, e o handler avisa.
    const db = new FakeDb();
    semearLink(db);
    const cli = clienteQueResponde({
      base: [linhaBase()],
      violacao: [linhaViolacao({ item_status: 'NORMAL', item_status_details: null })],
    });
    const alvoDaEntrega = alvoDoCorpo(16, corpoPush16());
    // Resolve o vínculo e então o apaga, antes de qualquer escrita.
    const originalGet = db.collectionGroup.bind(db);
    db.collectionGroup = (nome: string) => {
      const chain = originalGet(nome);
      const get = chain.get;
      chain.get = async () => {
        const r = await get();
        delete db.store[LINK_PATH];
        return r;
      };
      return chain;
    };

    const r = await tratarPushDeAnuncio(asDb(db), alvoDaEntrega, {
      clientFor: () => Promise.resolve(cli.client),
      increment,
    });

    expect(r.produtoId).toBe(PAI);
    expect(db.store[LINK_PATH]).toBeUndefined();
    expect(avisos.some((a) => JSON.stringify(a).includes('desapareceu'))).toBe(true);
  });
});
