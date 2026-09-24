import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  shopeeUpdatePricePayloadSchema,
  type ShopeeUpdatePrice,
} from '@delfrance/integrations-shopee';

import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import type { LeituraDePreco, ModeloLido } from './leituraPreco';
import { modeloDoEco, verificarPrecosEnviados } from './verificacaoPreco';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const MODELO_A = 2_000_458_802;
const MODELO_B = 2_000_458_803;
const SEM_MODELO = SHOPEE_PRECO_MODEL_ID_SEM_MODELO;

/** This module's raw TEXT — the purity discipline is measured on it. */
const FONTE = readFileSync(
  fileURLToPath(new URL('./verificacaoPreco.ts', import.meta.url)),
  'utf8',
);

/**
 * An `update_price` payload exactly as the package hands it over: RAW wire rows
 * parsed by the package's own schema, so an absent `model_id` reads `null` and a
 * quoted `"12.5"` reads `12.5` — never a hand-built object the schema would not
 * produce.
 */
function eco(
  sucesso: readonly Record<string, unknown>[],
  falha: readonly Record<string, unknown>[] = [],
): ShopeeUpdatePrice {
  return shopeeUpdatePricePayloadSchema.parse({ success_list: sucesso, failure_list: falha });
}

/** A fresh read of a has-model listing with the given models. */
function leitura(modelos: readonly Partial<ModeloLido>[], temModelos = true): LeituraDePreco {
  return {
    itemStatus: 'NORMAL',
    temModelos,
    modelos: modelos.map((m) => ({
      modelId: m.modelId ?? MODELO_A,
      precoAnterior: m.precoAnterior ?? null,
      moeda: m.moeda ?? 'SGD',
      status: m.status ?? null,
    })),
  };
}

/** A `reler` that must never be reached. */
function relerProibido() {
  return vi.fn(async (): Promise<LeituraDePreco> => {
    throw new Error('reler não deveria ser chamado');
  });
}

/* -------------------------------------------------------------------------- */
/*                              the echo ('eco')                               */
/* -------------------------------------------------------------------------- */

describe('verificarPrecosEnviados — pelo ECO', () => {
  it('EQUAL PAIR: o eco igual confirma — 12.5 enviado vs o eco "12.5" (já lido 12.5 pelo pacote), e 20 vs 20.004 pela dobra em reais', async () => {
    const reler = relerProibido();
    const resposta = eco([
      { model_id: MODELO_A, original_price: '12.5' },
      { model_id: String(MODELO_B), original_price: 20.004 },
    ]);
    expect(resposta.success_list[0]?.original_price).toBe(12.5);

    const veredito = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 12.5 },
        { modelId: MODELO_B, precoAlvo: 20 },
      ],
      resposta,
      'eco',
      reler,
    );

    expect(veredito).toEqual({ ok: true, ecosNulos: 0 });
    expect(reler).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: UM centavo de diferença é DIVERGENTE — 12.49 vs 12.5, e 49.991 vs 50 (0.009 apart, que uma tolerância < 0.01 igualaria)', async () => {
    const umCentavo = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 12.5 }],
      eco([{ model_id: MODELO_A, original_price: 12.49 }]),
      'eco',
      relerProibido(),
    );
    expect(umCentavo).toEqual({ ok: false, divergentes: [MODELO_A] });

    const tolerancia = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 50 }],
      eco([{ model_id: MODELO_A, original_price: 49.991 }]),
      'eco',
      relerProibido(),
    );
    expect(tolerancia).toEqual({ ok: false, divergentes: [MODELO_A] });
  });

  it('only the DIVERGING model is listed — a sibling that agrees stays out (EQUAL PAIR beside a NEAR-MISS in one answer)', async () => {
    const veredito = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 10 },
        { modelId: MODELO_B, precoAlvo: 12 },
      ],
      eco([
        { model_id: MODELO_A, original_price: 10 },
        { model_id: MODELO_B, original_price: 12.01 },
      ]),
      'eco',
      relerProibido(),
    );
    expect(veredito).toEqual({ ok: false, divergentes: [MODELO_B] });
  });

  it('EQUAL PAIR (C-4): o eco SEM `model_id` de um item SEM modelo é o eco do `0` enviado — igual confirma, diferente DIVERGE (prova que casou)', async () => {
    // The live no-model echo (probe P4c): ONLY `original_price`, no `model_id` key.
    const vivo = eco([{ original_price: 13.4 }]);
    expect(vivo.success_list[0]?.model_id).toBeNull();

    const igual = await verificarPrecosEnviados(
      [{ modelId: SEM_MODELO, precoAlvo: 13.4 }],
      vivo,
      'eco',
      relerProibido(),
    );
    expect(igual).toEqual({ ok: true, ecosNulos: 0 });

    // Had the echo NOT been matched, this would read `ok: true, ecosNulos: 1`.
    const diferente = await verificarPrecosEnviados(
      [{ modelId: SEM_MODELO, precoAlvo: 13.4 }],
      eco([{ original_price: 99 }]),
      'eco',
      relerProibido(),
    );
    expect(diferente).toEqual({ ok: false, divergentes: [SEM_MODELO] });
  });

  it('NEAR-MISS (C-4): um eco SEM `model_id` quando DOIS modelos foram enviados não casa com NENHUM — nunca adivinhado, mesmo com um preço que divergiria', async () => {
    const veredito = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 10 },
        { modelId: MODELO_B, precoAlvo: 12 },
      ],
      eco([{ original_price: 99 }]),
      'eco',
      relerProibido(),
    );
    expect(veredito).toEqual({ ok: true, ecosNulos: 2 });
  });

  it('NEAR-MISS (C-4): nem num item COM modelo e UM só modelo enviado o eco sem `model_id` é atribuído a ele', async () => {
    const veredito = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 10 }],
      eco([{ original_price: 99 }]),
      'eco',
      relerProibido(),
    );
    expect(veredito).toEqual({ ok: true, ecosNulos: 1 });
  });

  it('PAIR (C-4/D-10): num envio sem modelo, o eco NUMERADO `0` da amostra da página também é o eco dele, como a AUSÊNCIA medida — NEAR-MISS: com o preço divergente ele DIVERGE, nunca vira ecosNulos', async () => {
    const igual = await verificarPrecosEnviados(
      [{ modelId: SEM_MODELO, precoAlvo: 13.4 }],
      eco([{ model_id: 0, original_price: 13.4 }]),
      'eco',
      relerProibido(),
    );
    expect(igual).toEqual({ ok: true, ecosNulos: 0 });
    const divergente = await verificarPrecosEnviados(
      [{ modelId: SEM_MODELO, precoAlvo: 13.4 }],
      eco([{ model_id: 0, original_price: 99 }]),
      'eco',
      relerProibido(),
    );
    expect(divergente).toEqual({ ok: false, divergentes: [SEM_MODELO] });
  });

  it('a confirmation WITHOUT a number and a MISSING row both count in ecosNulos, never as a divergence — NEAR-MISS: the same row WITH its number counts zero', async () => {
    const semNumero = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 10 },
        { modelId: MODELO_B, precoAlvo: 12 },
      ],
      // A answered without the number; B not answered at all (it sits in the failure list).
      eco(
        [{ model_id: MODELO_A, original_price: null }],
        [{ model_id: MODELO_B, failed_reason: 'model ID not exist in sku' }],
      ),
      'eco',
      relerProibido(),
    );
    expect(semNumero).toEqual({ ok: true, ecosNulos: 2 });

    const comNumero = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 10 }],
      eco([{ model_id: MODELO_A, original_price: 10 }]),
      'eco',
      relerProibido(),
    );
    expect(comNumero).toEqual({ ok: true, ecosNulos: 0 });
  });

  it('a divergent number wins over an agreeing DUPLICATE row of the same model, and a row of an UNSENT model is ignored', async () => {
    const duplicado = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 10 }],
      eco([
        { model_id: MODELO_A, original_price: 10 },
        { model_id: MODELO_A, original_price: 11 },
      ]),
      'eco',
      relerProibido(),
    );
    expect(duplicado).toEqual({ ok: false, divergentes: [MODELO_A] });

    const naoEnviado = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 10 }],
      eco([
        { model_id: MODELO_A, original_price: 10 },
        { model_id: MODELO_B, original_price: 99 },
      ]),
      'eco',
      relerProibido(),
    );
    expect(naoEnviado).toEqual({ ok: true, ecosNulos: 0 });
  });

  it("'eco' NEVER calls reler — not even when the read-back would have disagreed", async () => {
    const reler = vi.fn(async () => leitura([{ modelId: MODELO_A, precoAnterior: 99 }]));
    const veredito = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 10 }],
      eco([{ model_id: MODELO_A, original_price: 10 }]),
      'eco',
      reler,
    );
    expect(veredito).toEqual({ ok: true, ecosNulos: 0 });
    expect(reler).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                         the read-back ('releitura')                         */
/* -------------------------------------------------------------------------- */

describe('verificarPrecosEnviados — pela RELEITURA', () => {
  it("'releitura' calls reler exactly ONCE for the whole item (two models) and IGNORES the echo — EQUAL PAIR: 12.5 read vs 12.5 sent", async () => {
    const reler = vi.fn(async () =>
      leitura([
        { modelId: MODELO_A, precoAnterior: 12.5 },
        { modelId: MODELO_B, precoAnterior: 20 },
      ]),
    );
    const veredito = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 12.5 },
        { modelId: MODELO_B, precoAlvo: 20 },
      ],
      // An echo that DIVERGES — the read-back is the source, so it must not matter.
      eco([
        { model_id: MODELO_A, original_price: 99 },
        { model_id: MODELO_B, original_price: 99 },
      ]),
      'releitura',
      reler,
    );
    expect(veredito).toEqual({ ok: true, ecosNulos: 0 });
    expect(reler).toHaveBeenCalledTimes(1);
  });

  it('NEAR-MISS: a read-back ONE centavo off diverges (12.49 vs 12.5), even beside an echo that agrees', async () => {
    const reler = vi.fn(async () => leitura([{ modelId: MODELO_A, precoAnterior: 12.49 }]));
    const veredito = await verificarPrecosEnviados(
      [{ modelId: MODELO_A, precoAlvo: 12.5 }],
      eco([{ model_id: MODELO_A, original_price: 12.5 }]),
      'releitura',
      reler,
    );
    expect(veredito).toEqual({ ok: false, divergentes: [MODELO_A] });
    expect(reler).toHaveBeenCalledTimes(1);
  });

  it('an UNREADABLE (null) or ABSENT model in the read-back IS a divergence — the read-back exists to prove; NEAR-MISS: the readable sibling passes', async () => {
    const veredito = await verificarPrecosEnviados(
      [
        { modelId: MODELO_A, precoAlvo: 10 },
        { modelId: MODELO_B, precoAlvo: 12 },
        { modelId: MODELO_B + 1, precoAlvo: 14 },
      ],
      eco([]),
      'releitura',
      async () =>
        leitura([
          { modelId: MODELO_A, precoAnterior: 10 },
          { modelId: MODELO_B, precoAnterior: null },
        ]),
    );
    expect(veredito).toEqual({ ok: false, divergentes: [MODELO_B, MODELO_B + 1] });
  });

  it('EQUAL PAIR: the no-model read-back entry (at SHOPEE_PRECO_MODEL_ID_SEM_MODELO) answers the no-model send', async () => {
    const veredito = await verificarPrecosEnviados(
      [{ modelId: SEM_MODELO, precoAlvo: 13.4 }],
      eco([]),
      'releitura',
      async () => leitura([{ modelId: SEM_MODELO, precoAnterior: 13.4 }], false),
    );
    expect(veredito).toEqual({ ok: true, ecosNulos: 0 });
  });

  it('an error of reler reaches the caller as the SAME instance — the sender owns the ladder', async () => {
    const erro = new Error('falha de rede na releitura');
    await expect(
      verificarPrecosEnviados(
        [{ modelId: MODELO_A, precoAlvo: 10 }],
        eco([]),
        'releitura',
        async () => {
          throw erro;
        },
      ),
    ).rejects.toBe(erro);
  });

  it('nothing sent ⇒ nothing to prove: ok with zero, and reler is NOT spent (either source)', async () => {
    const reler = relerProibido();
    await expect(verificarPrecosEnviados([], eco([]), 'releitura', reler)).resolves.toEqual({
      ok: true,
      ecosNulos: 0,
    });
    await expect(verificarPrecosEnviados([], eco([]), 'eco', reler)).resolves.toEqual({
      ok: true,
      ecosNulos: 0,
    });
    expect(reler).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                         the C-4 matcher, directly                           */
/* -------------------------------------------------------------------------- */

describe('modeloDoEco — the ONE echo→model matcher (C-4)', () => {
  it('EQUAL PAIR: no-model send ⇒ an ABSENT `model_id` and the page sample `0` both answer SHOPEE_PRECO_MODEL_ID_SEM_MODELO (D-10); NEAR-MISS: a real id answers nothing', () => {
    expect(modeloDoEco({ model_id: null }, true)).toBe(SEM_MODELO);
    expect(modeloDoEco({ model_id: 0 }, true)).toBe(SEM_MODELO);
    expect(modeloDoEco({ model_id: MODELO_A }, true)).toBeNull();
  });

  it('EQUAL PAIR: has-model send ⇒ a row answers its own `model_id`; NEAR-MISS: a `null` answers NOTHING (never guessed)', () => {
    expect(modeloDoEco({ model_id: MODELO_A }, false)).toBe(MODELO_A);
    expect(modeloDoEco({ model_id: null }, false)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              source discipline                              */
/* -------------------------------------------------------------------------- */

describe('verificacaoPreco.ts — FONTE', () => {
  it('compares through the one price fold and reaches neither the write op, the link writer nor Firestore', () => {
    expect(FONTE).toMatch(/import \{ mesmoPrecoEmReais \} from '@delfrance\/schemas';/);
    expect(FONTE).not.toMatch(/\.updatePrice\(/);
    expect(FONTE).not.toMatch(/from '\.\/linkPreco'/);
    expect(FONTE).not.toMatch(/@delfrance\/data/);
    expect(FONTE).not.toMatch(/\bcatch\b/);
  });
});
