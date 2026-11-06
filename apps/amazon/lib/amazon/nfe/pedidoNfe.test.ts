/**
 * The pedido and NF-e-document decisions (step 14, PR 14-b): the ownership
 * proof, the emission block and the stored pre-filter, the live-read floor,
 * the slot rule, the sibling rules and the a→c arm. Pure; raw documents only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESTADO_NFE, MARKETPLACE_PEDIDO_TIPO } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { ESTADOS_TERMINAIS_AMAZON, FULFILLED_BY_AMAZON } from '../pedidos/estadoPedidoAmazon';
import {
  ATENDIDO_PELA_AMAZON,
  PROGRAMA_DBA_AMAZON,
  SEM_NFE_APROVADA_AMAZON,
  ESTADOS_VENDA_CANCELADA_AMAZON,
  avaliarPedidoParaNfeAmazon,
  avaliarPedidoParaTarefaNfeAmazon,
  cancelamentoDeNfeAprovadaAmazon,
  escolherNfeParaEnvioAmazon,
  irmaosDaNfeAmazon,
  notaDeVendaCanceladaAmazon,
  pisoDoPedidoAmazon,
  provaDeIdentidadeAmazon,
  vendaCanceladaAmazon,
} from './pedidoNfe';

const AQUI = fileURLToPath(new URL('.', import.meta.url));

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const REF_CONTA = `documents/integracao/${CONTA}`;

/** A raw pedido the Amazon importer could have written. */
function pedido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { numero: ORDER, integracaoPedidoOuterRef: REF_CONTA, ...extra };
}

/** A synthetic proc: `tpNF`/`finNFe` and the production `tpAmb`; no real party. */
function proc(tpNF = '1', finNFe = '1', tpAmb = '1'): string {
  return (
    `<nfeProc><NFe><infNFe><ide><tpAmb>${tpAmb}</tpAmb><tpNF>${tpNF}</tpNF>` +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

/** A raw `nfev4` document, ready by default. */
function nfe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc(), ...extra };
}

describe('provaDeIdentidadeAmazon', () => {
  it('★ a pedido whose id recomputes from (conta, order) is proved, and both are recovered', () => {
    expect(provaDeIdentidadeAmazon(PEDIDO_ID, pedido())).toEqual({
      contaId: CONTA,
      orderId: ORDER,
    });
    // Every ref form the stored field may hold.
    for (const ref of [`integracao/${CONTA}`, `/documents/integracao/${CONTA}`, CONTA]) {
      expect(
        provaDeIdentidadeAmazon(PEDIDO_ID, pedido({ integracaoPedidoOuterRef: ref })),
        ref,
      ).not.toBeNull();
    }
  });

  it.each<[string, Record<string, unknown> | null]>([
    ['another conta', pedido({ integracaoPedidoOuterRef: 'documents/integracao/outra' })],
    ['another order', pedido({ numero: '171-9876543-2109877' })],
    ['a Shopee-shaped number', pedido({ numero: '240901ABCDEFGH' })],
    ['a malformed number (spaces)', pedido({ numero: ` ${ORDER}` })],
    ['a number that is not a string', pedido({ numero: 17198765432109876 })],
    ['no ref', pedido({ integracaoPedidoOuterRef: undefined })],
    ['a ref with an illegal conta id', pedido({ integracaoPedidoOuterRef: 'integracao/a b' })],
    ['a null pedido', null],
    ['only the marker field (★ mutation 9)', { marketplace: { tipo: 'amazon' } }],
  ])('★ %s ⇒ null, never a throw', (_r, raw) => {
    expect(() => provaDeIdentidadeAmazon(PEDIDO_ID, raw)).not.toThrow();
    expect(provaDeIdentidadeAmazon(PEDIDO_ID, raw)).toBeNull();
  });

  it('★ mutation 9: the marker field proves nothing — a stored marketplace.tipo amazon on a pedido whose id does not recompute is not ours', () => {
    const outro = makePedidoIdAmazon('outra-conta', ORDER);
    expect(
      provaDeIdentidadeAmazon(
        outro,
        pedido({ marketplace: { tipo: MARKETPLACE_PEDIDO_TIPO.amazon } }),
      ),
    ).toBeNull();
  });
});

describe('avaliarPedidoParaNfeAmazon', () => {
  it('a proved pedido with no stored evidence (a migrated one) is accepted', () => {
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, pedido())).toEqual({
      ok: true,
      contaId: CONTA,
      orderId: ORDER,
    });
  });

  it('not proved ⇒ nao-amazon (a missing pedido too)', () => {
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, null)).toEqual({
      ok: false,
      motivo: 'nao-amazon',
    });
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, pedido({ numero: 'x' }))).toEqual({
      ok: false,
      motivo: 'nao-amazon',
    });
  });

  it('★ bloquearEmissaoNFe true ⇒ emissao-bloqueada; NEAR-MISS a truthy non-boolean is not the flag', () => {
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, pedido({ bloquearEmissaoNFe: true }))).toEqual({
      ok: false,
      motivo: 'emissao-bloqueada',
    });
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, pedido({ bloquearEmissaoNFe: 'true' })).ok).toBe(
      true,
    );
  });

  it('the stored pre-filter: our block with fulfilledBy AMAZON, or a programs LIST without the DBA key ⇒ nao-dba', () => {
    const mk = (m: Record<string, unknown>) =>
      avaliarPedidoParaNfeAmazon(PEDIDO_ID, pedido({ marketplace: { tipo: 'amazon', ...m } }));
    expect(mk({ fulfilledBy: 'AMAZON' })).toEqual({ ok: false, motivo: 'nao-dba' });
    expect(mk({ fulfilledBy: 'MERCHANT', programs: ['PRIME'] })).toEqual({
      ok: false,
      motivo: 'nao-dba',
    });
    expect(mk({ fulfilledBy: 'MERCHANT', programs: [] })).toEqual({ ok: false, motivo: 'nao-dba' });
  });

  it('NEAR-MISS: absent evidence says nothing — no block, a block of another tipo, null programs, or the DBA key (never AMAZON_EASY_SHIP)', () => {
    const ok = (raw: Record<string, unknown>) => avaliarPedidoParaNfeAmazon(PEDIDO_ID, raw).ok;
    expect(ok(pedido())).toBe(true);
    expect(ok(pedido({ marketplace: { tipo: 'shopee', fulfilledBy: 'AMAZON' } }))).toBe(true);
    expect(
      ok(pedido({ marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: null } })),
    ).toBe(true);
    expect(
      ok(
        pedido({
          marketplace: { tipo: 'amazon', fulfilledBy: null, programs: [PROGRAMA_DBA_AMAZON] },
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        pedido({
          marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT', programs: ['AMAZON_EASY_SHIP'] },
        }),
      ),
    ).toBe(false);
  });

  it('the order: the proof before the block, the block before the pre-filter', () => {
    expect(
      avaliarPedidoParaNfeAmazon(PEDIDO_ID, {
        bloquearEmissaoNFe: true,
        marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' },
      }),
    ).toEqual({ ok: false, motivo: 'nao-amazon' });
    expect(
      avaliarPedidoParaNfeAmazon(
        PEDIDO_ID,
        pedido({
          bloquearEmissaoNFe: true,
          marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' },
        }),
      ),
    ).toEqual({ ok: false, motivo: 'emissao-bloqueada' });
  });

  it('★ (14-c) the TASK’s verdict is the proof and the block, NEVER the stored pre-filter (DBA is decided live)', () => {
    const naoDba = pedido({ marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' } });
    // The trigger's verdict drops it; the task's lets the live gate decide.
    expect(avaliarPedidoParaNfeAmazon(PEDIDO_ID, naoDba)).toEqual({ ok: false, motivo: 'nao-dba' });
    expect(avaliarPedidoParaTarefaNfeAmazon(PEDIDO_ID, naoDba)).toEqual({
      ok: true,
      contaId: CONTA,
      orderId: ORDER,
    });
    expect(avaliarPedidoParaTarefaNfeAmazon(PEDIDO_ID, null)).toEqual({
      ok: false,
      motivo: 'nao-amazon',
    });
    expect(
      avaliarPedidoParaTarefaNfeAmazon(PEDIDO_ID, pedido({ bloquearEmissaoNFe: true })),
    ).toEqual({ ok: false, motivo: 'emissao-bloqueada' });
  });

  it('★ (14-c) the cancelled-sale set is EQUAL to the importer’s terminal pair; vendaCanceladaAmazon reads it exactly', () => {
    expect([...ESTADOS_VENDA_CANCELADA_AMAZON].sort()).toEqual(
      [...ESTADOS_TERMINAIS_AMAZON].sort(),
    );
    expect([...ESTADOS_VENDA_CANCELADA_AMAZON].sort()).toEqual([
      'cancelado',
      'estornadoIntegralmente',
    ]);
    expect(vendaCanceladaAmazon(pedido({ estado: 'cancelado' }))).toBe(true);
    expect(vendaCanceladaAmazon(pedido({ estado: 'estornadoIntegralmente' }))).toBe(true);
    // NEAR-MISSES: a live estado, another spelling, an absent pedido.
    expect(vendaCanceladaAmazon(pedido({ estado: 'pago' }))).toBe(false);
    expect(vendaCanceladaAmazon(pedido({ estado: 'Cancelado' }))).toBe(false);
    expect(vendaCanceladaAmazon(null)).toBe(false);
  });

  it('the two stored values this module spells equal the importer’s constants (kept out of pedidos/ on purpose)', () => {
    expect(ATENDIDO_PELA_AMAZON).toBe(FULFILLED_BY_AMAZON.amazon);
    expect(PROGRAMA_DBA_AMAZON).toBe('DELIVERY_BY_AMAZON');
  });

  it('LIGHT: pedidoNfe.ts imports from pedidos/ only orderIds.ts (the trigger’s future closure)', () => {
    const texto = readFileSync(join(AQUI, 'pedidoNfe.ts'), 'utf8');
    const relativos = [...texto.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]).sort();
    expect(relativos).toEqual(['../pedidos/orderIds', './motivosNfe']);
  });
});

describe('pisoDoPedidoAmazon', () => {
  it('★ a pedido our importer wrote ⇒ its stored order clock, in µs', () => {
    expect(
      pisoDoPedidoAmazon(
        pedido({ marketplace: { tipo: 'amazon' }, lastMarketplaceUpdate: 1_790_000_000_000_000 }),
      ),
    ).toBe(1_790_000_000_000_000);
    // A legacy ms integer reads as µs through the tolerant reader.
    expect(
      pisoDoPedidoAmazon(
        pedido({ marketplace: { tipo: 'amazon' }, lastMarketplaceUpdate: 1_790_000_000_000 }),
      ),
    ).toBe(1_790_000_000_000_000);
  });

  it('★ NEAR-MISS: a legacy pedido without marketplace (or of another tipo) ⇒ null, whatever its stamp', () => {
    expect(pisoDoPedidoAmazon(pedido({ lastMarketplaceUpdate: 1_790_000_000_000_000 }))).toBeNull();
    expect(
      pisoDoPedidoAmazon(
        pedido({ marketplace: { tipo: 'shopee' }, lastMarketplaceUpdate: 1_790_000_000_000_000 }),
      ),
    ).toBeNull();
    expect(pisoDoPedidoAmazon(null)).toBeNull();
    expect(pisoDoPedidoAmazon(pedido({ marketplace: { tipo: 'amazon' } }))).toBeNull();
  });
});

describe('escolherNfeParaEnvioAmazon — the slot rule', () => {
  it('★ the latest data_autorizacao wins', () => {
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 's1', raw: nfe({ data_autorizacao: 1_000 }) },
        { id: 's9', raw: nfe({ data_autorizacao: 2_000 }) },
      ]),
    ).toEqual({ nfeId: 's9' });
  });

  it('★ a tie goes to the lowest id; an unknown date counts as the oldest', () => {
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 's9', raw: nfe({ data_autorizacao: 2_000 }) },
        { id: 's1', raw: nfe({ data_autorizacao: 2_000 }) },
      ]),
    ).toEqual({ nfeId: 's1' });
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 'a', raw: nfe() },
        { id: 'z', raw: nfe({ data_autorizacao: 1 }) },
      ]),
    ).toEqual({ nfeId: 'z' });
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 'b', raw: nfe() },
        { id: 'a', raw: nfe() },
      ]),
    ).toEqual({
      nfeId: 'a',
    });
  });

  it('★ a cancelled slot is never chosen, whatever its date', () => {
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 's1', raw: nfe({ estado: ESTADO_NFE.cancelada, data_autorizacao: 9_000 }) },
        { id: 's9', raw: nfe({ data_autorizacao: 1_000 }) },
      ]),
    ).toEqual({ nfeId: 's9' });
  });

  it('nothing eligible ⇒ the furthest miss; an illegible proc stays eligible (the task judges it)', () => {
    expect(escolherNfeParaEnvioAmazon([])).toEqual({ motivo: SEM_NFE_APROVADA_AMAZON });
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 'a', raw: nfe({ estado: ESTADO_NFE.cancelada }) },
        { id: 'b', raw: nfe({ xml_nfe_proc: null }) },
        { id: 'c', raw: nfe({ xml_nfe_proc: proc('1', '1', '2') }) },
      ]),
    ).toEqual({ motivo: 'tpamb-homologacao' });
    expect(
      escolherNfeParaEnvioAmazon([
        { id: 'c', raw: nfe({ xml_nfe_proc: proc('1', '1', '2') }) },
        { id: 'd', raw: nfe({ xml_nfe_proc: proc('1', '4') }) },
      ]),
    ).toEqual({ motivo: 'nfe-nao-e-de-venda' });
    expect(
      escolherNfeParaEnvioAmazon([{ id: 'e', raw: nfe({ xml_nfe_proc: proc('', '1') }) }]),
    ).toEqual({ nfeId: 'e' });
  });
});

describe('irmaosDaNfeAmazon', () => {
  it('★ one cancelled sale document beside ours ⇒ irmaCancelada', () => {
    expect(
      irmaosDaNfeAmazon('s1', [
        { id: 's1', raw: nfe() },
        { id: 's9', raw: nfe({ estado: ESTADO_NFE.cancelada }) },
      ]),
    ).toEqual({ outraElegivel: false, irmaCancelada: true });
    // A cancelled doc with its proc gone still counts.
    expect(
      irmaosDaNfeAmazon('s1', [
        { id: 's9', raw: nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: null }) },
      ]),
    ).toEqual({ outraElegivel: false, irmaCancelada: true });
    // ★ So does one whose proc is present but ILLEGIBLE: only a LEGIBLE
    // non-sale note is excluded (its near miss, a cancelled devolução, below).
    expect(
      irmaosDaNfeAmazon('s1', [
        { id: 's9', raw: nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('', '1') }) },
      ]),
    ).toEqual({ outraElegivel: false, irmaCancelada: true });
  });

  it('★ two aprovada sale documents ⇒ outraElegivel (ours is skipped by id)', () => {
    expect(
      irmaosDaNfeAmazon('s1', [
        { id: 's1', raw: nfe() },
        { id: 's9', raw: nfe() },
      ]),
    ).toEqual({ outraElegivel: true, irmaCancelada: false });
  });

  it('NEAR-MISS: ours alone, a cancelled devolução, a homologação or proc-less sibling ⇒ nothing', () => {
    expect(irmaosDaNfeAmazon('s1', [{ id: 's1', raw: nfe() }])).toEqual({
      outraElegivel: false,
      irmaCancelada: false,
    });
    expect(
      irmaosDaNfeAmazon('s1', [
        { id: 's1', raw: nfe({ estado: ESTADO_NFE.cancelada }) },
        { id: 'd', raw: nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('0', '4') }) },
        { id: 'h', raw: nfe({ xml_nfe_proc: proc('1', '1', '2') }) },
        { id: 'x', raw: nfe({ xml_nfe_proc: null }) },
        { id: 'v', raw: nfe({ xml_nfe_proc: proc('1', '4') }) },
      ]),
    ).toEqual({ outraElegivel: false, irmaCancelada: false });
  });
});

describe('notaDeVendaCanceladaAmazon — the sibling reader’s cancelled-sale test, exported (step 15)', () => {
  it('★ a cancelled sale note ⇒ true — its proc gone or illegible included', () => {
    expect(notaDeVendaCanceladaAmazon(nfe({ estado: ESTADO_NFE.cancelada }))).toBe(true);
    expect(
      notaDeVendaCanceladaAmazon(nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: null })),
    ).toBe(true);
    expect(
      notaDeVendaCanceladaAmazon(
        nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('', '1') }),
      ),
    ).toBe(true);
  });

  it('NEAR-MISS: a cancelled devolução (a legible non-sale proc), an aprovada note, an error note ⇒ false', () => {
    expect(
      notaDeVendaCanceladaAmazon(
        nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('0', '4') }),
      ),
    ).toBe(false);
    expect(notaDeVendaCanceladaAmazon(nfe())).toBe(false);
    expect(notaDeVendaCanceladaAmazon(nfe({ estado: ESTADO_NFE.error }))).toBe(false);
  });

  it('agrees with irmaosDaNfeAmazon on every sibling (one rule, the reader calls it)', () => {
    const casos = [
      nfe({ estado: ESTADO_NFE.cancelada }),
      nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: null }),
      nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('0', '4') }),
      nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('1', '1', '2') }),
      nfe(),
    ];
    for (const raw of casos) {
      expect(irmaosDaNfeAmazon('nossa', [{ id: 'irma', raw }]).irmaCancelada).toBe(
        notaDeVendaCanceladaAmazon(raw),
      );
    }
  });
});

describe('cancelamentoDeNfeAprovadaAmazon — the a→c arm', () => {
  it('★ a ready aprovada document → c ⇒ true', () => {
    expect(cancelamentoDeNfeAprovadaAmazon(nfe(), nfe({ estado: ESTADO_NFE.cancelada }))).toBe(
      true,
    );
    // An illegible proc stays eligible (the slot and sibling readers' rule).
    expect(
      cancelamentoDeNfeAprovadaAmazon(
        nfe({ xml_nfe_proc: proc('', '1') }),
        nfe({ estado: ESTADO_NFE.cancelada }),
      ),
    ).toBe(true);
  });

  it.each<[string, Record<string, unknown> | undefined, Record<string, unknown> | undefined]>([
    ['e → c', nfe({ estado: ESTADO_NFE.error }), nfe({ estado: ESTADO_NFE.cancelada })],
    ['a → a', nfe(), nfe()],
    ['c → c', nfe({ estado: ESTADO_NFE.cancelada }), nfe({ estado: ESTADO_NFE.cancelada })],
    [
      'an aprovada WITHOUT a proc → c',
      nfe({ xml_nfe_proc: null }),
      nfe({ estado: ESTADO_NFE.cancelada }),
    ],
    [
      'a homologação aprovada → c',
      nfe({ xml_nfe_proc: proc('1', '1', '2') }),
      nfe({ estado: ESTADO_NFE.cancelada }),
    ],
    [
      'p → c (an EPEC note, never uploaded)',
      nfe({ estado: ESTADO_NFE.epecAprovado, xml_epec_proc: '<x/>' }),
      nfe({ estado: ESTADO_NFE.cancelada }),
    ],
    [
      'a ready devolução (finNFe 4) → c',
      nfe({ xml_nfe_proc: proc('1', '4') }),
      nfe({ estado: ESTADO_NFE.cancelada }),
    ],
    [
      'a ready entry note (tpNF 0) → c',
      nfe({ xml_nfe_proc: proc('0', '1') }),
      nfe({ estado: ESTADO_NFE.cancelada }),
    ],
    ['a create', undefined, nfe({ estado: ESTADO_NFE.cancelada })],
    ['a delete', nfe(), undefined],
  ])('★ NEAR-MISS %s ⇒ false', (_r, antes, depois) => {
    expect(cancelamentoDeNfeAprovadaAmazon(antes, depois)).toBe(false);
  });
});
