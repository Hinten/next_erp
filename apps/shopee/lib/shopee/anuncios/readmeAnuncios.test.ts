/**
 * Pins what `README.md` (this folder's design doc) states about the publish
 * refusal vocabulary against the code (#1911 batch-B review, P12).
 *
 * Two drifts this catches, both of which happened once: the README's motivo
 * count still said 57 after the reservation's `criacaoIncertaEncerrada` made
 * it 58, and the README never named that member at all. Nothing else reads the
 * README, so each new motivo used to depend on a human remembering the doc.
 *
 * ⚠️ No motivo slug is QUOTED here: the producer greps in
 * `errosPublicacao.test.ts` / `montagemAnuncio.test.ts` skip test files, but
 * this file reads every member through `MOTIVO_PUBLICACAO_BLOQUEADA` anyway.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from './errosPublicacao';

function ler(relativo: string): string {
  return readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), { encoding: 'utf8' });
}

/** Whitespace folded to one space, so a re-wrapped paragraph reads the same. */
function emUmaLinha(texto: string): string {
  return texto.replace(/\s+/g, ' ');
}

/**
 * Every count the README gives for the blocked vocabulary — the `N` of
 * "step 11's 22 motivos (N today". `22` is step 11's own, historical, figure
 * and is never read as the count.
 */
function contagensDoLeiaMe(texto: string): number[] {
  return [...emUmaLinha(texto).matchAll(/step 11's 22 motivos \((\d+) today/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * Does `texto` name `slug` as ITSELF — in backticks, so a slug that is a
 * substring of another (`semNome`'s inside `marcaSemNome`'s) is never counted
 * by the longer one.
 */
function nomeia(texto: string, slug: string): boolean {
  return texto.includes(`\`${slug}\``);
}

/** The members `criacaoIncerta.ts` builds, read through the constant (as montagemAnuncio's pin). */
function motivosDaCriacaoIncerta(): string[] {
  const fonte = ler('./criacaoIncerta.ts');
  const membros = new Set<string>();
  for (const [, chave] of fonte.matchAll(/MOTIVO_PUBLICACAO_BLOQUEADA\.(\w+)/g)) {
    const membro = (MOTIVO_PUBLICACAO_BLOQUEADA as Record<string, string>)[chave ?? ''];
    if (membro !== undefined) membros.add(membro);
  }
  return [...membros].sort();
}

const LEIA_ME = ler('./README.md');

describe('README.md de anuncios/ — o que ele afirma sobre as recusas', () => {
  it('a contagem do vocabulário bloqueado é EXATAMENTE a do código, numa única frase', () => {
    const total = Object.keys(MOTIVO_PUBLICACAO_BLOQUEADA).length;
    // One sentence, found: a reworded sentence must red here, never make the
    // pin vacuous (zero matches would "agree" with anything under `every`).
    expect(contagensDoLeiaMe(LEIA_ME)).toEqual([total]);
  });

  it('near-miss: o leitor não toma o 22 histórico pela contagem, e a comparação é exata', () => {
    const total = Object.keys(MOTIVO_PUBLICACAO_BLOQUEADA).length;
    const quebrada = `step 11's 22 motivos\n(${String(total - 1)} today — steps 19 and #1911`;
    // Re-wrapped across a line, still read; one short of the code, still distinct.
    expect(contagensDoLeiaMe(quebrada)).toEqual([total - 1]);
    expect(contagensDoLeiaMe(quebrada)).not.toEqual([total]);
    expect(contagensDoLeiaMe('step 11 has 22 motivos')).toEqual([]);
  });

  it('o README nomeia, entre crases, cada motivo que criacaoIncerta.ts constrói', () => {
    const motivos = motivosDaCriacaoIncerta();
    // ENSURE's four, the reservation's encerrada and P5b's three (the exact
    // set is montagemAnuncio.test.ts's pin; this one asks only the doc).
    expect(motivos.length).toBeGreaterThanOrEqual(8);
    expect(motivos.filter((m) => !nomeia(LEIA_ME, m))).toEqual([]);
    expect(nomeia(LEIA_ME, MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaEncerrada)).toBe(true);
  });

  it('near-miss: um slug contido em outro não conta como nomeado pelo mais longo', () => {
    const curto = MOTIVO_PUBLICACAO_BLOQUEADA.semNome;
    const longo = MOTIVO_PUBLICACAO_BLOQUEADA.marcaSemNome;
    // A REAL containment, or this near-miss proves nothing.
    expect(longo.includes(curto)).toBe(true);
    const soOLongo = `a recusa \`${longo}\` (sem acao)`;
    expect(nomeia(soOLongo, longo)).toBe(true);
    expect(nomeia(soOLongo, curto)).toBe(false);
  });

  /*
   * #1911 batch-B P12 re-verify: the pins above survive deleting the
   * `criacaoIncertaAdota` paragraph alone (its motivos are also named in the
   * ENSURE table), and nothing reds when a function it cites is renamed. This
   * pins that the paragraph exists, keeps its three outcomes, and that every
   * function it names still exists in the file that defines it.
   */
  const PARAGRAFO_ADOTA = '**`criacaoIncertaAdota` — what the attestation expects**';
  const PROXIMO_PARAGRAFO = '**D15 runs BEFORE ENSURE.**';

  /** The paragraph, whitespace folded — `''` when either boundary is missing. */
  function paragrafoDaExpectativa(texto: string): string {
    const linha = emUmaLinha(texto);
    const inicio = linha.indexOf(PARAGRAFO_ADOTA);
    if (inicio < 0) return '';
    const fim = linha.indexOf(PROXIMO_PARAGRAFO, inicio);
    return fim < 0 ? '' : linha.slice(inicio, fim);
  }

  /** `[symbol, the file that defines it]` — each one the paragraph cites. */
  const SIMBOLOS_CITADOS = [
    ['decidir', './criacaoIncerta.ts'],
    ['atestacaoConfere', './criacaoIncerta.ts'],
    ['recusarAtestacaoNumBracoDeKit', './publicarShopee.ts'],
    ['conflitoDeRascunhoJaPublicado', './reservaRascunho.ts'],
  ] as const;

  it('o parágrafo de `criacaoIncertaAdota` existe, nomeia os três desfechos e só cita funções que existem', () => {
    const paragrafo = paragrafoDaExpectativa(LEIA_ME);
    expect(paragrafo).not.toBe('');
    expect(paragrafo).toContain('`corpoPublicacao.ts` answers 400 at the parse');
    expect(nomeia(paragrafo, MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaJaVinculada)).toBe(true);
    expect(nomeia(paragrafo, MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaSemSku)).toBe(true);
    expect(nomeia(paragrafo, MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaEncerrada)).toBe(true);
    expect(nomeia(paragrafo, 'JA_PUBLICADO')).toBe(true);
    for (const [simbolo, arquivo] of SIMBOLOS_CITADOS) {
      expect(nomeia(paragrafo, simbolo), simbolo).toBe(true);
      expect(ler(arquivo), `${simbolo} em ${arquivo}`).toMatch(
        new RegExp(`^(?:export )?function ${simbolo}\\(`, 'm'),
      );
    }
  });

  it('near-miss: o recorte para no parágrafo seguinte, e sem a abertura não recorta nada', () => {
    const paragrafo = paragrafoDaExpectativa(LEIA_ME);
    // The D15 paragraph right after names other functions; the slice must stop before it.
    expect(paragrafo).not.toContain(PROXIMO_PARAGRAFO);
    expect(paragrafoDaExpectativa(LEIA_ME.replace(PARAGRAFO_ADOTA, '**Atestação**'))).toBe('');
    // A cited name that is only a PREFIX of a real function does not count as defined.
    expect(ler('./criacaoIncerta.ts')).not.toMatch(/^(?:export )?function atestacaoConfer\(/m);
  });

  /*
   * #2015: the logistics section states the provenance rule. It names the
   * refusal only that rule produces, the stamp, the ONE predicate and the
   * source guard, and its writer table cites functions — so a renamed writer,
   * or a section reverted to "the stored list first", reds here instead of
   * leaving the doc describing a rule the code no longer has.
   *
   * #2099 (CPY-4, #1911 P14b): the section also names the second import
   * remedy, the function that picks between the two, the one that names the
   * channel, and the photo dedup whose scope the web's import recipe states
   * ("a removed photo comes back") — and it no longer says an absent or
   * unreadable value keeps the no-channel refusal's sentence.
   *
   * #1911 P15: the section also states the off rule (a TRUSTED list's
   * `enabled: false`, `desligado-no-vinculo`), the fulfillment-channel rule
   * (`canal-de-fulfillment`), the ONE stored-list reader, the draft edit as the
   * fifth writer and the `canais` route — and its count of `MotivoCanalPulado`
   * members is READ from the union in `logisticaPublicacao.ts`, so a member
   * added there reds here until the doc names it and says the new count. The
   * reader lives in `@delfrance/schemas`, so it is pinned as TEXT only: a
   * cross-workspace read would be a turbo-cache hole.
   */
  const SECAO_LOGISTICA =
    '### Logistics: a stored list is re-sent only when THIS app wrote it, `get_channel_list` otherwise';

  /** The section up to the next `### ` heading, whitespace folded — `''` without its heading. */
  function secaoDeLogistica(texto: string): string {
    const inicio = texto.indexOf(SECAO_LOGISTICA);
    if (inicio < 0) return '';
    const fim = texto.indexOf('\n### ', inicio + SECAO_LOGISTICA.length);
    return emUmaLinha(fim < 0 ? texto.slice(inicio) : texto.slice(inicio, fim));
  }

  /** `[symbol, the file that defines it]` — each one the section cites. */
  const CITADOS_NA_LOGISTICA = [
    ['construirLogistica', './logisticaPublicacao.ts'],
    ['linkListagemLido', './publicarAnuncio.ts'],
    ['dadosDoWriteBack1', './publicarAnuncio.ts'],
    ['escreverWriteBack2', './publicarAnuncio.ts'],
    ['dadosLinkListagem', '../produtos/mapeamento.ts'],
    ['escreverVinculoDoKit', '../kits/vinculosKit.ts'],
    ['remedioPelaImportacao', './logisticaPublicacao.ts'],
    ['canalNomeado', './logisticaPublicacao.ts'],
    ['idsDeImagemJaImportados', '../produtos/fotosShopee.ts'],
    ['avaliarCanaisDaLojaShopee', './logisticaPublicacao.ts'],
    ['canalSelecionavel', './logisticaPublicacao.ts'],
    ['lerCanaisDoRascunhoShopee', './canaisDoRascunho.ts'],
    ['atualizarRascunhoShopee', './rascunho.ts'],
  ] as const;

  it('a seção de logística diz a regra da proveniência (#2015) e só cita funções que existem', () => {
    const secao = secaoDeLogistica(LEIA_ME);
    expect(secao).not.toBe('');
    expect(nomeia(secao, MOTIVO_PUBLICACAO_BLOQUEADA.logisticaNaoConfirmada)).toBe(true);
    expect(nomeia(secao, MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemValorGravado)).toBe(true);
    expect(nomeia(secao, MOTIVO_PUBLICACAO_BLOQUEADA.logisticaSemCanal)).toBe(true);
    expect(nomeia(secao, 'logisticaGravadaEm')).toBe(true);
    expect(nomeia(secao, 'logisticaGravadaPeloErpShopee')).toBe(true);
    expect(nomeia(secao, 'logisticaProveniencia.test.ts')).toBe(true);
    expect(ler('./logisticaProveniencia.test.ts')).toContain("describe('#2015 no código do app'");
    // #1911 P15: the two new skip reasons and the ONE stored-list reader.
    expect(nomeia(secao, 'desligado-no-vinculo')).toBe(true);
    expect(nomeia(secao, 'canal-de-fulfillment')).toBe(true);
    expect(nomeia(secao, 'lerLogisticaArmazenadaShopee')).toBe(true);
    for (const [simbolo, arquivo] of CITADOS_NA_LOGISTICA) {
      expect(nomeia(secao, simbolo), simbolo).toBe(true);
      expect(ler(arquivo), `${simbolo} em ${arquivo}`).toMatch(
        new RegExp(`^(?:export )?(?:async )?function ${simbolo}\\(`, 'm'),
      );
    }
    // The pre-#2015 rule — "the stored list wins whenever one entry survives" — is gone.
    expect(LEIA_ME).not.toContain('### Logistics: the stored list first');
    // …and so is the pre-P14b one: an absent or unreadable value now takes CPY-4.
    expect(secao).not.toContain('an absent or unreadable value');
  });

  it('near-miss: o recorte da logística para no título seguinte, e sem o título não recorta nada', () => {
    const secao = secaoDeLogistica(LEIA_ME);
    // `tax_info`'s section comes right after and is not part of the rule.
    expect(secao).not.toContain('is whole or nothing');
    expect(secaoDeLogistica(LEIA_ME.replace(SECAO_LOGISTICA, '### Logistics'))).toBe('');
    // A heading level deeper (`#### `) does not end the section.
    expect(secaoDeLogistica(`${SECAO_LOGISTICA}\na\n#### b\nc\n### d\n`)).toBe(
      `${SECAO_LOGISTICA} a #### b c`,
    );
  });

  /**
   * The members of `MotivoCanalPulado`, read off the union in
   * `logisticaPublicacao.ts` — one `| '<slug>'` per line, the last one closed
   * by `;`. `[]` when the declaration is missing or never closes, so a renamed
   * type reds the count instead of agreeing with nothing.
   */
  function membrosDoMotivoCanalPulado(fonte: string): string[] {
    const inicio = fonte.indexOf('export type MotivoCanalPulado =');
    if (inicio < 0) return [];
    const membros: string[] = [];
    for (const linha of fonte.slice(inicio).split('\n').slice(1)) {
      const membro = /^\s*\| '([^']+)'(;?)\s*$/.exec(linha);
      if (membro === null) continue;
      membros.push(membro[1] ?? '');
      if (membro[2] === ';') return membros;
    }
    return [];
  }

  /** The count words the README may use, by value. */
  const CONTAGEM_POR_EXTENSO: Readonly<Record<number, string>> = {
    7: 'Seven',
    8: 'Eight',
    9: 'Nine',
    10: 'Ten',
  };

  /** Every "<Word> `MotivoCanalPulado` members" the text states, whitespace folded. */
  function contagensDeMotivosCanal(texto: string): string[] {
    return [...emUmaLinha(texto).matchAll(/\b([A-Z][a-z]+) `MotivoCanalPulado` members/g)].map(
      (m) => m[1] ?? '',
    );
  }

  it('#1911 P15: a seção nomeia CADA membro de MotivoCanalPulado e a contagem é a do tipo — lida do código', () => {
    const membros = membrosDoMotivoCanalPulado(ler('./logisticaPublicacao.ts'));
    // ÂNCORA: the parser found the union, with P15's two members in it.
    expect(membros.length).toBeGreaterThanOrEqual(9);
    expect(membros).toContain('canal-de-fulfillment');
    expect(membros).toContain('desligado-no-vinculo');
    const secao = secaoDeLogistica(LEIA_ME);
    expect(membros.filter((m) => !nomeia(secao, m))).toEqual([]);
    const palavra = CONTAGEM_POR_EXTENSO[membros.length];
    expect(palavra, `contagem ${String(membros.length)} sem palavra na tabela`).toBeDefined();
    // ONE statement in the whole README, and it is the type's count.
    expect(contagensDeMotivosCanal(LEIA_ME)).toEqual([palavra]);
  });

  it("⛔ QUASE: 'Seven `MotivoCanalPulado`' e 'only the four writers' não sobrevivem; a contagem um a menos é outra", () => {
    const secao = secaoDeLogistica(LEIA_ME);
    expect(secao).not.toContain('Seven `MotivoCanalPulado`');
    expect(secao).not.toContain('only the four writers');
    expect(secao).toContain('only the five writers');
    const total = membrosDoMotivoCanalPulado(ler('./logisticaPublicacao.ts')).length;
    const umAMenos = CONTAGEM_POR_EXTENSO[total - 1] ?? '';
    // Re-wrapped across a line, still read; one short of the type, still distinct.
    const quebrada = `${umAMenos}\n\`MotivoCanalPulado\` members`;
    expect(contagensDeMotivosCanal(quebrada)).toEqual([umAMenos]);
    expect(contagensDeMotivosCanal(quebrada)).not.toEqual([CONTAGEM_POR_EXTENSO[total]]);
    // The parser stops at the union's closing `;` — a comment holding one
    // does not end it, and the next type's members are never counted.
    const fonte =
      "export type MotivoCanalPulado =\n  | 'a'\n  /** x; y */\n  | 'b';\n" +
      "export type Outro =\n  | 'c';\n";
    expect(membrosDoMotivoCanalPulado(fonte)).toEqual(['a', 'b']);
    expect(membrosDoMotivoCanalPulado("export type MotivoCanalPulado =\n  | 'a'\n")).toEqual([]);
  });

  /**
   * The members the COUNTING sentence — «<Word> `MotivoCanalPulado` members —
   * … — all producible», whitespace folded — does not name. `null` when the
   * sentence or its «— all producible» end is missing, so a reworded sentence
   * reds instead of agreeing with nothing. Read off the sentence alone: the
   * section also holds the `canais` route's motivo → `indisponivel` map, which
   * names every member again, so the section-wide check above stays green
   * when the sentence loses one.
   */
  function membrosForaDaFraseDaContagem(
    secao: string,
    palavra: string,
    membros: readonly string[],
  ): string[] | null {
    if (palavra === '') return null;
    const inicio = secao.indexOf(`${palavra} \`MotivoCanalPulado\` members —`);
    if (inicio < 0) return null;
    const fim = secao.indexOf('— all producible', inicio);
    if (fim < 0) return null;
    const frase = secao.slice(inicio, fim);
    return membros.filter((m) => !nomeia(frase, m));
  }

  it('⛔ QUASE: a FRASE da contagem lista CADA membro — um membro nomeado só no mapa da rota canais não conta', () => {
    const membros = membrosDoMotivoCanalPulado(ler('./logisticaPublicacao.ts'));
    const palavra = CONTAGEM_POR_EXTENSO[membros.length] ?? '';
    // ÂNCORA: the counting sentence is found, its list ends at «— all
    // producible», and it names every member of the union.
    expect(membrosForaDaFraseDaContagem(secaoDeLogistica(LEIA_ME), palavra, membros)).toEqual([]);
    // The near-miss: `b` is named only in a `#### The \`canais\` route` bullet.
    // The section-wide read finds it; the sentence's read reports it missing.
    const secao = emUmaLinha(
      'Two `MotivoCanalPulado` members — `a` — all\nproducible.\n' +
        '#### The `canais` route (#1911 P15)\n- `b` ⇒ `nao-cabe`\n',
    );
    expect(['a', 'b'].filter((m) => !nomeia(secao, m))).toEqual([]);
    expect(membrosForaDaFraseDaContagem(secao, 'Two', ['a', 'b'])).toEqual(['b']);
    // A sentence without its «— all producible» end, or a count with no word, is not read.
    expect(
      membrosForaDaFraseDaContagem('Two `MotivoCanalPulado` members — `a`, `b`.', 'Two', [
        'a',
        'b',
      ]),
    ).toBeNull();
    expect(membrosForaDaFraseDaContagem(secao, '', ['a', 'b'])).toBeNull();
  });
});
