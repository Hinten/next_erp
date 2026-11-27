/**
 * The parts of a price run (step 13, PR 13-e), offline against
 * `testing/fakeDb.ts`: the holding page's overwrite by id (a re-run page REPLACES the
 * part whole, members in SKU order, the TTL stamp a real `Date` seven days
 * after the page), the reads by id under a mask that never returns the TTL
 * stamp, in `getAll` slices, a missing part counted and never thrown, and a
 * stored part that does not parse or names another run refused.
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  type ItemDivergenciaPrecoAmazon,
  MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
  RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS,
  TIPO_OFERTA_PRECO_AMAZON,
  idDivergenciaPrecoAmazon,
} from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { DIA_MS } from '../testing/fixtures';
import {
  CAMPOS_LEITURA_PARTE_PRECO_AMAZON,
  DivergenciaPrecoInvalidaError,
  MAX_PARTES_POR_LEITURA_PRECO_AMAZON,
  gravarParteDivergenciaPrecoAmazon,
  lerParteDivergenciaPrecoAmazon,
  lerPartesDivergenciaPrecoAmazon,
} from './divergenciasPrecoFirestore';

const CONTA = 'conta-preco-partes';
const EXEC = 'exec-partes';
const AGORA_MS = 1_800_000_000_000;
const parte = (n: number, exec = EXEC) =>
  `precosAmazon/${CONTA}/divergenciasPrecoAmazon/${idDivergenciaPrecoAmazon(exec, n)}`;

/** One sendable SKU as a page writes it. */
function item(sku: string, base = 50): ItemDivergenciaPrecoAmazon {
  return {
    sku,
    vinculo: `produtos/p-${sku}/prodAmazon/l-${sku}`,
    unidadeId: `p-${sku}`,
    oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 60, minimo: 60, maximo: 60 },
    faixa: { base, minimo: base, maximo: base },
    tipoProduto: 'PRODUCT',
    lidoEmMs: AGORA_MS - 1_000,
  };
}

function fakeDb(): FakeDb {
  const fake = new FakeDb();
  fake.exigirMascaraEm('divergenciasPrecoAmazon');
  return fake;
}

const gravar = (fake: FakeDb, n: number, itens: ItemDivergenciaPrecoAmazon[], exec = EXEC) =>
  gravarParteDivergenciaPrecoAmazon(asDb(fake), {
    contaId: CONTA,
    execucaoId: exec,
    parte: n,
    itens,
    agoraMs: AGORA_MS,
  });

const ler = (fake: FakeDb, parteInicial: number, partes: number) =>
  lerPartesDivergenciaPrecoAmazon(asDb(fake), {
    contaId: CONTA,
    execucaoId: EXEC,
    parteInicial,
    partes,
  });

describe('gravarParteDivergenciaPrecoAmazon — the holding page’s overwrite by id', () => {
  it('★ ONE full set at the part’s id under the run: members in SKU order, the TTL stamp a Date seven days after the page', async () => {
    const fake = fakeDb();
    await gravar(fake, 3, [item('B'), item('A'), item('C')]);
    expect(fake.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['set', parte(3)]]);
    const guardada = fake.ler(parte(3)) ?? {};
    expect((guardada.itens as ItemDivergenciaPrecoAmazon[]).map((i) => i.sku)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(guardada.execucaoId).toBe(EXEC);
    expect(guardada.expiraEm).toBeInstanceOf(Date);
    expect((guardada.expiraEm as Date).getTime()).toBe(
      AGORA_MS + RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS * DIA_MS,
    );
    expect(RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS).toBe(7);
  });

  it('★ a re-run page REPLACES the part whole (the same id, fewer members): nothing of the earlier write survives', async () => {
    const fake = fakeDb();
    await gravar(fake, 0, [item('A', 50), item('B'), item('C')]);
    await gravar(fake, 0, [item('A', 45)]);
    const [lida] = await ler(fake, 0, 1);
    expect(lida?.itens).toEqual([item('A', 45)]);
    expect(fake.escritasEm(parte(0)).map((e) => e.verbo)).toEqual(['set', 'set']);
  });

  it('NEAR-MISS: another part or another run is another id — never overwritten', async () => {
    const fake = fakeDb();
    await gravar(fake, 0, [item('A')]);
    await gravar(fake, 1, [item('B')]);
    await gravar(fake, 0, [item('X')], 'exec-outra');
    expect(fake.caminhos().sort()).toEqual([parte(0), parte(0, 'exec-outra'), parte(1)].sort());
    expect((await ler(fake, 0, 2)).map((p) => p.itens.map((i) => i.sku))).toEqual([['A'], ['B']]);
  });

  it('★ a page with NO sendable SKU writes no part: the schema refuses an empty one (dense parts)', async () => {
    const fake = fakeDb();
    await expect(gravar(fake, 0, [])).rejects.toBeInstanceOf(ZodError);
    expect(fake.escritas).toEqual([]);
  });

  it(`the part numbers stop at ${String(MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1)} and a part holds at most ${String(MAX_ITENS_DIVERGENCIA_PRECO_AMAZON)} SKUs: refused, nothing written`, async () => {
    const fake = fakeDb();
    await expect(
      gravar(fake, MAX_PARTES_EXECUCAO_PRECO_AMAZON, [item('A')]),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      gravar(
        fake,
        0,
        Array.from({ length: MAX_ITENS_DIVERGENCIA_PRECO_AMAZON + 1 }, (_v, i) =>
          item(`S${String(i)}`),
        ),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(fake.escritas).toEqual([]);
    // NEAR-MISS: the last part number and a full part are written.
    await gravar(fake, MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1, [item('A')]);
    await gravar(
      fake,
      0,
      Array.from({ length: MAX_ITENS_DIVERGENCIA_PRECO_AMAZON }, (_v, i) => item(`S${String(i)}`)),
    );
    expect(fake.escritas).toHaveLength(2);
  });

  it('a conta or a run outside its grammar writes nothing', async () => {
    const fake = fakeDb();
    await expect(
      gravarParteDivergenciaPrecoAmazon(asDb(fake), {
        contaId: 'a/b',
        execucaoId: EXEC,
        parte: 0,
        itens: [item('A')],
        agoraMs: AGORA_MS,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(gravar(fake, 0, [item('A')], 'exec/1')).rejects.toBeInstanceOf(RangeError);
    expect(fake.escritas).toEqual([]);
  });
});

describe('lerPartesDivergenciaPrecoAmazon — by id, masked, never a query', () => {
  it('★ every read is masked to the run id and the members: the TTL stamp never comes back', async () => {
    const fake = fakeDb();
    await gravar(fake, 0, [item('A')]);
    const lida = await lerParteDivergenciaPrecoAmazon(asDb(fake), {
      contaId: CONTA,
      execucaoId: EXEC,
      parte: 0,
    });
    expect(lida).toEqual({ parte: 0, existe: true, itens: [item('A')] });
    expect(fake.leiturasDetalhadas).toEqual([
      {
        caminho: parte(0),
        via: 'getAll',
        chamada: 1,
        mascara: [...CAMPOS_LEITURA_PARTE_PRECO_AMAZON],
      },
    ]);
    expect(CAMPOS_LEITURA_PARTE_PRECO_AMAZON).toEqual(['execucaoId', 'itens']);
    expect(fake.consultas).toEqual([]);
  });

  it('★ a missing part (its TTL passed) reads existe: false with no member — counted, never thrown', async () => {
    const fake = fakeDb();
    await gravar(fake, 1, [item('B')]);
    expect((await ler(fake, 0, 3)).map((p) => [p.parte, p.existe, p.itens.length])).toEqual([
      [0, false, 0],
      [1, true, 1],
      [2, false, 0],
    ]);
  });

  it('★ a range is read in getAll slices of at most 50 ids (a part holds up to 300 members), in part order', async () => {
    expect(MAX_PARTES_POR_LEITURA_PRECO_AMAZON).toBe(50);
    const fake = fakeDb();
    const total = 51;
    await gravar(fake, total - 1, [item('Z')]);
    const lidas = await ler(fake, 0, total);
    expect(lidas.map((p) => p.parte)).toEqual(Array.from({ length: total }, (_v, i) => i));
    expect(lidas.at(-1)?.itens).toEqual([item('Z')]);
    expect(fake.contagem.chamadasGetAll).toBe(2);
    expect(fake.leiturasDetalhadas.filter((l) => l.chamada === 1)).toHaveLength(
      MAX_PARTES_POR_LEITURA_PRECO_AMAZON,
    );
  });

  it('★ a stored part that names ANOTHER run under this run’s id is refused, never read as this run’s', async () => {
    const fake = fakeDb();
    await gravar(fake, 0, [item('A')], 'exec-outra');
    fake.seed(parte(0), fake.ler(parte(0, 'exec-outra')) ?? {});
    const erro = await ler(fake, 0, 1).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(DivergenciaPrecoInvalidaError);
    expect((erro as DivergenciaPrecoInvalidaError).campos).toEqual(['execucaoId']);
  });

  it('a stored part that does not parse is refused, naming its fields', async () => {
    const fake = fakeDb();
    fake.seed(parte(0), { execucaoId: EXEC, itens: [{ sku: 'A' }] });
    const erro = await ler(fake, 0, 1).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(DivergenciaPrecoInvalidaError);
    expect((erro as DivergenciaPrecoInvalidaError).campos).toEqual(['itens']);
  });

  it('a range outside the run’s part numbers is refused before ANY read', async () => {
    const fake = fakeDb();
    for (const [inicial, partes] of [
      [0, 0],
      [-1, 1],
      [0.5, 1],
      [MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1, 2],
    ] as const) {
      await expect(
        ler(fake, inicial, partes),
        `${String(inicial)}+${String(partes)}`,
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(fake.operacoes).toBe(0);
    // NEAR-MISS: the last part alone is read.
    await ler(fake, MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1, 1);
    expect(fake.contagem.leituras).toBe(1);
  });
});
