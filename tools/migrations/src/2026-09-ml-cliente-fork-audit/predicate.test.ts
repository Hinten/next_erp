import { describe, expect, it } from 'vitest';

import {
  auditPedidoCliente,
  buyerIdInseguro,
  normalizarBuyerId,
  type ForkAuditInput,
} from './predicate';

const BUYER = '301110805';
const OUTRO_BUYER = '987654321';

function entrada(over: Partial<ForkAuditInput> = {}): ForkAuditInput {
  return {
    pedidoPath: 'pedidos/ped-1',
    buyerIdsBrutos: [301110805],
    clienteId: 'cli-1',
    clienteExiste: true,
    idMlDoCliente: BUYER,
    donosDoBuyerId: ['cli-1'],
    ...over,
  };
}

describe('normalizarBuyerId', () => {
  it('renders a number the way the cascade leg queries it', () => {
    expect(normalizarBuyerId(301110805)).toBe(BUYER);
    expect(normalizarBuyerId(BUYER)).toBe(BUYER);
    // Trimmed, because `findOrCreateCliente` stores and queries the trimmed
    // form — comparing an untrimmed value would report forks that do not exist.
    expect(normalizarBuyerId(`  ${BUYER}  `)).toBe(BUYER);
  });

  it('treats absence and blanks as no id', () => {
    expect(normalizarBuyerId(null)).toBeNull();
    expect(normalizarBuyerId(undefined)).toBeNull();
    expect(normalizarBuyerId('')).toBeNull();
    expect(normalizarBuyerId('   ')).toBeNull();
  });

  it('keeps NEAR-MISS ids distinct', () => {
    // The fold that decides "same buyer" must not be looser than the runtime's.
    // A trailing digit is exactly what a rounded id looks like.
    expect(normalizarBuyerId(BUYER)).not.toBe(normalizarBuyerId(`${BUYER}0`));
    expect(normalizarBuyerId('0301110805')).not.toBe(normalizarBuyerId(BUYER));
  });
});

describe('buyerIdInseguro', () => {
  it('flags a number JSON.parse could not represent exactly', () => {
    expect(buyerIdInseguro(Number.MAX_SAFE_INTEGER + 2)).toBe(true);
    // The control: an ordinary ML id is ~1e9, six orders of magnitude clear.
    expect(buyerIdInseguro(301110805)).toBe(false);
    expect(buyerIdInseguro(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('says nothing about a string — only a parsed NUMBER can have been rounded', () => {
    expect(buyerIdInseguro('9007199254740993')).toBe(false);
  });
});

describe('auditPedidoCliente', () => {
  it('ok: the pedido’s cliente owns exactly this buyer id', () => {
    expect(auditPedidoCliente(entrada()).kind).toBe('ok');
  });

  it('fork: another cliente owns the id — the population this audit counts', () => {
    const row = auditPedidoCliente(
      entrada({ donosDoBuyerId: ['cli-da-pergunta'], idMlDoCliente: null }),
    );
    expect(row.kind).toBe('fork');
    expect(row.donos).toEqual(['cli-da-pergunta']);
    expect(row.clienteDoPedido).toBe('cli-1');
  });

  it('nao-carimbado: nobody owns it and the cliente has none — self-heals after the deploy', () => {
    expect(auditPedidoCliente(entrada({ donosDoBuyerId: [], idMlDoCliente: null })).kind).toBe(
      'nao-carimbado',
    );
  });

  it('cliente-com-outro-id is NOT nao-carimbado — it predicts where #1407 will fork', () => {
    // Two ML accounts on one cliente. Nothing is wrong on disk today, which is
    // exactly why it needs its own kind: under #1407 the next order from this
    // buyer is refused at the cpf_cnpj leg and forks. Filing it under
    // `nao-carimbado` would promise a self-heal that will not happen.
    const row = auditPedidoCliente(entrada({ donosDoBuyerId: [], idMlDoCliente: OUTRO_BUYER }));
    expect(row.kind).toBe('cliente-com-outro-id');
    expect(row.idMlDoCliente).toBe(OUTRO_BUYER);
  });

  it('dono-duplicado outranks fork — an ambiguous id hurts every caller', () => {
    const row = auditPedidoCliente(entrada({ donosDoBuyerId: ['cli-a', 'cli-b'] }));
    expect(row.kind).toBe('dono-duplicado');
    expect(row.donos).toEqual(['cli-a', 'cli-b']);
  });

  it('sem-buyer-id when the mirror carries none', () => {
    expect(auditPedidoCliente(entrada({ buyerIdsBrutos: [] })).kind).toBe('sem-buyer-id');
    expect(auditPedidoCliente(entrada({ buyerIdsBrutos: [null, ''] })).kind).toBe('sem-buyer-id');
  });

  it('buyer-id-inseguro is reported as unsafe, never as missing', () => {
    // The runtime REFUSES to stamp these (`safeMlUserId`), so they never
    // self-heal. Collapsing them into `sem-buyer-id` would hide that.
    const row = auditPedidoCliente(
      entrada({
        buyerIdsBrutos: [Number.MAX_SAFE_INTEGER + 2],
        donosDoBuyerId: [],
        idMlDoCliente: null,
      }),
    );
    expect(row.kind).toBe('buyer-id-inseguro');
  });

  it('buyers-divergentes: a pack whose orders name different buyers', () => {
    const row = auditPedidoCliente(entrada({ buyerIdsBrutos: [301110805, 987654321] }));
    expect(row.kind).toBe('buyers-divergentes');
    // No single buyer id, so no owner list can mean anything.
    expect(row.buyerId).toBeNull();
    expect(row.donos).toEqual([]);
  });

  it('the same id repeated across a pack’s orders is ONE buyer, not divergence', () => {
    // The control for the case above: a pack has several `orderML` docs and they
    // normally all name the same person. Reading that as divergence would flag
    // every healthy pack.
    const row = auditPedidoCliente(
      entrada({ buyerIdsBrutos: [301110805, '301110805', 301110805] }),
    );
    expect(row.kind).toBe('ok');
    expect(row.buyerId).toBe(BUYER);
  });

  it('pedido-sem-cliente and cliente-ausente are distinguished', () => {
    expect(auditPedidoCliente(entrada({ clienteId: null })).kind).toBe('pedido-sem-cliente');
    expect(auditPedidoCliente(entrada({ clienteExiste: false })).kind).toBe('cliente-ausente');
  });

  it('a blank stored idMercadoLivre counts as absent, like the runtime reads it', () => {
    // `clienteSchema` permits `''`, and `identityValue` collapses it — so a
    // cliente storing blanks must classify as `nao-carimbado`, not as carrying
    // "another" id.
    expect(auditPedidoCliente(entrada({ donosDoBuyerId: [], idMlDoCliente: '   ' })).kind).toBe(
      'nao-carimbado',
    );
  });
});
