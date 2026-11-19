/**
 * The drift blocks' I/O (step 12, PR 12-f) against the counting fake: the
 * page's OVERWRITE, its TTL stamp, and the reader — by id, never a query, a
 * missing id an empty block, the depósito through the ONE parse.
 * PLACEHOLDERS ONLY (public repository).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { TTL_POLICIES, idDivergenciaEstoqueAmazon } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS } from '../testing/fixtures';
import {
  DivergenciaEstoqueInvalidaError,
  MAX_BLOCOS_POR_LEITURA_ESTOQUE_AMAZON,
  RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS,
  gravarBlocoDivergenciaEstoqueAmazon,
  lerBlocosDivergenciaEstoqueAmazon,
} from './divergenciasFirestore';

const CONTA = 'conta-amz-blocos';
const EXEC = 'exec-blocos-1';
const DEP = 'dep-blocos-1';
const caminho = (n: number, exec = EXEC) =>
  `reconciliacaoEstoqueAmazon/${CONTA}/divergenciasEstoqueAmazon/${idDivergenciaEstoqueAmazon(exec, n)}`;
const item = (sku: string, quantidadeAmazon: number | null = 2) => ({
  sku,
  unidadeId: `p-${sku}`,
  quantidadeAmazon,
  quantidadeErp: 7,
});

let fake: FakeDb;
beforeEach(() => {
  fake = new FakeDb();
});

const gravar = (pagina: number, itens: ReturnType<typeof item>[], agoraMs = AGORA_MS) =>
  gravarBlocoDivergenciaEstoqueAmazon(asDb(fake), {
    contaId: CONTA,
    execucaoId: EXEC,
    pagina,
    depositoId: DEP,
    itens,
    agoraMs,
  });
const ler = (partes: number, execucaoId = EXEC, parteInicial = 0) =>
  lerBlocosDivergenciaEstoqueAmazon(asDb(fake), {
    contaId: CONTA,
    execucaoId,
    parteInicial,
    partes,
  });

describe('the write: the page’s OVERWRITE', () => {
  it('★ a full set at {execucaoId}-{n}: items sorted by SKU, the canonical depósito ref, the TTL stamp 7 days on', async () => {
    await gravar(2, [item('SKU-B'), item('SKU-A', null)]);
    expect(fake.escritasEm(caminho(2)).map((e) => e.verbo)).toEqual(['set']);
    const bloco = fake.ler(caminho(2));
    expect(bloco).toMatchObject({
      execucaoId: EXEC,
      depositoOuterRef: `documents/depositos/${DEP}`,
      itens: [item('SKU-A', null), item('SKU-B')],
    });
    expect(bloco?.expiraEm).toBeInstanceOf(Date);
    expect((bloco?.expiraEm as Date).getTime()).toBe(AGORA_MS + 7 * DIA_MS);
    expect(RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS).toBe(7);
  });

  it('★ a retried page REPLACES the block whole (NEAR-MISS: a create would keep the old block under the new counters)', async () => {
    await gravar(0, [item('SKU-A'), item('SKU-B'), item('SKU-C')]);
    await gravar(0, [item('SKU-C')], AGORA_MS + 60_000);
    expect(fake.escritasEm(caminho(0)).map((e) => e.verbo)).toEqual(['set', 'set']);
    expect(fake.ler(caminho(0))?.itens).toEqual([item('SKU-C')]);
    // An empty block is written too: it overwrites what a crashed attempt found.
    await gravar(0, []);
    expect(fake.ler(caminho(0))?.itens).toEqual([]);
  });

  it('the TTL policy is the registry’s: one TTL_POLICIES row for the group', () => {
    expect(
      TTL_POLICIES.filter((p) => p.collectionGroup === 'divergenciasEstoqueAmazon'),
    ).toHaveLength(1);
  });

  it('refuses, writing nothing: a run or page outside its grammar, a depósito id that is not a document id, more than 300 items', async () => {
    await expect(
      gravarBlocoDivergenciaEstoqueAmazon(asDb(fake), {
        contaId: CONTA,
        execucaoId: 'a:b',
        pagina: 0,
        depositoId: DEP,
        itens: [],
        agoraMs: AGORA_MS,
      }),
    ).rejects.toThrow(RangeError);
    await expect(gravar(-1, [])).rejects.toThrow(RangeError);
    await expect(
      gravarBlocoDivergenciaEstoqueAmazon(asDb(fake), {
        contaId: CONTA,
        execucaoId: EXEC,
        pagina: 0,
        depositoId: 'a/b',
        itens: [],
        agoraMs: AGORA_MS,
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      gravar(
        0,
        Array.from({ length: 301 }, (_v, i) => item(`SKU-${String(i)}`)),
      ),
    ).rejects.toThrow();
    expect(fake.escritas).toEqual([]);
  });
});

describe('the read: by id, never a query', () => {
  it('★ ONE getAll of {execucaoId}-{0..partes−1}, in page order; a missing id is an EMPTY block; no query at all', async () => {
    await gravar(0, [item('SKU-A')]);
    await gravar(2, [item('SKU-C'), item('SKU-D')]);
    const blocos = await ler(3);
    expect(blocos).toEqual([
      { pagina: 0, existe: true, depositoId: DEP, itens: [item('SKU-A')] },
      { pagina: 1, existe: false, depositoId: null, itens: [] },
      { pagina: 2, existe: true, depositoId: DEP, itens: [item('SKU-C'), item('SKU-D')] },
    ]);
    expect(fake.contagem).toMatchObject({ chamadasGetAll: 1, consultas: 0 });
    expect(fake.leiturasDetalhadas.map((l) => l.caminho)).toEqual([
      caminho(0),
      caminho(1),
      caminho(2),
    ]);
  });

  it('★ partes comes from the CALLER: another run’s blocks are never read, and partes beyond the written ones read as empty', async () => {
    await gravar(0, [item('SKU-A')]);
    await gravarBlocoDivergenciaEstoqueAmazon(asDb(fake), {
      contaId: CONTA,
      execucaoId: 'exec-outro',
      pagina: 1,
      depositoId: DEP,
      itens: [item('SKU-X')],
      agoraMs: AGORA_MS,
    });
    const blocos = await ler(2);
    expect(blocos.flatMap((b) => b.itens)).toEqual([item('SKU-A')]);
  });

  it('more than 300 parts are read in getAll calls of at most 300 ids', async () => {
    expect(MAX_BLOCOS_POR_LEITURA_ESTOQUE_AMAZON).toBe(300);
    const blocos = await ler(301);
    expect(blocos).toHaveLength(301);
    expect(fake.contagem).toMatchObject({ chamadasGetAll: 2, leituras: 301, consultas: 0 });
    expect(blocos.at(-1)?.pagina).toBe(300);
  });

  it('★ a stored block that does not parse, or names another run, THROWS (never read as empty)', async () => {
    fake.seed(caminho(0), { execucaoId: EXEC, depositoOuterRef: 'depositos/x', itens: [] });
    await expect(ler(1)).rejects.toThrow(DivergenciaEstoqueInvalidaError);
    await expect(ler(1)).rejects.toMatchObject({ campos: ['depositoOuterRef', 'expiraEm'] });
    fake.seed(caminho(0), {
      execucaoId: 'exec-outro',
      depositoOuterRef: `documents/depositos/${DEP}`,
      itens: [],
      expiraEm: new Date(AGORA_MS),
    });
    await expect(ler(1)).rejects.toMatchObject({ campos: ['execucaoId'] });
  });

  it('refuses partes that is not a positive safe integer, reading nothing', async () => {
    for (const partes of [0, -1, 1.5]) await expect(ler(partes)).rejects.toThrow(RangeError);
    expect(fake.operacoes).toBe(0);
  });

  it('★ a RANGE: ONE getAll of exactly {execucaoId}-{parteInicial..parteInicial+partes−1}, each block under its own page number (NEAR-MISS: the blocks just outside the range exist and are not read)', async () => {
    for (const n of [0, 1, 2, 3, 4]) await gravar(n, [item(`SKU-${String(n)}`)]);
    const leiturasAntes = fake.leiturasDetalhadas.length;

    const blocos = await ler(2, EXEC, 2);

    expect(blocos.map((b) => [b.pagina, b.itens.map((x) => x.sku)])).toEqual([
      [2, ['SKU-2']],
      [3, ['SKU-3']],
    ]);
    expect(fake.contagem).toMatchObject({ chamadasGetAll: 1, consultas: 0 });
    expect(fake.leiturasDetalhadas.slice(leiturasAntes).map((l) => l.caminho)).toEqual([
      caminho(2),
      caminho(3),
    ]);
  });

  it('refuses parteInicial that is not a non-negative safe integer, or a last part past the safe integers, reading nothing', async () => {
    for (const inicial of [-1, 1.5]) {
      // Refused by the reader's own guard, naming the field (not by a block id's grammar later).
      await expect(ler(1, EXEC, inicial)).rejects.toThrow(RangeError);
      await expect(ler(1, EXEC, inicial)).rejects.toThrow(/parteInicial/);
    }
    await expect(ler(2, EXEC, Number.MAX_SAFE_INTEGER)).rejects.toThrow(RangeError);
    // The reader's own guard, before any block id is built (not the id's grammar later).
    await expect(ler(2, EXEC, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/última parte/);
    expect(fake.operacoes).toBe(0);
    // NEAR-MISS: the last safe integer itself is a part number a range can end on.
    expect(await ler(1, EXEC, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });
});
