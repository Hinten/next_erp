/**
 * O que este arquivo trava, em uma frase cada:
 *
 * - a decisão por documento (`planejarTotais`) — inclusive a releitura REAL,
 *   com `extrairTotaisNFe` de verdade sobre um `<nfeProc>` montado à mão, e não
 *   só com o extrator injetado como stub;
 * - a idempotência, que é o contrato do pacote e não um detalhe: a segunda
 *   passada tem de ver `ja-igual`;
 * - o alcance da comparação, campo a campo, DERIVADO do schema — de modo que um
 *   campo novo em `nfeTotaisSchema` que a comparação esquecesse reprove aqui em
 *   vez de virar um `ja-igual` silencioso em produção.
 */
import { describe, expect, it } from 'vitest';

import { extrairTotaisNFe } from '@delfrance/integrations-nfe/http-provider';
import { nfeTotaisSchema, type NFeTotais } from '@delfrance/schemas';

import { lacunasDeAtribuicao, planejarTotais, totaisIguais } from './transform';

/** Um `<nfeProc>` mínimo, mas com a mesma forma do documento real. */
function nfeProc(opts: { tpNF?: string; finNFe?: string; total?: Record<string, string> }): string {
  const total = Object.entries(
    opts.total ?? { vProd: '100.00', vDesc: '0.00', vFrete: '10.00', vNF: '110.00' },
  )
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('');
  return (
    `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe>` +
    `<ide><tpNF>${opts.tpNF ?? '1'}</tpNF><finNFe>${opts.finNFe ?? '1'}</finNFe></ide>` +
    `<det nItem="1"><prod><vProd>1.00</vProd><vDesc>0.00</vDesc></prod></det>` +
    `<total><ICMSTot>${total}</ICMSTot></total>` +
    `</infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`
  );
}

/** Um bloco completo, do jeito que o extrator o produz. */
function totaisDe(xml: string): NFeTotais {
  const t = extrairTotaisNFe(xml);
  if (t === null) throw new Error('fixture inválida: o extrator não leu este XML');
  return t;
}

const XML = nfeProc({});
const TOTAIS = totaisDe(XML);

describe('planejarTotais', () => {
  it('grava o bloco numa nota autorizada que não tem nenhum', () => {
    const plano = planejarTotais({ xml_nfe_proc: XML }, extrairTotaisNFe);
    expect(plano).toEqual({ acao: 'gravar', motivo: 'ausente', totais: TOTAIS });
  });

  it('lê os totais do XML de verdade, não de um stub', () => {
    // 100 − 0 + 10 = 110 de receita bruta, e o `vNF` do próprio documento.
    const plano = planejarTotais({ xml_nfe_proc: XML }, extrairTotaisNFe);
    expect(plano.acao === 'gravar' && plano.totais.receitaBruta).toBe(110);
    expect(plano.acao === 'gravar' && plano.totais.vNF).toBe(110);
  });

  it('⚠️ IDEMPOTÊNCIA: a segunda passada não reescreve nada', () => {
    const primeira = planejarTotais({ xml_nfe_proc: XML }, extrairTotaisNFe);
    expect(primeira.acao).toBe('gravar');

    const depois = planejarTotais(
      { xml_nfe_proc: XML, totais: primeira.acao === 'gravar' ? primeira.totais : null },
      extrairTotaisNFe,
    );
    expect(depois).toEqual({ acao: 'pular', motivo: 'ja-igual' });
  });

  it('⚠️ o bloco PARCIAL da fatia 1 (sem receitaBruta) é reescrito, não aceito', () => {
    // A população que existe de verdade: gravada pelo #1541, incompleta para a
    // soma mensal — que ignora em SILÊNCIO o documento sem `receitaBruta`.
    const { receitaBruta: _omitido, ...parcial } = TOTAIS;
    const plano = planejarTotais({ xml_nfe_proc: XML, totais: parcial }, extrairTotaisNFe);
    expect(plano).toEqual({ acao: 'gravar', motivo: 'divergente', totais: TOTAIS });
  });

  it('pula a nota sem xml_nfe_proc — nunca autorizada, ou EPEC em trânsito', () => {
    expect(planejarTotais({ xml_nfe_proc: null }, extrairTotaisNFe)).toEqual({
      acao: 'pular',
      motivo: 'sem-xml',
    });
    expect(planejarTotais({}, extrairTotaisNFe)).toEqual({ acao: 'pular', motivo: 'sem-xml' });
    expect(planejarTotais({ xml_nfe_proc: '' }, extrairTotaisNFe)).toEqual({
      acao: 'pular',
      motivo: 'sem-xml',
    });
  });

  it('⚠️ um XML ilegível fica SEM bloco — nunca um bloco zerado', () => {
    // Um componente malformado dobrado para `0` deixaria a nota parecendo
    // legível, e a apuração publicaria uma alíquota sobre uma receita que ela
    // mesma estragou. Sem bloco, a nota é contada em `notasIlegiveis` e a
    // alíquota não é promovida — que é o comportamento certo.
    const quebrado = nfeProc({ total: { vProd: '1,50', vNF: '1,50' } });
    expect(planejarTotais({ xml_nfe_proc: quebrado }, extrairTotaisNFe)).toEqual({
      acao: 'pular',
      motivo: 'ilegivel',
    });
  });

  it('não confunde "ilegível" com "sem bloco": um XML ilegível NÃO apaga o que está gravado', () => {
    const quebrado = nfeProc({ total: { vProd: '1,50', vNF: '1,50' } });
    expect(planejarTotais({ xml_nfe_proc: quebrado, totais: TOTAIS }, extrairTotaisNFe)).toEqual({
      acao: 'pular',
      motivo: 'ilegivel',
    });
  });
});

describe('totaisIguais', () => {
  it('⚠️ ALCANCE: alterar QUALQUER campo do schema é detectado', () => {
    // Derivado de `nfeTotaisSchema`, não de uma lista à mão: um campo novo que
    // a comparação esquecesse faria o backfill responder `ja-igual` justamente
    // para as notas que precisam dele. Aqui isso vira um teste vermelho.
    const chaves = Object.keys(nfeTotaisSchema.shape) as (keyof NFeTotais)[];
    expect(chaves.length).toBeGreaterThan(1);

    for (const chave of chaves) {
      const mexido = { ...TOTAIS, [chave]: chave === 'rtc' ? { vNFTot: 1 } : 999.99 };
      expect(totaisIguais(mexido, TOTAIS), `campo ignorado pela comparação: ${chave}`).toBe(false);
    }
  });

  it('trata rtc ausente e rtc null como a mesma coisa — a nota pré-Reforma', () => {
    // Se estes divergissem, TODA nota anterior à Reforma seria reescrita a cada
    // passada e a idempotência do pacote seria falsa.
    const { rtc: _semChave, ...semRtc } = TOTAIS;
    expect(TOTAIS.rtc).toBeNull();
    expect(totaisIguais(semRtc, TOTAIS)).toBe(true);
    expect(totaisIguais({ ...TOTAIS, rtc: null }, TOTAIS)).toBe(true);
  });

  it('⚠️ NEAR-MISS: um centavo de diferença NÃO é igual', () => {
    // O contrário do teste acima. A comparação existe para pular reescritas, e
    // uma que folgasse um centavo pularia justamente a nota que mudou.
    expect(totaisIguais({ ...TOTAIS, vNF: TOTAIS.vNF + 0.01 }, TOTAIS)).toBe(false);
    expect(totaisIguais({ ...TOTAIS, receitaBruta: TOTAIS.receitaBruta - 0.01 }, TOTAIS)).toBe(
      false,
    );
  });

  it('um bloco RTC completo compara pelos campos dele, não por referência', () => {
    const comRtc: NFeTotais = {
      ...TOTAIS,
      rtc: { vBCIBSCBS: 100, vIBS: 8.8, vCBS: 0.9, vIS: 0, vNFTot: 119.7 },
    };
    expect(totaisIguais({ ...comRtc, rtc: { ...comRtc.rtc } }, comRtc)).toBe(true);
    expect(totaisIguais({ ...comRtc, rtc: { ...comRtc.rtc, vIBS: 8.81 } }, comRtc)).toBe(false);
    // Um lado com RTC e o outro sem NÃO são iguais: são notas de regimes
    // diferentes, e aceitar isso deixaria a nota RTC com o bloco antigo.
    expect(totaisIguais(TOTAIS, comRtc)).toBe(false);
    expect(totaisIguais(comRtc, TOTAIS)).toBe(false);
  });

  it('não aceita qualquer coisa como bloco gravado', () => {
    expect(totaisIguais(null, TOTAIS)).toBe(false);
    expect(totaisIguais('totais', TOTAIS)).toBe(false);
    expect(totaisIguais(42, TOTAIS)).toBe(false);
  });
});

describe('lacunasDeAtribuicao — measured here, fixed nowhere', () => {
  const aprovada = { estado: 'a', xml_nfe_proc: XML };

  it('an approved note carrying both fields has no gap', () => {
    expect(
      lacunasDeAtribuicao({ ...aprovada, filialId: 'f1', data_emissao: 1_757_000_000_000 }),
    ).toEqual({ semFilial: false, semDataEmissao: false });
  });

  it('⚠️ no filialId — since #1546 this BLOCKS every filial, so its SIZE decides the window', () => {
    // `nfeSchema` marks the field `.nullable().optional()` explicitly for
    // read-tolerance of legacy docs, and the imported corpus is exactly those.
    // If this count is in the thousands, no rate publishes anywhere until
    // someone deals with them — far better known before the window than after.
    const r = lacunasDeAtribuicao({ ...aprovada, data_emissao: 1_757_000_000_000 });
    expect(r.semFilial).toBe(true);
    expect(lacunasDeAtribuicao({ ...aprovada, filialId: null }).semFilial).toBe(true);
    expect(lacunasDeAtribuicao({ ...aprovada, filialId: '' }).semFilial).toBe(true);
  });

  it('⚠️ no data_emissao — the one gap that is still silent', () => {
    // A null fails any range, so the note is in no competência at all, and the
    // control aggregate cannot see it either: the control uses the same range.
    const r = lacunasDeAtribuicao({ ...aprovada, filialId: 'f1' });
    expect(r.semDataEmissao).toBe(true);
    expect(
      lacunasDeAtribuicao({ ...aprovada, filialId: 'f1', data_emissao: null }).semDataEmissao,
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: only APPROVED notes with an XML count', () => {
    // A cancelled or never-authorized note has no revenue to lose. Counting it
    // would inflate the number someone uses to decide whether the window can
    // run — the opposite of what this measurement is for.
    expect(lacunasDeAtribuicao({ estado: 'c', xml_nfe_proc: XML })).toEqual({
      semFilial: false,
      semDataEmissao: false,
    });
    expect(lacunasDeAtribuicao({ estado: 'a', xml_nfe_proc: null })).toEqual({
      semFilial: false,
      semDataEmissao: false,
    });
    expect(lacunasDeAtribuicao({})).toEqual({ semFilial: false, semDataEmissao: false });
  });

  it('both gaps can be true on the same note', () => {
    expect(lacunasDeAtribuicao(aprovada)).toEqual({ semFilial: true, semDataEmissao: true });
  });
});
