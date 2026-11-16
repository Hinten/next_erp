/**
 * #1911 P15 — `lerCanaisDoRascunhoShopee`: the `canais` route's IO half. The
 * REAL module runs over the FakeDb and a stub client whose `getChannelList`
 * answers bodies parsed by the package's OWN schema, so every verdict below is
 * the publisher's (`avaliarCanaisDaLojaShopee`) as the route will answer it.
 *
 * What is pinned here is the COMPOSITION, never a second copy of a rule: the
 * produto is read first (an absent one costs zero Shopee calls), the parcel
 * comes from the publisher's readers, the motivo → `indisponivel` map, the
 * masked `isFree`, the trimmed name, one uncached read per call, zero writes —
 * and, on the raw source, that no channel rule is re-derived here.
 *
 * ⚠️ Invented channel ids and names only (90003…); the BR case reads its ids
 * and names from the committed `get_channel_list.br.json`, never typed.
 * ⚠️ No clock: nothing under `anuncios/` spells one, tests included.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_LOGISTICS_FEE_TYPE,
  shopeeChannelListPayloadSchema,
  shopeeChannelListSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  respostaCanaisShopeeSchema,
  type CanalDaLojaShopeeDto,
  type RespostaCanaisShopee,
} from '@delfrance/schemas';

import { FIXTURE_CHANNEL_LIST_BR, lerFixture } from '../fixtures/wireCorpus';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { lerCanaisDoRascunhoShopee } from './canaisDoRascunho';

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'p1';
const CANAL_A = 90003;
const CANAL_B = 90005;
const CANAL_C = 90007;
const CANAL_D = 90008;
const CANAL_E = 90009;

/** A parcel every unbounded channel takes: 0.5 kg, 10 × 10 × 10 cm, no free shipping. */
const PRODUTO_PADRAO: DocData = {
  nome: 'Produto de teste',
  pesoBrutoKg: 0.5,
  alturaCm: 10,
  larguraCm: 10,
  profundidadeCm: 10,
  ofereceFreteGratis: false,
};

/** One RAW channel row, as the wire carries it — the package's schema parses it below. */
function linha(id: number, parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    logistics_channel_id: id,
    logistics_channel_name: `Canal ${String(id)}`,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
    mask_channel_id: 0,
    ...parcial,
  };
}

/** The same row with `chave` ABSENT (the key itself, not a null). */
function semChave(bruta: Record<string, unknown>, chave: string): Record<string, unknown> {
  const resto = { ...bruta };
  expect(chave in resto, chave).toBe(true);
  delete resto[chave];
  return resto;
}

/** The row a fitting, selectable, unblocked channel answers for {@link PRODUTO_PADRAO}. */
function esperada(id: number, parcial: Partial<CanalDaLojaShopeeDto> = {}): CanalDaLojaShopeeDto {
  return {
    logisticsChannelId: id,
    nome: `Canal ${String(id)}`,
    selecionavel: true,
    obrigatorio: false,
    bloqueiaFreteGratisDoVendedor: false,
    indisponivel: null,
    automatica: { isFree: false },
    ...parcial,
  };
}

let db: FakeDb;
const getChannelList = vi.fn();
const client = { getChannelList } as unknown as ShopeeClient;

/** Serve these raw rows through the package's OWN payload schema — what the client resolves with. */
function servir(linhas: readonly Record<string, unknown>[]): void {
  getChannelList.mockResolvedValue(
    shopeeChannelListPayloadSchema.parse({ logistics_channel_list: linhas }),
  );
}

/**
 * Seed the produto, serve the rows, read once — and assert the two properties
 * every case shares: an `ok` answer that is a valid envelope EXACTLY (the
 * schema strips nothing from it), and zero writes.
 */
async function ler(
  linhas: readonly Record<string, unknown>[],
  produto: DocData = PRODUTO_PADRAO,
): Promise<RespostaCanaisShopee> {
  db.seed(`produtos/${PRODUTO}`, produto);
  servir(linhas);
  const lido = await lerCanaisDoRascunhoShopee({ db: asDb(db), client }, { produtoId: PRODUTO });
  if (lido.tipo !== 'ok') throw new TypeError(`esperava ok, veio ${lido.tipo}`);
  expect(respostaCanaisShopeeSchema.parse(lido.resposta)).toEqual(lido.resposta);
  expect(db.writes).toEqual([]);
  return lido.resposta;
}

function porId(resposta: RespostaCanaisShopee, id: number): CanalDaLojaShopeeDto | undefined {
  return resposta.canais.find((c) => c.logisticsChannelId === id);
}

beforeEach(() => {
  db = new FakeDb();
  getChannelList.mockReset();
});

/* -------------------------------------------------------------------------- */
/*                         (1) the produto, FIRST                              */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — lerCanaisDoRascunhoShopee: o produto primeiro', () => {
  it('o produto primeiro: ausente ⇒ produto-inexistente, getChannelList 0 vezes e nenhuma escrita', async () => {
    servir([linha(CANAL_A)]);

    const lido = await lerCanaisDoRascunhoShopee({ db: asDb(db), client }, { produtoId: PRODUTO });

    expect(lido).toEqual({ tipo: 'produto-inexistente' });
    expect(getChannelList).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
    // PAR: the same read once the produto exists answers ok, after ONE channel read.
    const resposta = await ler([linha(CANAL_A)]);
    expect(resposta.canais).toEqual([esperada(CANAL_A)]);
    expect(getChannelList).toHaveBeenCalledTimes(1);
  });

  it('uma leitura por chamada: duas chamadas ⇒ duas getChannelList', async () => {
    await ler([linha(CANAL_A)]);
    await ler([linha(CANAL_A)]);

    expect(getChannelList).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (2) the parcel, through the publisher's readers             */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — as medidas do produto pelos leitores do publicador', () => {
  /** A channel whose weight band has a real MINIMUM — what makes the gross-0 read bite. */
  const COM_MINIMO = linha(CANAL_A, {
    weight_limit: { item_min_weight: 0.1, item_max_weight: 30 },
  });

  it('⚠️ PAR: {pesoBrutoKg: 0, pesoLiquidoKg: 0.5} ≡ {pesoBrutoKg: 0.5} num canal com peso mínimo > 0 — mesmos vereditos, medidasCompletas true', async () => {
    // ÂNCORA: the minimum is a real bound — a parcel under it does not fit.
    const abaixo = await ler([COM_MINIMO], { ...PRODUTO_PADRAO, pesoBrutoKg: 0.05 });
    expect(porId(abaixo, CANAL_A)).toEqual(
      esperada(CANAL_A, {
        indisponivel: MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe,
        automatica: null,
      }),
    );

    const pelaLiquida = await ler([COM_MINIMO], {
      ...PRODUTO_PADRAO,
      pesoBrutoKg: 0,
      pesoLiquidoKg: 0.5,
    });
    const pelaBruta = await ler([COM_MINIMO], { ...PRODUTO_PADRAO, pesoBrutoKg: 0.5 });

    expect(pelaLiquida).toEqual(pelaBruta);
    expect(pelaLiquida).toEqual({ medidasCompletas: true, canais: [esperada(CANAL_A)] });
  });

  it('⛔ QUASE: sem peso ⇒ medidasCompletas false; ⛔ QUASE: só dois eixos ⇒ medidasCompletas false', async () => {
    const semPeso = await ler([linha(CANAL_A)], {
      ...PRODUTO_PADRAO,
      pesoBrutoKg: null,
      pesoLiquidoKg: null,
    });
    const doisEixos = await ler([linha(CANAL_A)], { ...PRODUTO_PADRAO, profundidadeCm: null });
    const completo = await ler([linha(CANAL_A)]);

    expect(semPeso.medidasCompletas).toBe(false);
    expect(doisEixos.medidasCompletas).toBe(false);
    // PAR: the same produto with both halves ⇒ true.
    expect(completo.medidasCompletas).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*              (3) selecionavel / obrigatorio come from the publisher         */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — selecionavel e obrigatorio vêm do publicador', () => {
  it('PAR: mask 0 ≡ mask ausente — ambos selecionáveis ⟷ QUASE: mask 4000 ⇒ selecionavel false, indisponivel null, automatica null', async () => {
    const resposta = await ler([
      linha(CANAL_A),
      semChave(linha(CANAL_B), 'mask_channel_id'),
      linha(CANAL_C, { mask_channel_id: 4000 }),
    ]);

    expect(resposta.canais).toEqual([
      esperada(CANAL_A),
      esperada(CANAL_B),
      esperada(CANAL_C, { selecionavel: false, indisponivel: null, automatica: null }),
    ]);
  });

  it('force_enable + enabled false ⇒ selecionavel true e obrigatorio true ⟷ QUASE: só enabled false ⇒ false e false; compulsory_channel ⇒ obrigatorio true', async () => {
    const resposta = await ler([
      linha(CANAL_A, { enabled: false, force_enable: true }),
      linha(CANAL_B, { enabled: false }),
      linha(CANAL_C, { compulsory_channel: true }),
    ]);

    expect(resposta.canais).toEqual([
      esperada(CANAL_A, { selecionavel: true, obrigatorio: true }),
      esperada(CANAL_B, {
        selecionavel: false,
        obrigatorio: false,
        indisponivel: null,
        automatica: null,
      }),
      esperada(CANAL_C, { obrigatorio: true }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (4) indisponivel — the exhaustive map                    */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — indisponivel: o motivo do publicador, em três palavras', () => {
  it('indisponivel: acima do peso, um eixo acima e a soma acima ⇒ nao-cabe', async () => {
    const resposta = await ler([
      linha(CANAL_A, { weight_limit: { item_max_weight: 0.4, item_min_weight: 0 } }),
      linha(CANAL_B, {
        item_max_dimension: { height: 5, width: 100, length: 100, unit: 'cm', dimension_sum: 0 },
      }),
      linha(CANAL_C, {
        item_max_dimension: { height: 0, width: 0, length: 0, unit: 'cm', dimension_sum: 25 },
      }),
      // ÂNCORA: the same limits in reach of the parcel ⇒ it fits.
      linha(CANAL_D, {
        weight_limit: { item_max_weight: 30, item_min_weight: 0 },
        item_max_dimension: { height: 50, width: 50, length: 50, unit: 'cm', dimension_sum: 100 },
      }),
    ]);

    const naoCabe = { indisponivel: MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe, automatica: null };
    expect(resposta.canais).toEqual([
      esperada(CANAL_A, naoCabe),
      esperada(CANAL_B, naoCabe),
      esperada(CANAL_C, naoCabe),
      esperada(CANAL_D),
    ]);
  });

  it.each(['CM', ' cm'])(
    "⛔ unidade '%s' com as três dimensões e o peso na faixa ⇒ limite-ilegivel, nunca nao-cabe",
    async (unidade) => {
      const resposta = await ler([
        linha(CANAL_A, {
          weight_limit: { item_max_weight: 30, item_min_weight: 0 },
          item_max_dimension: {
            height: 100,
            width: 100,
            length: 100,
            unit: unidade,
            dimension_sum: 300,
          },
        }),
        // PAR: the same bounds in `cm` ⇒ the parcel fits.
        linha(CANAL_B, {
          weight_limit: { item_max_weight: 30, item_min_weight: 0 },
          item_max_dimension: {
            height: 100,
            width: 100,
            length: 100,
            unit: 'cm',
            dimension_sum: 300,
          },
        }),
      ]);

      expect(resposta.canais).toEqual([
        esperada(CANAL_A, {
          indisponivel: MOTIVO_INDISPONIVEL_CANAL_SHOPEE.limiteIlegivel,
          automatica: null,
        }),
        esperada(CANAL_B),
      ]);
    },
  );

  it('SIZE_SELECTION e CUSTOM_PRICE ⇒ exige-valor-do-seller-centre; um SIZE_INPUT que cabe ⇒ null', async () => {
    const resposta = await ler([
      linha(CANAL_A, { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection }),
      linha(CANAL_B, { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice }),
      linha(CANAL_C, { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput }),
    ]);

    const exige = {
      indisponivel: MOTIVO_INDISPONIVEL_CANAL_SHOPEE.exigeValorDoSellerCentre,
      automatica: null,
    };
    expect(resposta.canais).toEqual([
      esperada(CANAL_A, exige),
      esperada(CANAL_B, exige),
      esperada(CANAL_C),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (5) automatica and free shipping                     */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — automatica e o frete grátis', () => {
  it('ofereceFreteGratis + bloqueio ⇒ bloqueiaFreteGratisDoVendedor true e automatica {isFree: false} ⟷ PAR: sem bloqueio ⇒ {isFree: true}', async () => {
    const resposta = await ler(
      [linha(CANAL_A, { block_seller_cover_shipping_fee: true }), linha(CANAL_B)],
      { ...PRODUTO_PADRAO, ofereceFreteGratis: true },
    );

    expect(resposta.canais).toEqual([
      esperada(CANAL_A, { bloqueiaFreteGratisDoVendedor: true, automatica: { isFree: false } }),
      esperada(CANAL_B, { automatica: { isFree: true } }),
    ]);
  });

  it('⛔ toda linha: automatica ⇔ selecionavel ∧ indisponivel null', async () => {
    const resposta = await ler([
      linha(CANAL_A),
      linha(CANAL_B, { weight_limit: { item_max_weight: 0.4, item_min_weight: 0 } }),
      linha(CANAL_C, { enabled: false }),
      linha(CANAL_D, { mask_channel_id: 4000 }),
      linha(CANAL_E, { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice }),
    ]);

    // ÂNCORA: at least one row of each class sits in this one table.
    const linhas = resposta.canais;
    expect(linhas.filter((c) => c.selecionavel && c.indisponivel === null).length).toBeGreaterThan(
      0,
    );
    expect(
      linhas.filter(
        (c) => c.selecionavel && c.indisponivel === MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe,
      ).length,
    ).toBeGreaterThan(0);
    expect(linhas.filter((c) => !c.selecionavel).length).toBeGreaterThan(0);

    for (const c of linhas) {
      expect(c.automatica !== null, String(c.logisticsChannelId)).toBe(
        c.selecionavel && c.indisponivel === null,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                 (6) the name                                */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — nome: o leitor do publicador (#1369)', () => {
  it("nome pelo leitor do publicador: '  X  ' ⇒ 'X' ⟷ QUASE: '   ' e '' ⇒ null", async () => {
    const resposta = await ler([
      linha(CANAL_A, { logistics_channel_name: '  Canal X  ' }),
      linha(CANAL_B, { logistics_channel_name: '   ' }),
      linha(CANAL_C, { logistics_channel_name: '' }),
      semChave(linha(CANAL_D), 'logistics_channel_name'),
    ]);

    expect(resposta.canais.map((c) => c.nome)).toEqual(['Canal X', null, null, null]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          (7) the committed BR body                          */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — BR: get_channel_list.br.json pela rota canais', () => {
  it('BR: get_channel_list.br.json ⇒ 4 linhas na ordem da lista; a desligada sem automatica e não selecionável; as outras 3 selecionáveis, não obrigatórias, sem bloqueio, automatica {isFree: false}; medidasCompletas true para 0,5 kg e 10×10×10; nome = o logistics_channel_name da própria linha da fixture', async () => {
    const cru = lerFixture(FIXTURE_CHANNEL_LIST_BR) as unknown as {
      response: {
        logistics_channel_list: {
          logistics_channel_id: number;
          logistics_channel_name: string;
          enabled: boolean;
        }[];
      };
    };
    const linhasCruas = cru.response.logistics_channel_list;
    expect(linhasCruas).toHaveLength(4);
    db.seed(`produtos/${PRODUTO}`, PRODUTO_PADRAO);
    getChannelList.mockResolvedValue(
      shopeeChannelListSchema.parse(lerFixture(FIXTURE_CHANNEL_LIST_BR)).response,
    );

    const lido = await lerCanaisDoRascunhoShopee({ db: asDb(db), client }, { produtoId: PRODUTO });
    if (lido.tipo !== 'ok') throw new TypeError(`esperava ok, veio ${lido.tipo}`);
    const resposta = respostaCanaisShopeeSchema.parse(lido.resposta);

    expect(resposta.medidasCompletas).toBe(true);
    expect(resposta.canais.map((c) => c.logisticsChannelId)).toEqual(
      linhasCruas.map((c) => c.logistics_channel_id),
    );
    // ÂNCORA: the body really holds one switched-off channel and three on.
    expect(linhasCruas.filter((c) => c.enabled === false)).toHaveLength(1);
    for (const [i, crua] of linhasCruas.entries()) {
      const c = resposta.canais[i];
      expect(c?.nome).toBe(crua.logistics_channel_name);
      if (crua.enabled === false) {
        expect(c).toMatchObject({ selecionavel: false, indisponivel: null, automatica: null });
      } else {
        expect(c).toMatchObject({
          selecionavel: true,
          obrigatorio: false,
          bloqueiaFreteGratisDoVendedor: false,
          indisponivel: null,
          automatica: { isFree: false },
        });
      }
    }
    expect(db.writes).toEqual([]);
    expect(getChannelList).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (8) one copy — the raw source pin                       */
/* -------------------------------------------------------------------------- */

describe('#1911 P15 — canaisDoRascunho.ts não tem regra de canal própria (#1369)', () => {
  const FONTE = readFileSync(
    fileURLToPath(new URL('./canaisDoRascunho.ts', import.meta.url)),
    'utf8',
  );

  it('canaisDoRascunho.ts compõe o publicador e não reimplementa regra de canal', () => {
    // ÂNCORA: the file really was read and really composes the one verdict.
    expect(FONTE).toContain('avaliarCanaisDaLojaShopee(');
    expect(FONTE).toContain('function lerCanaisDoRascunhoShopee(');

    // Raw text, comments included: a provider-rule read here is a second copy
    // of `logisticaPublicacao.ts`'s, whatever it is called.
    for (const proibido of [
      'cabeNoCanal(',
      'construirEntrada(',
      'construirLogistica(',
      'createReadCache',
      'armazenadoConfiavel',
      '.enabled',
      'mask_channel_id',
      'force_enable',
      'compulsory_channel',
      'SHOPEE_LOGISTICS_FEE_TYPE',
    ]) {
      expect(FONTE, proibido).not.toContain(proibido);
    }
    expect(FONTE).not.toMatch(/'SIZE_SELECTION'|'CUSTOM_PRICE'|'SIZE_INPUT'/);
  });
});
