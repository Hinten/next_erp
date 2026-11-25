/**
 * Every price comparison of the price push: the fold and the direction, the
 * plan of one send (the decrease guard, its window and its floor, the two
 * rules that only add a send), the check after a send, a feed member's
 * decision at send time, the mass-decrease measure and the sample. Each fold
 * site has an EQUAL pair and a NEAR-MISS.
 */
import { describe, expect, it } from 'vitest';
import { TIPO_OFERTA_LISTING_AMAZON } from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioPrecoAmazon,
  type FaixaPrecoAmazon,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  type ResultadoEnvioEstoqueAmazon,
  TIPO_OFERTA_PRECO_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
  ofertaPrecoAmazonSchema,
} from '@delfrance/schemas';

import { JANELA_VISIBILIDADE_MS } from '../estoque/planoEstoque';
import {
  DECISAO_PLANO_PRECO_AMAZON,
  DECISAO_VERIFICACAO_PRECO_AMAZON,
  DIRECAO_PRECO_AMAZON,
  JANELA_CONSENTIMENTO_PRECO_AMAZON_MS,
  JANELA_VISIBILIDADE_PRECO_AMAZON_MS,
  MAX_CARACTERES_AMOSTRA_PRECO_AMAZON,
  type OfertaVistaPrecoAmazon,
  type OpcoesPlanoPrecoAmazon,
  PISO_DESCONHECIDO_PRECO_AMAZON,
  REGRA_ESCRITA_PRECO_AMAZON,
  TOLERANCIA_RELOGIO_CONSENTIMENTO_PRECO_AMAZON_MS,
  amostraReducoesPrecoAmazon,
  consentimentoValidoPrecoAmazon,
  decidirMembroLotePrecoAmazon,
  direcaoPrecoAmazon,
  erpMudouPrecoAmazon,
  mesmaFaixaPrecoAmazon,
  mesmaOfertaAmazon,
  planejarPrecoAmazon,
  planejarVerificacaoPrecoAmazon,
  quedaExcessivaPrecoAmazon,
} from './planoPreco';

const AGORA = 1_800_000_000_000;
const MIN = 60_000;

const faixa = (base: number, minimo = base, maximo = base): FaixaPrecoAmazon => ({
  base,
  minimo,
  maximo,
});
const lida = (
  base: number,
  minimo: number | null = base,
  maximo: number | null = base,
): OfertaVistaPrecoAmazon => ({ tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base, minimo, maximo });
const ILEGIVEL: OfertaVistaPrecoAmazon = { tipo: TIPO_OFERTA_PRECO_AMAZON.ilegivel };
const AMBIGUA: OfertaVistaPrecoAmazon = { tipo: TIPO_OFERTA_PRECO_AMAZON.ambigua };
const AUSENTE: OfertaVistaPrecoAmazon = { tipo: TIPO_OFERTA_PRECO_AMAZON.ausente };

const opcoes = (o: Partial<OpcoesPlanoPrecoAmazon> = {}): OpcoesPlanoPrecoAmazon => ({
  buyable: false,
  baixarPreco: false,
  consentimentoValido: false,
  pisoConsentimento: null,
  envioRecente: null,
  feedRecenteEmMs: null,
  agoraMs: AGORA,
  ...o,
});
const COM_CONSENTIMENTO = { baixarPreco: true, consentimentoValido: true } as const;

/** A stored price outcome, through the real schema. */
function envio(
  o: {
    emMs?: number;
    oferta?: FaixaPrecoAmazon | null;
    resultado?: ResultadoEnvioEstoqueAmazon;
    feed?: boolean;
  } = {},
): EnvioPrecoAmazon {
  const resultado = o.resultado ?? RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito;
  const incerto = resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto;
  return envioPrecoAmazonSchema.parse(
    o.feed === true
      ? {
          via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
          emMs: o.emMs ?? AGORA,
          oferta: null,
          resultado,
          feedId: '123456',
        }
      : {
          via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
          emMs: o.emMs ?? AGORA,
          oferta: o.oferta === undefined ? faixa(60) : o.oferta,
          resultado,
          submissionId: incerto ? null : 'sub-1',
        },
  );
}

const plano = (f: FaixaPrecoAmazon, oferta: OfertaVistaPrecoAmazon, o = opcoes()) =>
  planejarPrecoAmazon(f, oferta, o).decisao;

/* ------------------------------ the fold sites ------------------------------ */

describe('★ mesmaOfertaAmazon — the offer equality (fold site 1)', () => {
  it('EQUAL pair: Amazon’s {10.004, 10, 10} IS the faixa {10, 10, 10} (the same centavo)', () => {
    expect(mesmaOfertaAmazon(faixa(10), lida(10.004, 10, 10))).toBe(true);
    expect(mesmaOfertaAmazon(faixa(10), lida(10, 9.996, 10.004))).toBe(true);
    expect(mesmaOfertaAmazon(faixa(129.9, 119.9, 129.9), lida(129.9, 119.9, 129.9))).toBe(true);
  });

  it('NEAR-MISS: one centavo apart on ANY one of the three prices is a different offer', () => {
    expect(mesmaOfertaAmazon(faixa(10), lida(10, 10.01, 10))).toBe(false);
    expect(mesmaOfertaAmazon(faixa(10), lida(10.01, 10, 10))).toBe(false);
    expect(mesmaOfertaAmazon(faixa(10), lida(10, 10, 10.01))).toBe(false);
    // 0.009 apart, yet two centavos: a tolerance below a centavo would equate them.
    expect(mesmaOfertaAmazon(faixa(50), lida(49.991))).toBe(false);
  });

  it('NEAR-MISS: an absent floor or ceiling never equals a sent one; an unreadable, ambiguous or absent offer equals nothing', () => {
    expect(mesmaOfertaAmazon(faixa(10), lida(10, null, 10))).toBe(false);
    expect(mesmaOfertaAmazon(faixa(10), lida(10, 10, null))).toBe(false);
    for (const oferta of [ILEGIVEL, AMBIGUA, AUSENTE]) {
      expect(mesmaOfertaAmazon(faixa(10), oferta), oferta.tipo).toBe(false);
    }
    // A `lida` without a usable `our_price` is no read at all.
    expect(mesmaOfertaAmazon(faixa(10), { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: null })).toBe(
      false,
    );
  });

  it('mesmaFaixaPrecoAmazon: EQUAL pair {10.004, …} ≡ {10, …}; NEAR-MISS {10.01, …}', () => {
    expect(mesmaFaixaPrecoAmazon(faixa(10.004, 10, 10), faixa(10))).toBe(true);
    expect(mesmaFaixaPrecoAmazon(faixa(10.01, 10, 10.01), faixa(10))).toBe(false);
    expect(mesmaFaixaPrecoAmazon(faixa(10, 9.99, 10), faixa(10))).toBe(false);
  });

  it('a faixa price outside its domain is a wiring bug, thrown (naming the field, never the value)', () => {
    expect(() => mesmaOfertaAmazon(faixa(Number.NaN), lida(10))).toThrow(RangeError);
    expect(() => mesmaOfertaAmazon(faixa(0), lida(10))).toThrow(/faixa\.base/);
    expect(() => mesmaFaixaPrecoAmazon(faixa(10), faixa(10, -1, 10))).toThrow(/b\.minimo/);
  });
});

describe('★ direcaoPrecoAmazon — the direction of our_price (fold site 2)', () => {
  it('EQUAL pair: 50 → 50.004 is `igual` (the same centavo)', () => {
    expect(direcaoPrecoAmazon(50.004, 50)).toBe(DIRECAO_PRECO_AMAZON.igual);
    expect(direcaoPrecoAmazon(49.996, 50)).toBe(DIRECAO_PRECO_AMAZON.igual);
  });

  it('NEAR-MISS: 50 → 49.99 `desce`, 50 → 50.01 `sobe`', () => {
    expect(direcaoPrecoAmazon(49.99, 50)).toBe(DIRECAO_PRECO_AMAZON.desce);
    expect(direcaoPrecoAmazon(50.01, 50)).toBe(DIRECAO_PRECO_AMAZON.sobe);
    expect(direcaoPrecoAmazon(49.991, 50)).toBe(DIRECAO_PRECO_AMAZON.desce);
  });

  it('a `null` (or unusable) reference is `desconhecida`, never `igual`', () => {
    expect(direcaoPrecoAmazon(50, null)).toBe(DIRECAO_PRECO_AMAZON.desconhecida);
    expect(direcaoPrecoAmazon(50, Number.NaN)).toBe(DIRECAO_PRECO_AMAZON.desconhecida);
    expect(direcaoPrecoAmazon(50, 0)).toBe(DIRECAO_PRECO_AMAZON.desconhecida);
    expect(() => direcaoPrecoAmazon(Number.POSITIVE_INFINITY, 50)).toThrow(RangeError);
  });
});

describe('★ quedaExcessivaPrecoAmazon — the mass-decrease measure (fold site 6)', () => {
  it('EQUAL pair: 100 → 50 falls by exactly half, which is not excessive (nor 100 → 49.996: the same centavo as 50)', () => {
    expect(quedaExcessivaPrecoAmazon(50, 100)).toBe(false);
    expect(quedaExcessivaPrecoAmazon(49.996, 100)).toBe(false);
  });

  it('NEAR-MISS: 100 → 49.99 IS excessive, and so is a decimal slip 199.90 → 19.99', () => {
    expect(quedaExcessivaPrecoAmazon(49.99, 100)).toBe(true);
    expect(quedaExcessivaPrecoAmazon(19.99, 199.9)).toBe(true);
  });

  it('an increase, or an unknown current price, is no fall', () => {
    expect(quedaExcessivaPrecoAmazon(300, 100)).toBe(false);
    expect(quedaExcessivaPrecoAmazon(1, null)).toBe(false);
  });
});

/* -------------------------------- the plan --------------------------------- */

describe('★ planejarPrecoAmazon — the plan of one send (fold site 3)', () => {
  it('EQUAL pair: an equal triple ⇒ igual, and 10.004 vs 10 ⇒ igual', () => {
    expect(plano(faixa(10), lida(10))).toBe(DECISAO_PLANO_PRECO_AMAZON.igual);
    expect(plano(faixa(10), lida(10.004, 10, 10))).toBe(DECISAO_PLANO_PRECO_AMAZON.igual);
  });

  it('NEAR-MISS: equal our_price and ceiling, the floor one centavo apart ⇒ escrever (the whole offer is compared)', () => {
    const p = planejarPrecoAmazon(faixa(100, 80, 100), lida(100, 80.01, 100), opcoes());
    expect(p.decisao).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(p.regra).toBe(REGRA_ESCRITA_PRECO_AMAZON.diferente);
    expect(p.direcao).toBe(DIRECAO_PRECO_AMAZON.igual);
  });

  it('a live floor that is absent ⇒ escrever, without consent (our_price does not move)', () => {
    expect(plano(faixa(10), lida(10, null, 10))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('★ only the floor (or only the ceiling) going DOWN needs no consent: the decrease is judged on our_price alone', () => {
    expect(plano(faixa(100, 80, 100), lida(100, 90, 100))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
    expect(plano(faixa(100, 100, 100), lida(100, 100, 120))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
  });

  it('★ an unreadable or ambiguous offer without consent ⇒ preco-atual-ilegivel; with consent ⇒ escrever', () => {
    for (const oferta of [ILEGIVEL, AMBIGUA]) {
      expect(plano(faixa(10), oferta), oferta.tipo).toBe(
        DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel,
      );
      expect(plano(faixa(10), oferta, opcoes(COM_CONSENTIMENTO)), oferta.tipo).toBe(
        DECISAO_PLANO_PRECO_AMAZON.escrever,
      );
    }
  });

  it('★ an ABSENT offer on a listing that is not buyable ⇒ escrever without consent; NEAR-MISS: on a BUYABLE one it is read as unreadable ⇒ preco-atual-ilegivel', () => {
    const naoCompravel = planejarPrecoAmazon(faixa(10), AUSENTE, opcoes({ buyable: false }));
    expect(naoCompravel.decisao).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(naoCompravel.oferta).toBe(TIPO_OFERTA_PRECO_AMAZON.ausente);
    const compravel = planejarPrecoAmazon(faixa(10), AUSENTE, opcoes({ buyable: true }));
    expect(compravel.decisao).toBe(DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel);
    expect(compravel.oferta).toBe(TIPO_OFERTA_PRECO_AMAZON.ilegivel);
    expect(compravel.direcao).toBe(DIRECAO_PRECO_AMAZON.desconhecida);
  });

  it('★ our_price 50 → 49.99 without consent ⇒ reducao-sem-consentimento (NEAR-MISS: 50 → 50.004 ⇒ igual; 50 → 50.01 ⇒ escrever)', () => {
    expect(plano(faixa(49.99), lida(50))).toBe(DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento);
    expect(plano(faixa(50.004), lida(50))).toBe(DECISAO_PLANO_PRECO_AMAZON.igual);
    expect(plano(faixa(50.01), lida(50))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(plano(faixa(49.99), lida(50), opcoes(COM_CONSENTIMENTO))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
  });

  it('★ a LAPSED consent is no consent: baixarPreco 61 min after the request ⇒ reducao-sem-consentimento (NEAR-MISS: 59 min ⇒ escrever)', () => {
    const com = (minutos: number) =>
      opcoes({
        baixarPreco: true,
        consentimentoValido: consentimentoValidoPrecoAmazon(AGORA - minutos * MIN, AGORA),
      });
    expect(plano(faixa(40), lida(50), com(61))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    expect(plano(faixa(40), lida(50), com(59))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    // A valid window with no consent asked is still no consent.
    expect(plano(faixa(40), lida(50), opcoes({ consentimentoValido: true }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
  });

  it('★ the recent-send rule: an EQUAL live offer within 15 min of our own patch of ANOTHER faixa ⇒ escrever (NEAR-MISS: 16 min ⇒ igual)', () => {
    const recente = (minutos: number) =>
      opcoes({ envioRecente: envio({ emMs: AGORA - minutos * MIN, oferta: faixa(40) }) });
    const p = planejarPrecoAmazon(faixa(50), lida(50), recente(14));
    expect(p.decisao).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(p.regra).toBe(REGRA_ESCRITA_PRECO_AMAZON.envioRecente);
    expect(plano(faixa(50), lida(50), recente(16))).toBe(DECISAO_PLANO_PRECO_AMAZON.igual);
    // An `incerto` patch (its answer lost, not its write) counts too.
    expect(
      plano(
        faixa(50),
        lida(50),
        opcoes({
          envioRecente: envio({
            emMs: AGORA - MIN,
            oferta: faixa(40),
            resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
          }),
        }),
      ),
    ).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('★ the lag’s edge, both rules: a patch or a feed end 15 min − 1 ms old still counts, exactly 15 min old does not (NEAR-MISS pair)', () => {
    const patch = (idadeMs: number) =>
      opcoes({ envioRecente: envio({ emMs: AGORA - idadeMs, oferta: faixa(40) }) });
    const feed = (idadeMs: number) => opcoes({ feedRecenteEmMs: AGORA - idadeMs });
    for (const [nome, regra] of [
      ['patch', patch],
      ['feed', feed],
    ] as const) {
      expect(plano(faixa(50), lida(50), regra(JANELA_VISIBILIDADE_PRECO_AMAZON_MS - 1)), nome).toBe(
        DECISAO_PLANO_PRECO_AMAZON.escrever,
      );
      expect(plano(faixa(50), lida(50), regra(JANELA_VISIBILIDADE_PRECO_AMAZON_MS)), nome).toBe(
        DECISAO_PLANO_PRECO_AMAZON.igual,
      );
    }
    // The raised reference has the same edge: a 60 patch 15 min old no longer makes 50 a decrease.
    const de60 = (idadeMs: number) =>
      opcoes({ envioRecente: envio({ emMs: AGORA - idadeMs, oferta: faixa(60) }) });
    expect(plano(faixa(55), lida(50), de60(JANELA_VISIBILIDADE_PRECO_AMAZON_MS - 1))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    expect(plano(faixa(55), lida(50), de60(JANELA_VISIBILIDADE_PRECO_AMAZON_MS))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
  });

  it('★ a patch of ours that may still be landing makes the guard STRICTER: a recent 60 over a live 50 makes a faixa of 50 (or 55) a decrease from 60 ⇒ reducao-sem-consentimento, with consent ⇒ escrever; NEAR-MISS: a recent 40 ⇒ escrever without consent', () => {
    const recente = (
      o: FaixaPrecoAmazon,
      resultado: ResultadoEnvioEstoqueAmazon = RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
    ) => envio({ emMs: AGORA - 5 * MIN, oferta: o, resultado });
    const sem = planejarPrecoAmazon(
      faixa(50),
      lida(50),
      opcoes({ envioRecente: recente(faixa(60)) }),
    );
    expect(sem).toEqual({
      decisao: DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
      regra: null,
      direcao: DIRECAO_PRECO_AMAZON.desce,
      referencia: 60,
      oferta: TIPO_OFERTA_PRECO_AMAZON.lida,
    });
    const com = opcoes({ ...COM_CONSENTIMENTO, envioRecente: recente(faixa(60)) });
    expect(planejarPrecoAmazon(faixa(50), lida(50), com)).toMatchObject({
      decisao: DECISAO_PLANO_PRECO_AMAZON.escrever,
      regra: REGRA_ESCRITA_PRECO_AMAZON.envioRecente,
    });
    expect(
      planejarPrecoAmazon(faixa(50), lida(50), opcoes({ envioRecente: recente(faixa(40)) })),
    ).toMatchObject({
      decisao: DECISAO_PLANO_PRECO_AMAZON.escrever,
      direcao: DIRECAO_PRECO_AMAZON.igual,
      referencia: 50,
    });
    // An entry that may not have applied raises the reference the same way.
    for (const resultado of [
      RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
      RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
    ]) {
      expect(
        plano(faixa(50), lida(50), opcoes({ envioRecente: recente(faixa(60), resultado) })),
        resultado,
      ).toBe(DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento);
    }
    // A read that differs: Amazon still shows 50, our 60 may be landing ⇒ 55 is a decrease.
    expect(
      planejarPrecoAmazon(faixa(55), lida(50), opcoes({ envioRecente: recente(faixa(60)) })),
    ).toMatchObject({
      decisao: DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
      referencia: 60,
    });
    expect(plano(faixa(55), lida(50))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    // No offer read: the patch's price is the reference; an unreadable read stays unknown.
    expect(plano(faixa(50), AUSENTE, opcoes({ envioRecente: recente(faixa(60)) }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    expect(plano(faixa(70), AUSENTE, opcoes({ envioRecente: recente(faixa(60)) }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
    expect(plano(faixa(50), ILEGIVEL, opcoes({ envioRecente: recente(faixa(40)) }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel,
    );
    // A feed's outcome carries no offer: no reference.
    const doFeed = envio({ emMs: AGORA - MIN, feed: true });
    expect(plano(faixa(55), lida(50), opcoes({ envioRecente: doFeed }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
  });

  it('★ neither rule that ADDS a send lets a decrease through: with a recent patch of another faixa or a feed 4 min ago, faixa 40 vs live 50 without consent ⇒ reducao-sem-consentimento, an unreadable live offer ⇒ preco-atual-ilegivel; with consent ⇒ escrever by `diferente`', () => {
    for (const [nome, regra] of [
      ['patch', { envioRecente: envio({ emMs: AGORA - MIN, oferta: faixa(30) }) }],
      ['feed', { feedRecenteEmMs: AGORA - 4 * MIN }],
    ] as const) {
      expect(plano(faixa(40), lida(50), opcoes(regra)), nome).toBe(
        DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
      );
      expect(plano(faixa(40), ILEGIVEL, opcoes(regra)), nome).toBe(
        DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel,
      );
      const com = planejarPrecoAmazon(
        faixa(40),
        lida(50),
        opcoes({ ...regra, ...COM_CONSENTIMENTO }),
      );
      expect(com.decisao, nome).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
      expect(com.regra, nome).toBe(REGRA_ESCRITA_PRECO_AMAZON.diferente);
    }
  });

  it('★ the floor holds under both rules: with consent and floor 45, live 40 = faixa 40 and our recent patch of 50 ⇒ reducao-apos-pagina (NEAR-MISS: faixa 45 ⇒ escrever); a feed 1 min ago with the floor 45 or `desconhecido` ⇒ reducao-apos-pagina (NEAR-MISS: faixa 45, or no floor ⇒ escrever)', () => {
    const patch50 = envio({ emMs: AGORA - MIN, oferta: faixa(50) });
    const comPiso = (
      piso: number | typeof PISO_DESCONHECIDO_PRECO_AMAZON | null,
      o: Partial<OpcoesPlanoPrecoAmazon> = {},
    ) => opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: piso, ...o });
    expect(plano(faixa(40), lida(40), comPiso(45, { envioRecente: patch50 }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(45), lida(45), comPiso(45, { envioRecente: patch50 }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
    const feed = { feedRecenteEmMs: AGORA - MIN };
    expect(plano(faixa(40), lida(40), comPiso(45, feed))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(45), lida(45), comPiso(45, feed))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(plano(faixa(40), lida(40), comPiso(PISO_DESCONHECIDO_PRECO_AMAZON, feed))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(40), lida(40), comPiso(null, feed))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
    // Without consent the feed-recent send is not a decrease from what the read shows.
    expect(plano(faixa(40), lida(40), opcoes(feed))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('the recent-send rule’s fold: our recent patch of {50, …} IS the faixa {50.004, …} ⇒ igual (EQUAL pair); of {49.99, …} ⇒ escrever (NEAR-MISS); a feed’s outcome (no offer) never counts', () => {
    const com = (o: FaixaPrecoAmazon | null, feed = false) =>
      opcoes({ envioRecente: envio({ emMs: AGORA - MIN, oferta: o, feed }) });
    expect(plano(faixa(50.004, 50, 50), lida(50), com(faixa(50)))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.igual,
    );
    expect(plano(faixa(50), lida(50), com(faixa(49.99)))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    // One centavo ABOVE is a decrease from our own patch, not an equal: it needs consent.
    expect(plano(faixa(50), lida(50), com(faixa(50.01)))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    expect(plano(faixa(50), lida(50), com(null, true))).toBe(DECISAO_PLANO_PRECO_AMAZON.igual);
  });

  it('★ the feed-recent rule: 4 min after the conta’s last price feed ⇒ escrever; with feedRecenteEmMs null (a page, a feed build) ⇒ igual; 16 min ⇒ igual', () => {
    const p = planejarPrecoAmazon(
      faixa(50),
      lida(50),
      opcoes({ feedRecenteEmMs: AGORA - 4 * MIN }),
    );
    expect(p.decisao).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(p.regra).toBe(REGRA_ESCRITA_PRECO_AMAZON.feedRecente);
    expect(plano(faixa(50), lida(50), opcoes({ feedRecenteEmMs: null }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.igual,
    );
    expect(plano(faixa(50), lida(50), opcoes({ feedRecenteEmMs: AGORA - 16 * MIN }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.igual,
    );
  });

  it('★ the consent FLOOR: with consent, floor 45, live 50 ⇒ faixa 45 escrever, faixa 44.99 reducao-apos-pagina (NEAR-MISS through the fold: floor 45.004 or faixa 44.996 ⇒ escrever)', () => {
    const piso = (p: number) => opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: p });
    expect(plano(faixa(45), lida(50), piso(45))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(plano(faixa(44.99), lida(50), piso(45))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(45), lida(50), piso(45.004))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(plano(faixa(44.996), lida(50), piso(45))).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    // Without consent the decrease is refused as such, floor or not.
    expect(plano(faixa(44.99), lida(50), opcoes({ pisoConsentimento: 45 }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
    );
  });

  it('★ the floor `desconhecido` (the part is gone) refuses EVERY decrease, every unknown move and every send onto a listing with no offer, even with consent; an increase is sent. `null` (a manual push) is no floor', () => {
    const desconhecido = opcoes({
      ...COM_CONSENTIMENTO,
      pisoConsentimento: PISO_DESCONHECIDO_PRECO_AMAZON,
    });
    expect(plano(faixa(49.99), lida(50), desconhecido)).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(60), lida(50), desconhecido)).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
    expect(plano(faixa(60), ILEGIVEL, desconhecido)).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(plano(faixa(60), AUSENTE, desconhecido)).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(
      plano(faixa(1), lida(50), opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: null })),
    ).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('★ a listing with no offer has nothing to lower (no consent), but a run’s floor still bounds it: floor 45, faixa 44.99 ⇒ reducao-apos-pagina (NEAR-MISS: 45 ⇒ escrever; no floor ⇒ escrever)', () => {
    expect(plano(faixa(44.99), AUSENTE, opcoes({ pisoConsentimento: 45 }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(
      plano(faixa(44.99), AUSENTE, opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: 45 })),
    ).toBe(DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina);
    expect(plano(faixa(45), AUSENTE, opcoes({ pisoConsentimento: 45 }))).toBe(
      DECISAO_PLANO_PRECO_AMAZON.escrever,
    );
    expect(plano(faixa(1), AUSENTE, opcoes())).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('an ambiguous offer keeps its kind in the plan (it is stored so); an unreadable one, and an absent one on a BUYABLE listing, are `ilegivel`', () => {
    expect(planejarPrecoAmazon(faixa(10), AMBIGUA, opcoes(COM_CONSENTIMENTO)).oferta).toBe(
      TIPO_OFERTA_PRECO_AMAZON.ambigua,
    );
    expect(planejarPrecoAmazon(faixa(10), ILEGIVEL, opcoes(COM_CONSENTIMENTO)).oferta).toBe(
      TIPO_OFERTA_PRECO_AMAZON.ilegivel,
    );
    expect(planejarPrecoAmazon(faixa(10), lida(10), opcoes()).oferta).toBe(
      TIPO_OFERTA_PRECO_AMAZON.lida,
    );
  });

  it('an unknown move with consent still meets a numeric floor: an unreadable offer, faixa below the floor ⇒ reducao-apos-pagina', () => {
    expect(
      plano(faixa(44), ILEGIVEL, opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: 45 })),
    ).toBe(DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina);
    expect(
      plano(faixa(45), ILEGIVEL, opcoes({ ...COM_CONSENTIMENTO, pisoConsentimento: 45 })),
    ).toBe(DECISAO_PLANO_PRECO_AMAZON.escrever);
  });

  it('an instant, a floor or a faixa price outside its domain is a wiring bug, thrown', () => {
    expect(() => planejarPrecoAmazon(faixa(10), lida(10), opcoes({ agoraMs: -1 }))).toThrow(
      /agoraMs/,
    );
    expect(() =>
      planejarPrecoAmazon(faixa(10), lida(10), opcoes({ feedRecenteEmMs: 1.5 })),
    ).toThrow(/feedRecenteEmMs/);
    expect(() =>
      planejarPrecoAmazon(faixa(10), lida(10), opcoes({ pisoConsentimento: 0 })),
    ).toThrow(/pisoConsentimento/);
    expect(() => planejarPrecoAmazon(faixa(10, Number.NaN), lida(10), opcoes())).toThrow(
      /faixa\.minimo/,
    );
  });
});

describe('consentimentoValidoPrecoAmazon — the consent window', () => {
  it('lasts 60 min from the request, inclusive (NEAR-MISS: 60 min + 1 ms has lapsed)', () => {
    expect(JANELA_CONSENTIMENTO_PRECO_AMAZON_MS).toBe(60 * MIN);
    expect(consentimentoValidoPrecoAmazon(AGORA - 60 * MIN, AGORA)).toBe(true);
    expect(consentimentoValidoPrecoAmazon(AGORA - 60 * MIN - 1, AGORA)).toBe(false);
  });

  it('a request stamped ahead of the task’s clock counts up to 5 min of skew, never more (a stamp from the future cannot stretch the window)', () => {
    expect(TOLERANCIA_RELOGIO_CONSENTIMENTO_PRECO_AMAZON_MS).toBe(5 * MIN);
    expect(consentimentoValidoPrecoAmazon(AGORA + 5 * MIN, AGORA)).toBe(true);
    expect(consentimentoValidoPrecoAmazon(AGORA + 5 * MIN + 1, AGORA)).toBe(false);
    expect(() => consentimentoValidoPrecoAmazon(-1, AGORA)).toThrow(/solicitadoEmMs/);
  });

  it('the visibility lag is Amazon’s documented 15 min, the stock plan’s own bound', () => {
    expect(JANELA_VISIBILIDADE_PRECO_AMAZON_MS).toBe(15 * MIN);
    expect(JANELA_VISIBILIDADE_PRECO_AMAZON_MS).toBe(JANELA_VISIBILIDADE_MS);
  });
});

/* ------------------------------- the check ---------------------------------- */

const issue = (code: string | null, extra: Record<string, unknown> = {}) => ({
  ...(code === null ? {} : { code }),
  severity: 'ERROR',
  ...extra,
});

describe('★ planejarVerificacaoPrecoAmazon — the check after a send (fold site 4)', () => {
  const verificar = (
    agora: FaixaPrecoAmazon,
    oferta: OfertaVistaPrecoAmazon,
    issues: unknown = [],
    antes: readonly string[] = [],
  ) => planejarVerificacaoPrecoAmazon(agora, faixa(10), oferta, issues, antes);

  it('EQUAL pair: the faixa now {10.004, …} vs the stored offer {10, …} proceeds (never erp-mudou)', () => {
    expect(verificar(faixa(10.004, 10, 10), lida(10))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceito,
    );
    expect(erpMudouPrecoAmazon(faixa(10.004, 10, 10), faixa(10))).toBe(false);
  });

  it('NEAR-MISS: the faixa now {10.01, …} ⇒ erp-mudou, whatever Amazon shows', () => {
    expect(verificar(faixa(10.01, 10, 10.01), lida(10))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.erpMudou,
    );
    expect(verificar(faixa(10, 9.99, 10), lida(10))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.erpMudou,
    );
    expect(erpMudouPrecoAmazon(faixa(10.01), faixa(10))).toBe(true);
  });

  it('EQUAL pair: a live offer equal to the stored one to the centavo ⇒ aceito; NEAR-MISS: one centavo off ⇒ reenviar', () => {
    expect(verificar(faixa(10), lida(10.004, 10, 9.996))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceito,
    );
    expect(verificar(faixa(10), lida(10.01, 10, 10))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar,
    );
    expect(verificar(faixa(10), lida(10, null, 10))).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar,
    );
    expect(verificar(faixa(10), ILEGIVEL)).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar);
  });

  it('★ a NEW price ERROR (not read before the send) ⇒ recusado, even with the offer shown; one read before that persists ⇒ aceito-com-avisos', () => {
    expect(verificar(faixa(10), lida(10), [issue('19037')])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.recusado,
    );
    expect(verificar(faixa(10), lida(10), [issue('19037')], ['19037'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceitoComAvisos,
    );
    // A codeless price ERROR cannot be one read before: it is new.
    expect(
      verificar(faixa(10), lida(10), [issue(null, { categories: ['INVALID_PRICE'] })], ['19037']),
    ).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.recusado);
  });

  it('★ 18701 is never sent again: persisting while Amazon does not show our offer ⇒ recusado (NEAR-MISS: a persisting 19037 ⇒ reenviar, the one re-send)', () => {
    expect(verificar(faixa(10), lida(9), [issue('18701')], ['18701'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.recusado,
    );
    expect(verificar(faixa(10), lida(9), [issue('19037')], ['19037'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar,
    );
    expect(verificar(faixa(10), lida(9), [issue('18701')])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.recusado,
    );
    expect(verificar(faixa(10), lida(10), [issue('18701')], ['18701'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceitoComAvisos,
    );
  });

  it('★ a price WARNING blocks nothing: new or read before, it leaves the offer shown `aceito` (NEAR-MISS: a persisting ERROR ⇒ aceito-com-avisos) and an unapplied one reenviar; a non-price issue or another store’s is ignored', () => {
    const aviso = issue('100708', { severity: 'WARNING', categories: ['INVALID_PRICE'] });
    expect(verificar(faixa(10), lida(10), [aviso])).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.aceito);
    expect(verificar(faixa(10), lida(10), [aviso], ['100708'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceito,
    );
    expect(verificar(faixa(10), lida(10), [aviso, issue('19037')], ['19037'])).toBe(
      DECISAO_VERIFICACAO_PRECO_AMAZON.aceitoComAvisos,
    );
    expect(verificar(faixa(10), lida(9), [aviso])).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.reenviar);
    expect(
      verificar(faixa(10), lida(10), [issue('90220', { attributeNames: ['item_name'] })]),
    ).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.aceito);
    expect(
      verificar(faixa(10), lida(10), [issue('19037', { marketplaceIds: ['ATVPDKIKX0DER'] })]),
    ).toBe(DECISAO_VERIFICACAO_PRECO_AMAZON.aceito);
  });
});

/* ------------------------- a feed member at send time ------------------------ */

describe('★ decidirMembroLotePrecoAmazon — montar’s decrease reference (fold site 5)', () => {
  /** A member whose page read 50 and computed the faixa 45 (the floor), read at AGORA. */
  const membro = (oferta: OfertaVistaPrecoAmazon = lida(50), piso = 45) => ({
    oferta: ofertaPrecoAmazonSchema.parse(oferta),
    faixa: faixa(piso),
    lidoEmMs: AGORA,
  });
  const depois = (oferta: FaixaPrecoAmazon | null, resultado: ResultadoEnvioEstoqueAmazon) =>
    envio({ emMs: AGORA + MIN, oferta, resultado, feed: oferta === null });
  const decidir = (
    envioGuardado: EnvioPrecoAmazon | null,
    baixarPreco = false,
    m = membro(),
    agora = faixa(45),
  ) => decidirMembroLotePrecoAmazon(m, agora, envioGuardado, baixarPreco);

  it('no later send ⇒ the page’s offer 50 ⇒ desce ⇒ dropped reducao-sem-consentimento', () => {
    const d = decidir(null);
    expect(d).toEqual({
      enviar: false,
      motivo: DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
      direcao: DIRECAO_PRECO_AMAZON.desce,
      referencia: 50,
    });
    // A send at the read's own instant is not later.
    expect(decidir(envio({ emMs: AGORA, oferta: faixa(40) })).enviar).toBe(false);
  });

  it('a later send Amazon ACCEPTED of 40 is the reference ⇒ sobe ⇒ sent (aceito-com-avisos alike)', () => {
    for (const resultado of [
      RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
      RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
    ]) {
      const d = decidir(depois(faixa(40), resultado));
      expect(d.enviar, resultado).toBe(true);
      expect(d.direcao).toBe(DIRECAO_PRECO_AMAZON.sobe);
      expect(d.referencia).toBe(40);
    }
  });

  it('★ NEAR-MISS against “the newest entry wins”: a later `incerto` of 40 (a write-ahead a refusal left) or a `recusado` 40 ⇒ the HIGHER of 50 and 40 ⇒ dropped', () => {
    for (const resultado of [
      RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
      RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
    ]) {
      const d = decidir(depois(faixa(40), resultado));
      expect(d.enviar, resultado).toBe(false);
      expect(d.referencia).toBe(50);
    }
  });

  it('★ our patch just BEFORE the page’s read may not show in it: an accepted 60 two minutes before a read of 50 is the reference, as for the page’s own plan ⇒ the faixa now 55 is dropped, without consent or below the floor 65 with it (NEAR-MISS: the same patch the lag or more before the read ⇒ the read, 50 → 55 sent; a feed outcome before the read changes nothing)', () => {
    const antes = (idadeMs: number, oferta: FaixaPrecoAmazon | null = faixa(60)) =>
      envio({ emMs: AGORA - idadeMs, oferta, feed: oferta === null });
    const m = membro(lida(50), 65);
    expect(decidir(antes(2 * MIN), false, m, faixa(55))).toEqual({
      enviar: false,
      motivo: DECISAO_PLANO_PRECO_AMAZON.reducaoSemConsentimento,
      direcao: DIRECAO_PRECO_AMAZON.desce,
      referencia: 60,
    });
    // The page's own plan, at its read, judged from the same reference.
    expect(
      planejarPrecoAmazon(faixa(65), lida(50), opcoes({ envioRecente: antes(2 * MIN) })).referencia,
    ).toBe(60);
    const com = decidir(antes(2 * MIN), true, m, faixa(55));
    expect(com.enviar === false && com.motivo).toBe(DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina);
    expect(
      decidir(antes(JANELA_VISIBILIDADE_PRECO_AMAZON_MS - 1), false, m, faixa(55)).enviar,
    ).toBe(false);
    expect(decidir(antes(JANELA_VISIBILIDADE_PRECO_AMAZON_MS), false, m, faixa(55))).toMatchObject({
      enviar: true,
      direcao: DIRECAO_PRECO_AMAZON.sobe,
      referencia: 50,
    });
    expect(decidir(antes(2 * MIN, null), false, m, faixa(55))).toMatchObject({
      enviar: true,
      referencia: 50,
    });
  });

  it('a later `incerto` of 60 ⇒ the reference 60 ⇒ dropped; with consent and the floor 45 ⇒ sent', () => {
    const incerto60 = depois(faixa(60), RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto);
    const sem = decidir(incerto60);
    expect(sem.enviar).toBe(false);
    expect(sem.referencia).toBe(60);
    const com = decidir(incerto60, true);
    expect(com.enviar).toBe(true);
    expect(com.direcao).toBe(DIRECAO_PRECO_AMAZON.desce);
  });

  it('an unreadable page offer and a later `incerto` ⇒ unknown ⇒ consent needed (preco-atual-ilegivel); with consent ⇒ sent', () => {
    const m = membro(ILEGIVEL);
    const incerto = depois(faixa(40), RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto);
    const sem = decidir(incerto, false, m);
    expect(sem.enviar).toBe(false);
    expect(sem.enviar === false && sem.motivo).toBe(DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel);
    expect(sem.referencia).toBeNull();
    expect(decidir(incerto, true, m).enviar).toBe(true);
    // …while an ACCEPTED later send makes it known.
    expect(decidir(depois(faixa(40), RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito), false, m).enviar).toBe(
      true,
    );
  });

  it('a later feed entry (no offer stored) ⇒ unknown ⇒ consent needed, even for a faixa ABOVE the page’s offer', () => {
    const feed = depois(null, RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito);
    const recusa = {
      enviar: false,
      motivo: DECISAO_PLANO_PRECO_AMAZON.precoAtualIlegivel,
      direcao: DIRECAO_PRECO_AMAZON.desconhecida,
      referencia: null,
    };
    expect(decidir(feed)).toEqual(recusa);
    // NEAR-MISS against the page's offer as the reference (50 → 55 would read `sobe`, sent).
    expect(decidir(feed, false, membro(), faixa(55))).toEqual(recusa);
    expect(decidir(feed, true)).toEqual({
      enviar: true,
      direcao: DIRECAO_PRECO_AMAZON.desconhecida,
      referencia: null,
      igualAPagina: false,
    });
    expect(decidir(feed, true, membro(), faixa(55)).enviar).toBe(true);
  });

  it('★ the floor at send time: with consent, the faixa now 44.99 below the page’s 45 ⇒ reducao-apos-pagina (NEAR-MISS: 45 ⇒ sent)', () => {
    const abaixo = decidir(null, true, membro(), faixa(44.99));
    expect(abaixo.enviar === false && abaixo.motivo).toBe(
      DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina,
    );
    expect(decidir(null, true, membro(), faixa(45)).enviar).toBe(true);
  });

  it('★ NEVER dropped for equality: the faixa now equal to the page’s offer is still sent (igualAPagina), one centavo apart is not igualAPagina', () => {
    const igual = decidir(null, false, membro(), faixa(50));
    expect(igual).toEqual({
      enviar: true,
      direcao: DIRECAO_PRECO_AMAZON.igual,
      referencia: 50,
      igualAPagina: true,
    });
    const quase = decidir(null, false, membro(), faixa(50.01));
    expect(quase.enviar && quase.igualAPagina).toBe(false);
    expect(decidir(null, false, membro(), faixa(50.004, 50, 50))).toMatchObject({
      igualAPagina: true,
    });
  });

  it('★ an absent page offer meets the floor too: page faixa 50, the ERP now 49.99 ⇒ reducao-apos-pagina, consent or not (NEAR-MISS: 50 ⇒ sent)', () => {
    const abaixo = { enviar: false, motivo: DECISAO_PLANO_PRECO_AMAZON.reducaoAposPagina };
    expect(decidir(null, false, membro(AUSENTE, 50), faixa(49.99))).toMatchObject(abaixo);
    expect(decidir(null, true, membro(AUSENTE, 50), faixa(49.99))).toMatchObject(abaixo);
    expect(decidir(null, false, membro(AUSENTE, 50), faixa(50)).enviar).toBe(true);
  });

  it('an absent page offer has nothing to lower (sent without consent); a later unapplied send then becomes the reference', () => {
    expect(decidir(null, false, membro(AUSENTE)).enviar).toBe(true);
    const d = decidir(
      depois(faixa(60), RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto),
      false,
      membro(AUSENTE),
    );
    expect(d.enviar).toBe(false);
    expect(d.referencia).toBe(60);
  });
});

/* -------------------------------- the sample -------------------------------- */

describe('amostraReducoesPrecoAmazon — the decrease sample', () => {
  it('the largest decreases first, in centavos, at most 20; a tie by the entry’s text', () => {
    const novas = Array.from({ length: 25 }, (_v, i) => ({
      sku: `S${String(i).padStart(2, '0')}`,
      antes: 100,
      depois: 100 - (i + 1) * 0.5,
    }));
    const amostra = amostraReducoesPrecoAmazon(novas);
    expect(amostra).toHaveLength(20);
    expect(amostra[0]).toBe('S24:100>87.5');
    expect(amostra.at(-1)).toBe('S05:100>97');
    expect(
      amostraReducoesPrecoAmazon([
        { sku: 'B', antes: 10, depois: 9 },
        { sku: 'A', antes: 20, depois: 19 },
      ]),
    ).toEqual(['A:20>19', 'B:10>9']);
  });

  it('NEAR-MISS: a move of less than a centavo, or an increase, is no decrease; the earlier entries are merged in', () => {
    expect(amostraReducoesPrecoAmazon([{ sku: 'X', antes: 50, depois: 49.996 }])).toEqual([]);
    expect(amostraReducoesPrecoAmazon([{ sku: 'X', antes: 50, depois: 60 }])).toEqual([]);
    expect(
      amostraReducoesPrecoAmazon([{ sku: 'novo', antes: 10, depois: 5 }], ['velho:100>1', 'x']),
    ).toEqual(['velho:100>1', 'novo:10>5']);
  });

  it('a SKU holding `:` and `>` is read back from the end; an entry the run cannot store (over 200 characters) is left out — the bound IS the run schema’s', () => {
    expect(amostraReducoesPrecoAmazon([{ sku: 'a>b:c', antes: 3, depois: 2 }])).toEqual([
      'a>b:c:3>2',
    ]);
    const cabe = `${'x'.repeat(MAX_CARACTERES_AMOSTRA_PRECO_AMAZON - 4)}:9>8`;
    const passa = `x${cabe}`;
    expect(cabe).toHaveLength(MAX_CARACTERES_AMOSTRA_PRECO_AMAZON);
    expect(amostraReducoesPrecoAmazon([], [cabe, passa])).toEqual([cabe]);
    const amostra = execucaoPrecoAmazonSchema.shape.amostraReducoes;
    expect(amostra.safeParse([cabe]).success).toBe(true);
    expect(amostra.safeParse([passa]).success).toBe(false);
  });
});

describe('the offer vocabulary across the package boundary', () => {
  it('the schemas’ offer kinds ARE the package reader’s', () => {
    expect(Object.values(TIPO_OFERTA_PRECO_AMAZON).sort()).toEqual(
      Object.values(TIPO_OFERTA_LISTING_AMAZON).sort(),
    );
  });
});
