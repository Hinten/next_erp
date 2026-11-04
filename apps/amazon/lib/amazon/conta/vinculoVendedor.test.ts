import { beforeEach, describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { SPID_A, SPID_B, caminhoConta, seedConta } from '../testing/fixtures';
import {
  MAX_TENTATIVAS_VINCULO,
  decidirVinculoVendedor,
  gravarVendedor,
  lerVinculo,
} from './vinculoVendedor';

const ID = 'conta-1';
let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

describe('decidirVinculoVendedor (pure, exact)', () => {
  it.each([
    ['no conta', null, [], 'conta-ausente'],
    ['a fresh conta', { selling_partner_id: null }, [], 'gravar'],
    ['the same seller (a reauthorization)', { selling_partner_id: SPID_A }, [], 'mesmo-vendedor'],
    ['another seller', { selling_partner_id: SPID_B }, [], 'vendedor-diferente'],
    // Near-misses: exact comparison, no fold, no trim.
    [
      'the same id in another case',
      { selling_partner_id: SPID_A.toLowerCase() },
      [],
      'vendedor-diferente',
    ],
    ['the same id with a space', { selling_partner_id: `${SPID_A} ` }, [], 'vendedor-diferente'],
    [
      'a fresh conta, another ACTIVE holder',
      { selling_partner_id: null },
      ['c2'],
      'vendedor-em-outra-conta',
    ],
    [
      'the same seller, another ACTIVE holder too',
      { selling_partner_id: SPID_A },
      ['c2'],
      'vendedor-em-outra-conta',
    ],
    [
      'another seller AND another holder',
      { selling_partner_id: SPID_B },
      ['c2'],
      'vendedor-diferente',
    ],
  ] as const)('%s → %s', (_c, conta, outras, esperado) => {
    expect(decidirVinculoVendedor(conta, SPID_A, outras)).toBe(esperado);
  });

  it('a legacy non-string id reads as a DIFFERENT seller (fails safe)', () => {
    const conta = { selling_partner_id: 12345 as unknown as string };
    expect(decidirVinculoVendedor(conta, SPID_A, [])).toBe('vendedor-diferente');
  });
});

describe('lerVinculo', () => {
  it('excludes THIS conta from the other holders, and an INACTIVE holder does not block', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedConta(db, 'inativa', { selling_partner_id: SPID_A, ativo: false });
    expect((await lerVinculo(asDb(db), ID, SPID_A)).decisao).toBe('mesmo-vendedor');
  });

  it('another tipo holding the same id does not block', async () => {
    seedConta(db, ID);
    seedConta(db, 'shopee', { selling_partner_id: SPID_A, tipo: INTEGRACAO_TIPO.shopee });
    expect((await lerVinculo(asDb(db), ID, SPID_A)).decisao).toBe('gravar');
  });
});

describe('gravarVendedor — tier 1', () => {
  it('writes ONLY selling_partner_id, as an update under lastUpdateTime', async () => {
    seedConta(db, ID);
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('gravado');
    const [escrita] = db.escritasEm(caminhoConta(ID));
    expect(escrita?.verbo).toBe('update');
    expect(escrita?.comPrecondicao).toBe(true);
    expect(escrita?.dados).toEqual({ selling_partner_id: SPID_A });
    expect(db.ler(caminhoConta(ID))?.selling_partner_id).toBe(SPID_A);
  });

  it('the same seller → no write', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('mesmo-vendedor');
    expect(db.escritas).toHaveLength(0);
  });

  it('an operator editing `nome` between the guard and the write → attempt 2 succeeds, nome kept', async () => {
    seedConta(db, ID, { nome: 'Antes' });
    db.antesDaProximaEscrita(caminhoConta(ID), () => {
      seedConta(db, ID, { nome: 'Depois' });
    });
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('gravado');
    expect(db.ler(caminhoConta(ID))).toMatchObject({ nome: 'Depois', selling_partner_id: SPID_A });
  });

  it('a seller bound by ANOTHER writer between the guard and the write → re-decided, refused', async () => {
    seedConta(db, ID);
    db.antesDaProximaEscrita(caminhoConta(ID), () => {
      seedConta(db, ID, { selling_partner_id: SPID_B });
    });
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('vendedor-diferente');
    expect(db.ler(caminhoConta(ID))?.selling_partner_id).toBe(SPID_B);
  });

  it(`${String(MAX_TENTATIVAS_VINCULO)} lost preconditions → conflito, nothing written`, async () => {
    seedConta(db, ID);
    let restantes = MAX_TENTATIVAS_VINCULO;
    const editar = (): void => {
      restantes -= 1;
      seedConta(db, ID, { nome: `Edição ${String(restantes)}` });
      if (restantes > 0) db.antesDaProximaEscrita(caminhoConta(ID), editar);
    };
    db.antesDaProximaEscrita(caminhoConta(ID), editar);
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('conflito');
    expect(db.ler(caminhoConta(ID))?.selling_partner_id).toBeNull();
    expect(db.escritas).toHaveLength(0);
  });

  it('the conta deleted between the guard and the write → conta-ausente, NEVER resurrected', async () => {
    seedConta(db, ID);
    db.antesDaProximaEscrita(caminhoConta(ID), () => {
      db.apagar(caminhoConta(ID));
    });
    expect(await gravarVendedor(asDb(db), ID, SPID_A)).toBe('conta-ausente');
    expect(db.ler(caminhoConta(ID))).toBeUndefined();
  });

  it('a non-precondition failure rethrows', async () => {
    seedConta(db, ID);
    db.falharEscrita(caminhoConta(ID), grpc(14, 'UNAVAILABLE'));
    await expect(gravarVendedor(asDb(db), ID, SPID_A)).rejects.toMatchObject({ code: 14 });
  });
});
