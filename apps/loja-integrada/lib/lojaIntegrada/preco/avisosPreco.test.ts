/**
 * `avisosPreco.ts` (master plan step 13, PR 13-d): the price send run's ONE aviso tipo,
 * `lojaIntegradaPrecoRecusado` — its key, its params per motivo, its clock (the dispatch start),
 * and a resolve that reads first and writes only an OPEN row. The REAL `escreverAviso` and
 * `resolverAviso` run against the fake Firestore. Invented ids only.
 */
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  MOTIVO_PRECO_RECUSADO_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
} from '@delfrance/schemas';

import { relogioDoEnvioDePrecoUs } from '../avisos/avisos';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, caminhoAviso } from '../testing/fixtures';
import {
  MOTIVO_RESOLUCAO_PRECO_LI,
  type ProdutoDoAvisoPrecoLi,
  avisarPrecoRecusadoLi,
  chaveDoAvisoPrecoRecusadoLi,
  resolverPrecoRecusadoLi,
} from './avisosPreco';

const CONTA = 'conta-li-preco';
const PRODUTO = 'p-filho-preco';
const CAMINHO = caminhoAviso(chaveDoAvisoPrecoRecusadoLi(CONTA, PRODUTO));

const produto = (inicioDaTarefaMs = AGORA_MS): ProdutoDoAvisoPrecoLi => ({
  integracaoId: CONTA,
  lojaNome: 'Loja P',
  produtoId: PRODUTO,
  idLi: '1001',
  inicioDaTarefaMs,
});

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

describe('the key, and a raise per motivo', () => {
  it('one row per (conta, produto): `lojaIntegradaPrecoRecusado:<conta>:<produto>`', () => {
    expect(chaveDoAvisoPrecoRecusadoLi(CONTA, PRODUTO)).toBe(
      `lojaIntegradaPrecoRecusado:${CONTA}:${PRODUTO}`,
    );
    expect(chaveDoAvisoPrecoRecusadoLi(CONTA, 'outro')).not.toBe(
      chaveDoAvisoPrecoRecusadoLi(CONTA, PRODUTO),
    );
  });

  it('`recusado`: the params name the store, the produto, the store id (TEXT), the code and the status (a NUMBER); the clock is the DISPATCH START', async () => {
    const db = new FakeDb();
    const inicio = AGORA_MS - 5_000;
    expect(
      await avisarPrecoRecusadoLi(
        asDb(db),
        produto(inicio),
        { motivo: MOTIVO_PRECO_RECUSADO_LI.recusado, status: 400 },
        deps(),
      ),
    ).toBe('criado');
    expect(db.ler(CAMINHO)).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaPrecoRecusado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.lojaIntegrada,
      urlInterna: { rota: ROTAS_AVISO.produto.build(PRODUTO), campo: null },
      params: { loja: 'Loja P', produto: PRODUTO, idLi: '1001', motivo: 'recusado', status: 400 },
      motivo: 'recusado',
      relogioEvento: relogioDoEnvioDePrecoUs(inicio),
      resolvidoEm: null,
    });
    expect(relogioDoEnvioDePrecoUs(inicio)).toBe(inicio * 1000);
  });

  it('⚠️ NEAR-MISS: `nao-refletido` carries NO status key at all', async () => {
    const db = new FakeDb();
    await avisarPrecoRecusadoLi(
      asDb(db),
      produto(),
      { motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido },
      deps(),
    );
    const linha = db.ler(CAMINHO);
    expect(linha?.params).toEqual({
      loja: 'Loja P',
      produto: PRODUTO,
      idLi: '1001',
      motivo: 'nao-refletido',
    });
    expect(Object.hasOwn((linha?.params ?? {}) as object, 'status')).toBe(false);
    expect(linha?.motivo).toBe('nao-refletido');
  });

  it('a later `nao-refletido` over an open `recusado` row replaces the params whole: no stale status', async () => {
    const db = new FakeDb();
    await avisarPrecoRecusadoLi(
      asDb(db),
      produto(AGORA_MS - 60_000),
      { motivo: MOTIVO_PRECO_RECUSADO_LI.recusado, status: 400 },
      deps(),
    );
    expect(
      await avisarPrecoRecusadoLi(
        asDb(db),
        produto(),
        { motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido },
        deps(),
      ),
    ).toBe('repetido');
    expect(db.ler(CAMINHO)).toMatchObject({ motivo: 'nao-refletido', resolvidoEm: null });
    expect(Object.hasOwn((db.ler(CAMINHO)?.params ?? {}) as object, 'status')).toBe(false);
  });

  it('an OLDER run’s raise is dropped by the clock (never reopens or rewrites a newer row)', async () => {
    const db = new FakeDb();
    await avisarPrecoRecusadoLi(
      asDb(db),
      produto(),
      { motivo: MOTIVO_PRECO_RECUSADO_LI.naoRefletido },
      deps(),
    );
    expect(
      await avisarPrecoRecusadoLi(
        asDb(db),
        produto(AGORA_MS - 1),
        { motivo: MOTIVO_PRECO_RECUSADO_LI.recusado, status: 400 },
        deps(),
      ),
    ).toBe('ignorado');
    expect(db.ler(CAMINHO)?.motivo).toBe('nao-refletido');
  });
});

describe('the resolve reads first and writes only an OPEN row', () => {
  async function abrir(db: FakeDb, inicio: number): Promise<void> {
    await avisarPrecoRecusadoLi(
      asDb(db),
      produto(inicio),
      { motivo: MOTIVO_PRECO_RECUSADO_LI.recusado, status: 400 },
      deps(inicio),
    );
  }

  it('open ⇒ resolved `preco-enviado`, its clock advanced to this run’s dispatch start', async () => {
    const db = new FakeDb();
    await abrir(db, AGORA_MS - 3_600_000);
    const escritasAntes = db.escritas.length;
    expect(await resolverPrecoRecusadoLi(asDb(db), produto(), deps())).toBe(true);
    expect(db.ler(CAMINHO)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_PRECO_LI.enviado,
      relogioEvento: AGORA_MS * 1000,
    });
    expect(db.ler(CAMINHO)?.resolvidoEm).not.toBeNull();
    expect(db.escritas.length).toBe(escritasAntes + 1);
    expect(MOTIVO_RESOLUCAO_PRECO_LI.enviado).toBe('preco-enviado');
  });

  it('⚠️ NO row ⇒ ONE read and ZERO writes (a clocked resolve would seed one)', async () => {
    const db = new FakeDb();
    expect(await resolverPrecoRecusadoLi(asDb(db), produto(), deps())).toBe(false);
    expect(db.leituras).toEqual([CAMINHO]);
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ an ALREADY resolved row ⇒ zero writes', async () => {
    const db = new FakeDb();
    await abrir(db, AGORA_MS - 3_600_000);
    await resolverPrecoRecusadoLi(asDb(db), produto(AGORA_MS - 1_000), deps());
    const escritasAntes = db.escritas.length;
    expect(await resolverPrecoRecusadoLi(asDb(db), produto(), deps())).toBe(false);
    expect(db.escritas.length).toBe(escritasAntes);
  });

  it('a NEWER run’s open row is never closed by an older run (the clock)', async () => {
    const db = new FakeDb();
    await abrir(db, AGORA_MS + 60_000);
    expect(await resolverPrecoRecusadoLi(asDb(db), produto(), deps())).toBe(false);
    expect(db.ler(CAMINHO)?.resolvidoEm).toBeNull();
  });
});
