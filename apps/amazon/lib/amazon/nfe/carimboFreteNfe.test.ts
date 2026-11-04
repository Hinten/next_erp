/**
 * The NF-e upload's stamp and clear (step 14, PR 14-c): the pure decisions over
 * every guard, then the tier-1 write against the fake Firestore — the exact
 * patch (Shopee's shape: the block carried, the top-level µs clock bumped,
 * never the importer's watermark), the precondition, the re-derive on a lost
 * race, and the named conflict after three.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ESTADO_FRETE, ESTADOS_FRETE_NAO_POSTADO } from '@delfrance/schemas';

import { grpc, FakeDb, asDb } from '../testing/fakeDb';
import {
  AmazonNfeCarimboEmConflitoError,
  MAX_TENTATIVAS_CARIMBO_NFE_AMAZON,
  carimbarFreteNfeAmazon,
  limparCarimboNfeAmazon,
  preverCarimboNfeAmazon,
  preverLimpezaNfeAmazon,
} from './carimboFreteNfe';

const PEDIDO_ID = 'a'.repeat(64);
const CAMINHO = `pedidos/${PEDIDO_ID}`;
/** The top-level clock stored on the pedido (µs) and Amazon's ORDER clock on the block (µs). */
const ULTIMA_US = 1_800_000_000_000_000;
const RELOGIO_PEDIDO_US = 1_790_000_000_000_000;
const AGORA_US = ULTIMA_US + 5_000_000;

/** An `amz` freight block, as the importer leaves it. */
function bloco(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalOptionIntegracao: 'amz',
    modalidade: '1',
    estado: ESTADO_FRETE.aguardandoNFe,
    ultimaModificacao: RELOGIO_PEDIDO_US,
    pacotes: [{ numero: 'PKG-1', estado: ESTADO_FRETE.aguardandoNFe, estadoMarketplace: 'X' }],
    valorCobrado: 12.5,
    ...extra,
  };
}

/** A raw pedido the Amazon importer wrote. */
function pedido(
  freteInicial: unknown = bloco(),
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    numero: '171-9876543-2109876',
    estado: 'pago',
    ultimaModificacao: ULTIMA_US,
    lastMarketplaceUpdate: RELOGIO_PEDIDO_US,
    marketplace: { tipo: 'amazon', fulfilledBy: 'MERCHANT' },
    freteInicial,
    ...extra,
  };
}

describe('preverCarimboNfeAmazon — the guards, in order', () => {
  it('★ over a stampable estado ⇒ carimbado: exactly TWO keys, the block CARRIED whole at error, the top-level µs bumped', () => {
    const r = preverCarimboNfeAmazon(pedido(), AGORA_US);
    expect(r.motivo).toBe('carimbado');
    expect(Object.keys(r.patch ?? {}).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
    const frete = r.patch?.freteInicial ?? {};
    expect(frete).toMatchObject({
      ...bloco(),
      estado: ESTADO_FRETE.error,
    });
    // ★ (mutation 11) the nested ORDER clock is CARRIED, never assigned.
    expect(frete.ultimaModificacao).toBe(RELOGIO_PEDIDO_US);
    // ★ (mutation 10) the TOP-LEVEL clock in µs, moved to now.
    expect(r.patch?.ultimaModificacao).toBe(AGORA_US);
  });

  it('★ (mutation 10) the top-level clock is MONOTONE: a stored clock ahead of now is kept, never moved back; a legacy ms value is read as µs', () => {
    const adiante = preverCarimboNfeAmazon(
      pedido(bloco(), { ultimaModificacao: AGORA_US + 1 }),
      AGORA_US,
    );
    expect(adiante.patch?.ultimaModificacao).toBe(AGORA_US + 1);
    const legadoMs = preverCarimboNfeAmazon(
      pedido(bloco(), { ultimaModificacao: Math.floor(ULTIMA_US / 1000) }),
      AGORA_US,
    );
    expect(legadoMs.patch?.ultimaModificacao).toBe(AGORA_US);
    // A value in MILLISECONDS would be a thousand times smaller than any stored µs.
    expect(legadoMs.patch?.ultimaModificacao).toBeGreaterThan(1e15);
  });

  it('★ (mutation 9) never lastMarketplaceUpdate, and nothing else of the pedido', () => {
    const r = preverCarimboNfeAmazon(pedido(), AGORA_US);
    expect(r.patch).not.toHaveProperty('lastMarketplaceUpdate');
    expect(r.patch).not.toHaveProperty('estado');
    expect(r.patch).not.toHaveProperty('marketplace');
  });

  it.each<[string, Record<string, unknown> | null, string]>([
    ['no pedido', null, 'sem-pedido'],
    ['no freight block', pedido(null), 'sem-frete'],
    ['a freight block that is not a map', pedido('x'), 'sem-frete'],
    [
      '★ (mutation 7) a me block',
      pedido(bloco({ externalOptionIntegracao: 'me' })),
      'outra-integradora',
    ],
    [
      'an owner-less block',
      pedido(bloco({ externalOptionIntegracao: undefined })),
      'outra-integradora',
    ],
    [
      'an `AMZ` block (another case)',
      pedido(bloco({ externalOptionIntegracao: 'AMZ' })),
      'outra-integradora',
    ],
    [
      '★ a stored error (the replay)',
      pedido(bloco({ estado: ESTADO_FRETE.error })),
      'ja-carimbado',
    ],
    ['an estado outside the enum', pedido(bloco({ estado: 'enviadoX' })), 'estado-ilegivel'],
    [
      '★ (mutation 8) aguardandoPostagem',
      pedido(bloco({ estado: 'aguardandoPostagem' })),
      'fora-do-escopo',
    ],
    ['postado', pedido(bloco({ estado: 'postado' })), 'fora-do-escopo'],
    ['despachoNegado (a failure)', pedido(bloco({ estado: 'despachoNegado' })), 'fora-do-escopo'],
    ['cancelado', pedido(bloco({ estado: 'cancelado' })), 'fora-do-escopo'],
    ['fulfillment', pedido(bloco({ estado: 'fulfillment' })), 'fora-do-escopo'],
    [
      'an AFN order (the verdict: outside the channel)',
      pedido(bloco(), { marketplace: { tipo: 'amazon', fulfilledBy: 'AMAZON' } }),
      'veredito-recusou',
    ],
    ['a block the schema refuses', pedido(bloco({ valorCobrado: 'doze' })), 'frete-ilegivel'],
  ])('%s ⇒ %s, no patch', (_c, raw, motivo) => {
    expect(preverCarimboNfeAmazon(raw, AGORA_US)).toEqual({ motivo, patch: null });
  });

  it('every stampable estado stamps; NEAR-MISS the rest of the not-posted set does not', () => {
    for (const estado of [
      'iniciado',
      'aguardandoAutorizacao',
      'aguardandoNFe',
      'aguardandoValidacaoTransporadora',
      'despachoAutorizado',
      'emSeparacao',
      'desconhecido',
      'aguardandoAgendamento',
    ]) {
      expect(preverCarimboNfeAmazon(pedido(bloco({ estado })), AGORA_US).motivo, estado).toBe(
        'carimbado',
      );
    }
    for (const estado of ['empacotado']) {
      expect(ESTADOS_FRETE_NAO_POSTADO.has(estado as never)).toBe(true);
      expect(preverCarimboNfeAmazon(pedido(bloco({ estado })), AGORA_US).motivo).toBe(
        'fora-do-escopo',
      );
    }
  });

  it('the pedido is never mutated (the block is rebuilt by spread)', () => {
    const raw = pedido();
    const copia = structuredClone(raw);
    preverCarimboNfeAmazon(raw, AGORA_US);
    expect(raw).toEqual(copia);
  });
});

describe('preverLimpezaNfeAmazon — only from step 14’s own error', () => {
  it('★ a stored error ⇒ limpo: aguardandoAgendamento, the same write shape', () => {
    const r = preverLimpezaNfeAmazon(pedido(bloco({ estado: ESTADO_FRETE.error })), AGORA_US);
    expect(r.motivo).toBe('limpo');
    expect(Object.keys(r.patch ?? {}).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
    expect(r.patch?.freteInicial).toMatchObject({
      estado: ESTADO_FRETE.aguardandoAgendamento,
      ultimaModificacao: RELOGIO_PEDIDO_US,
      externalOptionIntegracao: 'amz',
    });
    expect(r.patch?.ultimaModificacao).toBe(AGORA_US);
  });

  it.each(['aguardandoNFe', 'aguardandoAgendamento', 'aguardandoPostagem', 'despachoNegado'])(
    'NEAR-MISS (mutation 16 of 14-b): a stored %s ⇒ sem-carimbo, no patch',
    (estado) => {
      expect(preverLimpezaNfeAmazon(pedido(bloco({ estado })), AGORA_US)).toEqual({
        motivo: 'sem-carimbo',
        patch: null,
      });
    },
  );

  it('NEAR-MISS: another channel’s error is never ours to clear', () => {
    expect(
      preverLimpezaNfeAmazon(
        pedido(bloco({ estado: ESTADO_FRETE.error, externalOptionIntegracao: 'me' })),
        AGORA_US,
      ),
    ).toEqual({ motivo: 'outra-integradora', patch: null });
  });

  it('★ applied DIRECTLY, never through the freight verdict (which refuses error → aguardandoAgendamento)', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./carimboFreteNfe.ts', import.meta.url)),
      'utf8',
    );
    const limpeza = fonte.slice(
      fonte.indexOf('export function preverLimpezaNfeAmazon'),
      fonte.indexOf('/** One read-decide-write loop'),
    );
    expect(limpeza).toContain('estadoFreteAposAceiteNfeAmazon(lido.estado)');
    expect(limpeza).not.toContain('estadoFreteAmazonAplicavel');
  });
});

describe('the write — tier 1, on a FRESH read', () => {
  it('★ stamps with update(…, { lastUpdateTime }) on THIS read, ONE write', async () => {
    const fake = new FakeDb();
    const stamp = fake.seed(CAMINHO, pedido());
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('carimbado');
    expect(fake.escritas).toHaveLength(1);
    expect(fake.escritas[0]).toMatchObject({ verbo: 'update', comPrecondicao: true });
    const doc = fake.ler(CAMINHO) ?? {};
    expect((doc.freteInicial as Record<string, unknown>).estado).toBe('error');
    expect((doc.freteInicial as Record<string, unknown>).ultimaModificacao).toBe(RELOGIO_PEDIDO_US);
    expect(doc.ultimaModificacao).toBe(AGORA_US);
    expect(doc.lastMarketplaceUpdate).toBe(RELOGIO_PEDIDO_US);
    expect(fake.carimboDe(CAMINHO)).not.toEqual(stamp);
  });

  it('★ a stored error ⇒ ZERO writes; another channel’s block ⇒ ZERO writes; no pedido ⇒ ZERO writes', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido(bloco({ estado: 'error' })));
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('ja-carimbado');
    fake.seed(CAMINHO, pedido(bloco({ externalOptionIntegracao: 'me' })));
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('outra-integradora');
    expect(await carimbarFreteNfeAmazon(asDb(fake), 'b'.repeat(64), AGORA_US)).toBe('sem-pedido');
    expect(fake.escritas).toEqual([]);
  });

  it('★ a precondition loss RE-DERIVES from the winner: the importer moved the freight to aguardandoPostagem ⇒ fora-do-escopo, nothing written', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido());
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.seed(CAMINHO, pedido(bloco({ estado: 'aguardandoPostagem' })));
    });
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('fora-do-escopo');
    expect(fake.escritas).toEqual([]);
    expect((fake.ler(CAMINHO)?.freteInicial as Record<string, unknown>).estado).toBe(
      'aguardandoPostagem',
    );
  });

  it('a loss whose winner still allows the stamp ⇒ attempt 2 stamps over the WINNER’s block', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido());
    fake.antesDaProximaEscrita(CAMINHO, () => {
      fake.seed(CAMINHO, pedido(bloco({ valorCobrado: 99 })));
    });
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('carimbado');
    expect(fake.ler(CAMINHO)?.freteInicial).toMatchObject({ estado: 'error', valorCobrado: 99 });
  });

  it('the pedido deleted between the read and the write ⇒ re-read ⇒ sem-pedido', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido());
    fake.antesDaProximaEscrita(CAMINHO, () => fake.apagar(CAMINHO));
    expect(await carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('sem-pedido');
  });

  it(`three losses ⇒ AmazonNfeCarimboEmConflitoError (named, retryable), after ${String(MAX_TENTATIVAS_CARIMBO_NFE_AMAZON)} reads`, async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido());
    for (let i = 0; i < MAX_TENTATIVAS_CARIMBO_NFE_AMAZON; i += 1) {
      fake.antesDaProximaEscrita(CAMINHO, () => {
        fake.seed(CAMINHO, pedido());
      });
    }
    await expect(carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).rejects.toBeInstanceOf(
      AmazonNfeCarimboEmConflitoError,
    );
    expect(fake.leituras.filter((c) => c === CAMINHO)).toHaveLength(
      MAX_TENTATIVAS_CARIMBO_NFE_AMAZON,
    );
  });

  it('any other Firestore failure propagates untouched (rule 6)', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido());
    const falha = grpc(14, 'UNAVAILABLE');
    fake.falharEscrita(CAMINHO, falha);
    await expect(carimbarFreteNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).rejects.toBe(falha);
  });

  it('★ the clear: error ⇒ aguardandoAgendamento, one write; anything else ⇒ zero writes', async () => {
    const fake = new FakeDb();
    fake.seed(CAMINHO, pedido(bloco({ estado: 'error' })));
    expect(await limparCarimboNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('limpo');
    expect(fake.escritas).toHaveLength(1);
    expect((fake.ler(CAMINHO)?.freteInicial as Record<string, unknown>).estado).toBe(
      'aguardandoAgendamento',
    );
    expect(await limparCarimboNfeAmazon(asDb(fake), PEDIDO_ID, AGORA_US)).toBe('sem-carimbo');
    expect(fake.escritas).toHaveLength(1);
  });

  it('this module never names the multi-document atomic write (the inventory greps the word)', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./carimboFreteNfe.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).not.toContain(['run', 'Transaction'].join(''));
    expect(fonte).toContain('lastUpdateTime: snap.updateTime');
  });
});
