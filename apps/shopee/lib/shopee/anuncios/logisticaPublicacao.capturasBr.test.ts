/**
 * #1911 P15: the publisher's logistics over the COMMITTED BR bodies —
 * `get_channel_list.br.json` (the shop's four channels) and the two
 * `get_item_base_info.br-anuncio-*` read-backs, whose parsed `logistic_info`
 * is what write-back #2 and the import store on a link.
 *
 * ⚠️ **Counts and booleans**, labelled by fixture — the `capturasBr.test.ts`
 * convention. Every channel id is READ from the bodies, never typed, and no
 * channel name is read at all. All four BR channels are `SIZE_INPUT` with
 * `mask_channel_id` 0 and no stored off, so this replay is a SMOKE pin of P15's
 * neutrality on the BR shop: it cannot kill a fee or size reader mutant — the
 * synthetic `CUSTOM_PRICE` / `SIZE_SELECTION` pairs in
 * `logisticaPublicacao.test.ts` do. If a body and a count disagree, the finding
 * is about the code or about Shopee — never a reason to edit the body.
 */
import {
  type ShopeeLogisticInfo,
  type ShopeeLogisticsChannel,
  shopeeLogisticsChannelSchema,
} from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_CHANNEL_LIST_BR,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_LOGISTICA,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_VARIACOES,
  lerBaseDosItens,
  lerFixture,
} from '../fixtures/wireCorpus';
import { type ArgsLogistica, canalSelecionavel, construirLogistica } from './logisticaPublicacao';

/** The two committed read-backs: without and with `estimated_shipping_fee`. */
const RETORNOS = [
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_LOGISTICA,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_VARIACOES,
] as const;

/** The shop's channels, each row through the package's own schema. */
function canaisDoBr(): readonly ShopeeLogisticsChannel[] {
  const cru = lerFixture(FIXTURE_CHANNEL_LIST_BR) as unknown as {
    response: { logistics_channel_list: unknown[] };
  };
  return cru.response.logistics_channel_list.map((c) => shopeeLogisticsChannelSchema.parse(c));
}

/** One read-back's parsed `logistic_info` — the stored list a link carries. */
function retornoDe(file: string): readonly ShopeeLogisticInfo[] {
  const lista = lerBaseDosItens(file).item_list[0]?.logistic_info ?? null;
  expect(lista, file).not.toBeNull();
  return lista ?? [];
}

/** A parcel every BR channel fits: 0.5 kg, 10 × 10 × 10 cm, no free shipping. */
function argsBr(parcial: Partial<ArgsLogistica>): ArgsLogistica {
  return {
    canais: canaisDoBr(),
    armazenado: null,
    armazenadoConfiavel: true,
    itemIdImportavel: null,
    pesoKg: 0.5,
    dimensaoCm: { package_height: 10, package_length: 10, package_width: 10 },
    ofereceFreteGratis: false,
    ...parcial,
  };
}

function ids(
  lista: readonly { readonly logistic_id: number | null }[],
): readonly (number | null)[] {
  return lista.map((e) => e.logistic_id);
}

describe('get_channel_list.br.json × get_item_base_info.br-anuncio-*: a logística do BR pelo publicador (#1911 P15)', () => {
  it.each(RETORNOS)(
    'CARIMBADA: o retorno de %s manda os 3 canais na ordem do retorno, {enabled: true, is_free: false}, sem size_id e sem shipping_fee; pulados [] e problemas []',
    (file) => {
      const retorno = retornoDe(file);
      expect(retorno).toHaveLength(3);
      const r = construirLogistica(argsBr({ armazenado: retorno, armazenadoConfiavel: true }));
      expect(r.logistic_info).toHaveLength(3);
      expect(ids(r.logistic_info)).toEqual(ids(retorno));
      for (const entrada of r.logistic_info) {
        expect(entrada.enabled).toBe(true);
        expect(entrada.is_free).toBe(false);
        expect('size_id' in entrada).toBe(false);
        expect('shipping_fee' in entrada).toBe(false);
      }
      expect(r.pulados).toEqual([]);
      expect(r.problemas).toEqual([]);
    },
  );

  it('PAR: os dois retornos (com e sem estimated_shipping_fee) dão o MESMO fio', () => {
    const [semEstimativa, comEstimativa] = RETORNOS.map(retornoDe);
    // ÂNCORA: the pair differs exactly where the fee reader looks away.
    expect(semEstimativa?.every((e) => e.estimated_shipping_fee === null)).toBe(true);
    expect(comEstimativa?.every((e) => e.estimated_shipping_fee !== null)).toBe(true);
    const [a, b] = [semEstimativa, comEstimativa].map((armazenado) =>
      construirLogistica(argsBr({ armazenado: armazenado ?? null })),
    );
    expect(a?.logistic_info).toHaveLength(3);
    expect(b?.logistic_info).toEqual(a?.logistic_info);
  });

  it('DESCONFIADA: a passagem completa manda os 3 habilitados na ordem da lista de canais; pulados só o desligado na loja', () => {
    const canais = canaisDoBr();
    const habilitados = canais.filter((c) => c.enabled === true).map((c) => c.logistics_channel_id);
    const desligados = canais.filter((c) => c.enabled !== true).map((c) => c.logistics_channel_id);
    expect(habilitados).toHaveLength(3);
    expect(desligados).toHaveLength(1);
    for (const file of RETORNOS) {
      const retorno = retornoDe(file);
      // ÂNCORA: the channel-list order is not the read-back's, so the order
      // below says which pass ran.
      expect(habilitados, file).not.toEqual(ids(retorno));

      const r = construirLogistica(argsBr({ armazenado: retorno, armazenadoConfiavel: false }));
      expect(ids(r.logistic_info), file).toEqual(habilitados);
      expect(r.pulados, file).toEqual(
        desligados.map((logisticId) => ({ logisticId, motivo: 'nao-habilitado-na-loja' })),
      );
      expect(r.problemas, file).toEqual([]);
    }
  });

  it('P15 neutro no BR: canalSelecionavel verdadeiro nos 3 e falso no desligado; nenhum canal-de-fulfillment nem desligado-no-vinculo', () => {
    const canais = canaisDoBr();
    expect(canais).toHaveLength(4);
    expect(canais.every((c) => c.mask_channel_id === 0)).toBe(true);
    expect(canais.filter((c) => canalSelecionavel(c))).toHaveLength(3);
    expect(canais.filter((c) => !canalSelecionavel(c)).map((c) => c.enabled)).toEqual([false]);
    expect(canais.every((c) => canalSelecionavel(c) === (c.enabled === true))).toBe(true);

    const execucoes = [
      construirLogistica(argsBr({})),
      ...RETORNOS.flatMap((file) => [
        construirLogistica(argsBr({ armazenado: retornoDe(file), armazenadoConfiavel: true })),
        construirLogistica(argsBr({ armazenado: retornoDe(file), armazenadoConfiavel: false })),
      ]),
    ];
    expect(execucoes).toHaveLength(5);
    for (const r of execucoes) {
      expect(r.logistic_info).toHaveLength(3);
      expect(
        r.pulados.some(
          (p) => p.motivo === 'canal-de-fulfillment' || p.motivo === 'desligado-no-vinculo',
        ),
      ).toBe(false);
    }
  });
});
