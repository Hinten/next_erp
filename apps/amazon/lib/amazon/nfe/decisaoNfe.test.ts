/**
 * The two decision tables and the engine's plan (step 14, PR 14-b): one test
 * per row, the sibling rule first in both fases, and the near misses of the
 * lag rows. Payloads are built only through `tarefaNfe.ts`'s builders.
 */
import { describe, expect, it } from 'vitest';

import { makePedidoIdAmazon } from '../pedidos/orderIds';
import {
  ACAO_ENVIARIA_NFE_AMAZON,
  decidirEnvioNfeAmazon,
  decidirVerificacaoNfeAmazon,
  planoDeEnvioNfeAmazon,
} from './decisaoNfe';
import { MOTIVOS_NFE_QUE_CARIMBAM } from './motivosNfe';
import type { IrmaosDaNfeAmazon } from './pedidoNfe';
import { LEITURA_STATUS_NFE_AMAZON, type LeituraStatusNfe } from './statusNfe';
import {
  LEITURA_ANTES_NFE_AMAZON,
  type LeituraAntesNfeAmazon,
  type TarefaNfeAmazon,
  aposEnvioNfeAmazon,
  proximoDegrauNfeAmazon,
  reenvioNfeAmazon,
  tarefaInicialNfeAmazon,
} from './tarefaNfe';

const PEDIDO_ID = makePedidoIdAmazon('conta-teste', '171-9876543-2109876');

const L = {
  semNota: { tipo: LEITURA_STATUS_NFE_AMAZON.semNota },
  processando: { tipo: LEITURA_STATUS_NFE_AMAZON.processando },
  aceita: { tipo: LEITURA_STATUS_NFE_AMAZON.aceita },
  recusada: { tipo: LEITURA_STATUS_NFE_AMAZON.recusada },
  aceitaComRecusa: { tipo: LEITURA_STATUS_NFE_AMAZON.aceitaComRecusa },
  parcial: { tipo: LEITURA_STATUS_NFE_AMAZON.parcial },
  indeterminado: { tipo: LEITURA_STATUS_NFE_AMAZON.indeterminado, campo: 'errors', valor: null },
} as const satisfies Record<string, LeituraStatusNfe>;

const SOZINHA: IrmaosDaNfeAmazon = { outraElegivel: false, irmaCancelada: false };
const COM_CANCELADA: IrmaosDaNfeAmazon = { outraElegivel: false, irmaCancelada: true };
const AMBIGUA: IrmaosDaNfeAmazon = { outraElegivel: true, irmaCancelada: false };

/** A verification payload at `degrau`, through the builders only. */
function verificacao(
  degrau: number,
  o: { incerto?: boolean; reenvios?: 0 | 1; leituraAntes?: LeituraAntesNfeAmazon | null } = {},
): TarefaNfeAmazon {
  let envio = tarefaInicialNfeAmazon(PEDIDO_ID, 's1');
  if (o.reenvios === 1) {
    const r = reenvioNfeAmazon(aposEnvioNfeAmazon(envio, LEITURA_ANTES_NFE_AMAZON.semNota, true));
    if (r === null) throw new Error('anti-vacuity');
    envio = r;
  }
  let t = aposEnvioNfeAmazon(
    envio,
    o.leituraAntes === undefined ? LEITURA_ANTES_NFE_AMAZON.semNota : o.leituraAntes,
    o.incerto ?? false,
  );
  for (let i = 0; i < degrau; i++) {
    const p = proximoDegrauNfeAmazon(t);
    if (p === null) throw new Error('anti-vacuity');
    t = p;
  }
  return t;
}

describe('decidirEnvioNfeAmazon — the envio table', () => {
  it('sem-nota ⇒ enviar, carrying sem-nota as leituraAntes', () => {
    expect(decidirEnvioNfeAmazon(L.semNota, SOZINHA)).toEqual({
      acao: 'enviar',
      leituraAntes: 'sem-nota',
    });
  });

  it('recusada ⇒ enviar (a new edge or a re-drive after a refusal), carrying recusada', () => {
    expect(decidirEnvioNfeAmazon(L.recusada, SOZINHA)).toEqual({
      acao: 'enviar',
      leituraAntes: 'recusada',
    });
    // A cancelled sibling does not stop a submit when Amazon holds nothing live.
    expect(decidirEnvioNfeAmazon(L.semNota, COM_CANCELADA).acao).toBe('enviar');
  });

  it('★ mutation 10: processando, no cancelled sibling ⇒ verificar, NEVER a submit', () => {
    expect(decidirEnvioNfeAmazon(L.processando, SOZINHA)).toEqual({ acao: 'verificar' });
  });

  it('aceita, no cancelled sibling ⇒ the aceita path, never a submit', () => {
    expect(decidirEnvioNfeAmazon(L.aceita, SOZINHA)).toEqual({ acao: 'aceita' });
  });

  it('★ mutation 11: aceita or processando with a cancelled sibling ⇒ aviso nfe-substituta, no submit, no hand-off', () => {
    expect(decidirEnvioNfeAmazon(L.aceita, COM_CANCELADA)).toEqual({
      acao: 'avisar',
      motivo: 'nfe-substituta',
    });
    expect(decidirEnvioNfeAmazon(L.processando, COM_CANCELADA)).toEqual({
      acao: 'avisar',
      motivo: 'nfe-substituta',
    });
  });

  it('aceita-com-recusa or parcial ⇒ aviso nfe-parcialmente-aceita', () => {
    for (const l of [L.aceitaComRecusa, L.parcial]) {
      expect(decidirEnvioNfeAmazon(l, SOZINHA)).toEqual({
        acao: 'avisar',
        motivo: 'nfe-parcialmente-aceita',
      });
    }
  });

  it('indeterminado ⇒ aviso status-nfe-desconhecido', () => {
    expect(decidirEnvioNfeAmazon(L.indeterminado, SOZINHA)).toEqual({
      acao: 'avisar',
      motivo: 'status-nfe-desconhecido',
    });
  });

  it('★ mutation 24: outraElegivel ⇒ nfe-ambigua on EVERY reading — aceita and processando included', () => {
    for (const l of Object.values(L)) {
      expect(decidirEnvioNfeAmazon(l, AMBIGUA), l.tipo).toEqual({
        acao: 'avisar',
        motivo: 'nfe-ambigua',
      });
      expect(
        decidirEnvioNfeAmazon(l, { outraElegivel: true, irmaCancelada: true }),
        l.tipo,
      ).toEqual({ acao: 'avisar', motivo: 'nfe-ambigua' });
    }
  });
});

describe('decidirVerificacaoNfeAmazon — the verification table', () => {
  it('aceita, no cancelled sibling ⇒ the aceita path', () => {
    expect(decidirVerificacaoNfeAmazon(L.aceita, verificacao(3), SOZINHA)).toEqual({
      acao: 'aceita',
    });
  });

  it('aceita with a cancelled sibling ⇒ aviso nfe-substituta, no hand-off', () => {
    expect(decidirVerificacaoNfeAmazon(L.aceita, verificacao(3), COM_CANCELADA)).toEqual({
      acao: 'avisar',
      motivo: 'nfe-substituta',
    });
  });

  it('processando below the last rung ⇒ proximo-degrau (on every rung 0 … 8)', () => {
    for (let d = 0; d <= 8; d++) {
      expect(
        decidirVerificacaoNfeAmazon(L.processando, verificacao(d), SOZINHA),
        String(d),
      ).toEqual({
        acao: 'proximo-degrau',
      });
    }
  });

  it('★ mutation 13: processando at degrau 9 ⇒ aviso aceite-nao-confirmado, which does NOT stamp', () => {
    const d = decidirVerificacaoNfeAmazon(L.processando, verificacao(9), SOZINHA);
    expect(d).toEqual({ acao: 'avisar', motivo: 'aceite-nao-confirmado' });
    if (d.acao !== 'avisar') return;
    expect(MOTIVOS_NFE_QUE_CARIMBAM.has(d.motivo)).toBe(false);
  });

  it('sem-nota at degrau ≤ 1 ⇒ proximo-degrau (the lag), even after an uncertain submit', () => {
    for (const d of [0, 1]) {
      expect(decidirVerificacaoNfeAmazon(L.semNota, verificacao(d), SOZINHA)).toEqual({
        acao: 'proximo-degrau',
      });
      expect(
        decidirVerificacaoNfeAmazon(L.semNota, verificacao(d, { incerto: true }), SOZINHA),
      ).toEqual({ acao: 'proximo-degrau' });
    }
  });

  it('sem-nota from degrau 2 after a CONFIRMED submit ⇒ aviso + stamp nfe-nao-registrada', () => {
    for (const d of [2, 5, 9]) {
      const r = decidirVerificacaoNfeAmazon(L.semNota, verificacao(d), SOZINHA);
      expect(r, String(d)).toEqual({ acao: 'avisar', motivo: 'nfe-nao-registrada' });
      if (r.acao === 'avisar') expect(MOTIVOS_NFE_QUE_CARIMBAM.has(r.motivo)).toBe(true);
    }
  });

  it('★ sem-nota from degrau 2 in a chain that NEVER submitted (its envio read processando) ⇒ aviso envio-nao-confirmado: no stamp, no resubmit', () => {
    // The chain exactly as the handler builds it: an envio that read
    // `processando`, so `verificar` → `aposEnvioNfeAmazon(t, null, false)`.
    expect(decidirEnvioNfeAmazon(L.processando, SOZINHA)).toEqual({ acao: 'verificar' });
    for (const d of [2, 5, 9]) {
      const r = decidirVerificacaoNfeAmazon(
        L.semNota,
        verificacao(d, { leituraAntes: null }),
        SOZINHA,
      );
      expect(r, String(d)).toEqual({ acao: 'avisar', motivo: 'envio-nao-confirmado' });
      if (r.acao === 'avisar') expect(MOTIVOS_NFE_QUE_CARIMBAM.has(r.motivo)).toBe(false);
    }
    // The same from a re-drive's envio (reenvios 1) that read `processando`.
    const reenvio = reenvioNfeAmazon(verificacao(2, { incerto: true }));
    if (reenvio === null) throw new Error('anti-vacuity');
    let t = aposEnvioNfeAmazon(reenvio, null, false);
    for (let i = 0; i < 2; i++) t = proximoDegrauNfeAmazon(t) ?? t;
    expect(t).toMatchObject({ degrau: 2, reenvios: 1, leituraAntes: null });
    expect(decidirVerificacaoNfeAmazon(L.semNota, t, SOZINHA)).toEqual({
      acao: 'avisar',
      motivo: 'envio-nao-confirmado',
    });
    // NEAR-MISS: the same rung after OUR confirmed submit still stamps.
    const r = decidirVerificacaoNfeAmazon(
      L.semNota,
      verificacao(2, { leituraAntes: LEITURA_ANTES_NFE_AMAZON.semNota }),
      SOZINHA,
    );
    expect(r).toEqual({ acao: 'avisar', motivo: 'nfe-nao-registrada' });
  });

  it('sem-nota from degrau 2 after an UNCERTAIN submit, reenvios 0 ⇒ reenviar (the chain’s one resubmit)', () => {
    expect(
      decidirVerificacaoNfeAmazon(L.semNota, verificacao(2, { incerto: true }), SOZINHA),
    ).toEqual({ acao: 'reenviar' });
  });

  it('★ mutation 12: sem-nota after an uncertain submit with reenvios 1 ⇒ aviso envio-nao-confirmado, never a second resubmit', () => {
    const r = decidirVerificacaoNfeAmazon(
      L.semNota,
      verificacao(2, { incerto: true, reenvios: 1 }),
      SOZINHA,
    );
    expect(r).toEqual({ acao: 'avisar', motivo: 'envio-nao-confirmado' });
    if (r.acao === 'avisar') expect(MOTIVOS_NFE_QUE_CARIMBAM.has(r.motivo)).toBe(false);
  });

  it('★ mutation 23: recusada at degrau 0 or 1 with leituraAntes recusada ⇒ proximo-degrau (the OLD rejection may still show)', () => {
    for (const d of [0, 1]) {
      expect(
        decidirVerificacaoNfeAmazon(
          L.recusada,
          verificacao(d, { leituraAntes: LEITURA_ANTES_NFE_AMAZON.recusada }),
          SOZINHA,
        ),
        String(d),
      ).toEqual({ acao: 'proximo-degrau' });
    }
  });

  it('★ NEAR-MISS: recusada at degrau 0 with leituraAntes sem-nota (or none) ⇒ aviso + stamp nfe-recusada', () => {
    for (const leituraAntes of [LEITURA_ANTES_NFE_AMAZON.semNota, null]) {
      const r = decidirVerificacaoNfeAmazon(L.recusada, verificacao(0, { leituraAntes }), SOZINHA);
      expect(r).toEqual({ acao: 'avisar', motivo: 'nfe-recusada' });
      if (r.acao === 'avisar') expect(MOTIVOS_NFE_QUE_CARIMBAM.has(r.motivo)).toBe(true);
    }
  });

  it('recusada from degrau 2 ⇒ nfe-recusada, whatever leituraAntes says (the lag is over)', () => {
    expect(
      decidirVerificacaoNfeAmazon(
        L.recusada,
        verificacao(2, { leituraAntes: LEITURA_ANTES_NFE_AMAZON.recusada }),
        SOZINHA,
      ),
    ).toEqual({ acao: 'avisar', motivo: 'nfe-recusada' });
  });

  it('aceita-com-recusa and parcial ⇒ aviso nfe-parcialmente-aceita, no stamp, no hand-off (the owner default)', () => {
    for (const l of [L.aceitaComRecusa, L.parcial]) {
      const r = decidirVerificacaoNfeAmazon(
        l,
        verificacao(1, { leituraAntes: LEITURA_ANTES_NFE_AMAZON.recusada }),
        SOZINHA,
      );
      expect(r).toEqual({ acao: 'avisar', motivo: 'nfe-parcialmente-aceita' });
      if (r.acao === 'avisar') expect(MOTIVOS_NFE_QUE_CARIMBAM.has(r.motivo)).toBe(false);
    }
  });

  it('indeterminado ⇒ aviso status-nfe-desconhecido', () => {
    expect(decidirVerificacaoNfeAmazon(L.indeterminado, verificacao(4), SOZINHA)).toEqual({
      acao: 'avisar',
      motivo: 'status-nfe-desconhecido',
    });
  });

  it('★ mutation 24: outraElegivel ⇒ nfe-ambigua on every reading, aceita and processando included', () => {
    for (const l of Object.values(L)) {
      expect(decidirVerificacaoNfeAmazon(l, verificacao(3), AMBIGUA), l.tipo).toEqual({
        acao: 'avisar',
        motivo: 'nfe-ambigua',
      });
    }
  });

  it('a verification never answers enviar, on any reading, rung or payload', () => {
    for (const l of Object.values(L)) {
      for (let d = 0; d <= 9; d++) {
        for (const incerto of [false, true]) {
          for (const reenvios of [0, 1] as const) {
            const r = decidirVerificacaoNfeAmazon(
              l,
              verificacao(d, { incerto, reenvios }),
              SOZINHA,
            );
            expect(r.acao).not.toBe('enviar');
            if (r.acao === 'reenviar') {
              // The ONLY resubmit: an uncertain submit, from degrau 2, never spent.
              expect([l.tipo, incerto, reenvios, d >= 2]).toEqual(['sem-nota', true, 0, true]);
            }
            // A chain that never submitted never resubmits either.
            expect(
              decidirVerificacaoNfeAmazon(
                l,
                verificacao(d, { incerto, reenvios, leituraAntes: null }),
                SOZINHA,
              ).acao,
            ).not.toBe('reenviar');
          }
        }
      }
    }
  });
});

describe('planoDeEnvioNfeAmazon — the engine’s plan', () => {
  it('a planned submit writes, and its dry-run diff says enviaria + the reading', () => {
    const p = planoDeEnvioNfeAmazon(L.semNota, SOZINHA);
    expect(p.escrever).toBe(true);
    expect(p.diff).toEqual({
      acao: ACAO_ENVIARIA_NFE_AMAZON,
      statusAmazon: 'sem-nota',
      motivo: null,
    });
    expect(p.decisao).toEqual({ acao: 'enviar', leituraAntes: 'sem-nota' });
  });

  it('★ mutation 10/11: processando, aceita, and a cancelled sibling never write', () => {
    expect(planoDeEnvioNfeAmazon(L.processando, SOZINHA)).toMatchObject({
      escrever: false,
      diff: { acao: 'verificar', statusAmazon: 'processando', motivo: null },
    });
    expect(planoDeEnvioNfeAmazon(L.aceita, SOZINHA).escrever).toBe(false);
    expect(planoDeEnvioNfeAmazon(L.aceita, COM_CANCELADA)).toMatchObject({
      escrever: false,
      diff: { acao: 'avisar', statusAmazon: 'aceita', motivo: 'nfe-substituta' },
    });
    expect(planoDeEnvioNfeAmazon(L.semNota, AMBIGUA).escrever).toBe(false);
  });

  it('the diff carries only primitives and closed codes', () => {
    for (const l of Object.values(L)) {
      for (const v of Object.values(planoDeEnvioNfeAmazon(l, SOZINHA).diff)) {
        expect(v === null || typeof v === 'string').toBe(true);
      }
    }
  });
});
