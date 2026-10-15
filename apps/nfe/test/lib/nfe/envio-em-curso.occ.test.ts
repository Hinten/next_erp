/**
 * #1675 — the send-reservation CLAIMS under real optimistic concurrency.
 *
 * The orchestrator suites re-enter an emit from inside the SOAP mock, which
 * proves what happens AFTER a claim committed. What they cannot show is two
 * claim transactions racing each other: both read the doc unclaimed, both
 * decide to claim. Here the shared OCC engine (`@delfrance/data/testing`) holds
 * one run at its commit until the other has committed; the held run must then
 * abort, re-run its callback, and decide again on the fresh snapshot — never
 * re-apply a decision captured before the retry (root `CLAUDE.md` rule 7).
 */
import { describe, expect, it, vi } from 'vitest';

import { deferred } from '@delfrance/data/testing';
import { CONTINGENCIA_MODO, AMBIENTE_NFE, ESTADO_NFE, type NFeConfig } from '@delfrance/schemas';

import { gravarAncoraDoLote, reivindicarEnvio } from '../../../lib/nfe/orchestrator/audit';
import { runAllocateGenerateSignTx, type EmissionPrep } from '../../../lib/nfe/orchestrator/emitir';
import { FirestoreOcc } from '../../helpers/occFirestore';

const NFE = 'pedidos/PED-1/nfev4/s1';
const S4 = 'pedidos/PED-1/nfev4/s4';
const CFG = 'filiais/F-1/nfeconfig/default';
const CHAVE = '35260514200166000187550010000000071000000018';
const ARMAZENADO = '<NFe><infNFe>…armazenado…</infNFe><Signature>…</Signature></NFe>';

const CONFIG: NFeConfig = {
  numeracao_atual: 12,
  serie: 1,
  idLote: 4,
  ambiente: AMBIENTE_NFE.homologacao,
  emitirReformaTributaria: false,
  contingencia_modo: CONTINGENCIA_MODO.none,
  contingencia_justificativa: null,
  contingencia_dataInicio: null,
  timestamp: null,
};

/** A #396 crash-window anchor: chave + stored bytes, in flight, no receipt, no reservation. */
function ancora(): Record<string, unknown> {
  return {
    numeracao: 12,
    serie: 1,
    tpEmis: 1,
    estado: ESTADO_NFE.enviando,
    filialId: 'F-1',
    chave: CHAVE,
    idLote: '4',
    xml_assinado: ARMAZENADO,
    nRec: null,
    retries: 0,
    cStat: null,
    xMotivo: null,
    proximaConsultaEm: null,
  };
}

/** Just what `runAllocateGenerateSignTx` reads on the crash-window branch. */
function prepPara(db: FirestoreOcc): EmissionPrep {
  return {
    bundle: { pedidoId: 'PED-1', filialId: 'F-1' },
    items: [],
    tpEmis: 1,
    contingencia: { modo: CONTINGENCIA_MODO.none, dhCont: null, xJust: null },
    emitRtc: false,
    nfeRef: db.ref(NFE),
    nfeConfigRef: db.ref(CFG),
  } as never;
}

/**
 * Hold the FIRST run to reach its commit until released. `segurado` resolves
 * once that run is parked at its commit.
 */
function segurarOPrimeiro(db: FirestoreOcc): { soltar: () => void; segurado: Promise<void> } {
  const libera = deferred();
  const parado = deferred();
  let primeira = true;
  db.occ.beforeCommit = async () => {
    if (primeira) {
      primeira = false;
      parado.resolve();
      await libera.promise;
    }
  };
  return { soltar: () => libera.resolve(), segurado: parado.promise };
}

async function esperarUmCommit(db: FirestoreOcc): Promise<void> {
  await vi.waitFor(() => {
    expect(db.occ.txLog.some((e) => e.phase === 'commit')).toBe(true);
  });
}

describe('#1675 — the claims under real OCC', () => {
  it('two emits claiming one crash-window anchor together: exactly ONE claims; the other’s retry re-reads the reservation and skips — idLote advanced once', async () => {
    const db = new FirestoreOcc();
    db.semear(NFE, ancora());
    db.semear(CFG, CONFIG as unknown as Record<string, unknown>);
    const { soltar } = segurarOPrimeiro(db);

    const a = runAllocateGenerateSignTx(db.comoFirestore(), {} as never, prepPara(db));
    const b = runAllocateGenerateSignTx(db.comoFirestore(), {} as never, prepPara(db));
    await esperarUmCommit(db);
    soltar();
    const resultados = await Promise.all([a, b]);

    const reivindicados = resultados.filter((r) => !r.skip);
    const pulados = resultados.filter((r) => r.skip);
    expect(reivindicados).toHaveLength(1);
    expect(reivindicados[0]).toMatchObject({ idLote: 5, storedBytes: true, signedXml: ARMAZENADO });
    expect(pulados).toHaveLength(1);
    expect(pulados[0]).toMatchObject({ existing: { estado: ESTADO_NFE.enviando, idLote: '5' } });
    // The held run lost the version check and retried — not a lucky ordering.
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    expect(db.dados(CFG)).toMatchObject({ idLote: 5 });
    expect(db.dados(NFE)).toMatchObject({ idLote: '5', xml_assinado: ARMAZENADO });
    expect(db.dados(NFE)!.proximaConsultaEm as number).toBeGreaterThan(Date.now() * 1000);
  });

  it('two pós-EPEC claims of one EPEC-approved doc: exactly ONE transmits', async () => {
    const db = new FirestoreOcc();
    db.semear(S4, {
      ...ancora(),
      tpEmis: 4,
      estado: ESTADO_NFE.epecAprovado,
      cStat: '135',
      xMotivo: 'Evento registrado',
    });
    const { soltar } = segurarOPrimeiro(db);

    const a = reivindicarEnvio(db.comoFirestore(), db.ref(S4) as never, 7);
    const b = reivindicarEnvio(db.comoFirestore(), db.ref(S4) as never, 8);
    await esperarUmCommit(db);
    soltar();
    const [ra, rb] = await Promise.all([a, b]);

    expect([ra.claimed, rb.claimed].filter(Boolean)).toHaveLength(1);
    const vencedor = ra.claimed ? 7 : 8;
    expect(db.dados(S4)).toMatchObject({
      estado: ESTADO_NFE.epecAprovado,
      idLote: String(vencedor),
      xml_assinado: ARMAZENADO,
    });
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
  });

  it('batch 4b’s anchor write against a single emit’s claim committing first: the 4b write is refused on its retry', async () => {
    const db = new FirestoreOcc();
    // The 4a placeholder of lote 5: chave-less, stamped with the chunk's idLote.
    db.semear(NFE, { ...ancora(), chave: null, xml_assinado: null, idLote: '5' });
    db.semear(CFG, CONFIG as unknown as Record<string, unknown>);
    const { soltar, segurado } = segurarOPrimeiro(db);
    const docData = {
      ...ancora(),
      chave: CHAVE,
      idLote: '5',
      xml_assinado: '<NFe>…do lote…</NFe>',
    };

    const quatroB = gravarAncoraDoLote(db.comoFirestore(), db.ref(NFE) as never, docData, 5);
    await segurado;
    // A single emit claims the same doc (lote 6) and commits while 4b is held.
    await db.occ.runTransaction(async (tx) => {
      await tx.get(db.ref(NFE));
      tx.set(db.ref(NFE), { ...docData, idLote: '6', xml_assinado: '<NFe>…da única…</NFe>' });
    });
    soltar();
    const r = await quatroB;

    expect(r).toMatchObject({ written: false, estadoAtual: ESTADO_NFE.enviando });
    expect(db.dados(NFE)).toMatchObject({ idLote: '6', xml_assinado: '<NFe>…da única…</NFe>' });
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
  });
});
