/**
 * The pure half of `reverificar:anuncio` (#1527, step 19) — the
 * `publicarAnuncioCli.test.ts` shape.
 *
 *  - §1 the parser: the two required flags, `--link`, the shared doc-id rule,
 *    `--help` first, and the two REFUSED mode flags (this command has none);
 *  - §2 the summary is an ALLOW-LIST: the violation rows carry provider prose and
 *    reach neither the rendered lines nor the `--json` document — with a
 *    field-count pin, so a new field has to be looked at;
 *  - §3 the exit code mirrors the route (404/409 ⇒ 1, any reading ⇒ 0);
 *  - §4 the script: `--help` before the first dynamic import, the re-verify called
 *    once, the package.json script spelled exactly, no `--` in the usage;
 *  - §5 a throw is described by CLASS plus Shopee's `code`, never a payload.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, shopeeViolacaoSchema } from '@delfrance/schemas';

import type { ResultadoReverificacao } from './reverificarAnuncio';
import {
  ArgumentoInvalidoError,
  MSG_SEM_MODO,
  USO_REVERIFICAR_ANUNCIO,
  codigoDeSaida,
  descreverErroReverificacao,
  lerArgsReverificar,
  renderizarReverificacao,
  resumoDaReverificacao,
} from './reverificarAnuncioCli';

const FONTE_CLI = readFileSync(new URL('./reverificarAnuncioCli.ts', import.meta.url), 'utf8');
const FONTE_SCRIPT = readFileSync(
  new URL('../../../scripts/reverificar-anuncio.ts', import.meta.url),
  'utf8',
);
const PACOTE = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

const ITEM_KIT = 2500139870;
/** Recognisable stand-ins for the provider PROSE that must never be printed. */
const PROSA_RAZAO = 'PROSA-RAZAO: o titulo deste anuncio copia o de outra loja';
const PROSA_SUGESTAO = 'PROSA-SUGESTAO: mova o anuncio para a categoria sugerida';

function resultado(over: Partial<ResultadoReverificacao> = {}): ResultadoReverificacao {
  return {
    acao: 'atualizado',
    produtoId: 'prod-1',
    linkDocId: 'link-1',
    itemId: ITEM_KIT,
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    itemStatus: 'SELLER_DELETE',
    deboost: false,
    violacoes: [
      shopeeViolacaoSchema.parse({
        violation_type: 'Spam',
        violation_reason: PROSA_RAZAO,
        suggestion: PROSA_SUGESTAO,
        fix_deadline_time: null,
        update_time: null,
        kind: 'status',
      }),
    ],
    violacoesLidas: true,
    modelos: { total: 2, atualizados: 1, ausentes: 0 },
    avisoResolvido: false,
    avisoReceitaKit: 'nada',
    chamadasShopee: 3,
    ...over,
  };
}

/* ========================================================================== */
/*  1 · o parser                                                              */
/* ========================================================================== */

describe('lerArgsReverificar', () => {
  it('lê as duas obrigatórias, sem link por padrão', () => {
    expect(lerArgsReverificar(['--integracao', 'int-1', '--produto', 'prod-1'])).toEqual({
      kind: 'reverificar',
      args: {
        integracaoId: 'int-1',
        produtoId: 'prod-1',
        linkDocId: null,
        json: false,
        projectId: null,
      },
    });
  });

  it('lê todas as opções, nas duas grafias (espaço e "=")', () => {
    expect(
      lerArgsReverificar([
        '--integracao=int-1',
        '--produto',
        'prod-1',
        '--link=link-antigo',
        '--project',
        'demo-erp',
        '--json',
      ]),
    ).toEqual({
      kind: 'reverificar',
      args: {
        integracaoId: 'int-1',
        produtoId: 'prod-1',
        linkDocId: 'link-antigo',
        json: true,
        projectId: 'demo-erp',
      },
    });
  });

  it('--help responde ANTES de qualquer validação, e -h também', () => {
    expect(lerArgsReverificar(['--help'])).toEqual({ kind: 'ajuda' });
    expect(lerArgsReverificar(['--live', '-h'])).toEqual({ kind: 'ajuda' });
  });

  it('⚠️ --dry-run e --live são RECUSADOS com a frase — este comando não tem modos', () => {
    for (const flag of ['--dry-run', '--live']) {
      expect(() =>
        lerArgsReverificar(['--integracao', 'int-1', '--produto', 'prod-1', flag]),
      ).toThrow(MSG_SEM_MODO);
    }
  });

  it('as obrigatórias faltando, uma opção desconhecida e o separador "--" são recusados', () => {
    expect(() => lerArgsReverificar(['--produto', 'prod-1'])).toThrow(ArgumentoInvalidoError);
    expect(() => lerArgsReverificar(['--integracao', 'int-1'])).toThrow(/--produto/);
    expect(() =>
      lerArgsReverificar(['--integracao', 'int-1', '--produto', 'prod-1', '--item', '1']),
    ).toThrow(/desconhecida/);
    expect(() =>
      lerArgsReverificar(['--', '--integracao', 'int-1', '--produto', 'prod-1']),
    ).toThrow(/Separador/);
    expect(() => lerArgsReverificar(['--integracao', '--produto', 'prod-1'])).toThrow(
      /exige um valor/,
    );
  });

  it('⚠️ PAR/NEAR-MISS da regra de doc id: "a/b", "." e ".." recusados; pontos no meio aceitos', () => {
    for (const ruim of ['a/b', '.', '..']) {
      expect(() =>
        lerArgsReverificar(['--integracao', 'int-1', '--produto', 'prod-1', '--link', ruim]),
      ).toThrow(/não é um id de documento/);
    }
    const ok = lerArgsReverificar(['--integracao', 'int-1', '--produto', 'p.1', '--link', 'l.2']);
    expect(ok.kind === 'reverificar' && ok.args.linkDocId).toBe('l.2');
  });

  it('⛔ a regra de doc id é IMPORTADA (naoDocId), e este módulo não declara uma segunda', () => {
    expect(FONTE_CLI).toContain("import { naoDocId } from './corpoPublicacao'");
    expect(FONTE_CLI).not.toMatch(/function\s+naoDocId/);
  });
});

/* ========================================================================== */
/*  2 · a redação é uma ALLOW-LIST                                            */
/* ========================================================================== */

describe('resumoDaReverificacao / renderizarReverificacao', () => {
  it('o resumo tem um conjunto de campos FIXO — um campo novo tem de ser olhado', () => {
    expect(Object.keys(resumoDaReverificacao(resultado())).sort()).toEqual(
      [
        'acao',
        'avisoReceitaKit',
        'avisoResolvido',
        'chamadasShopee',
        'deboost',
        'estadoAnuncio',
        'itemId',
        'itemStatus',
        'linkDocId',
        'modelos',
        'produtoId',
        'violacoes',
        'violacoesLidas',
      ].sort(),
    );
  });

  it('⛔ a prosa das violações não chega nem às linhas nem ao --json — só a CONTAGEM', () => {
    const r = resultado();
    // ÂNCORA: a prosa REALMENTE está no resultado — a ausência abaixo não é vazia.
    expect(JSON.stringify(r)).toContain('PROSA-RAZAO');

    const texto = renderizarReverificacao(r).join('\n');
    const json = JSON.stringify(resumoDaReverificacao(r));
    for (const saida of [texto, json]) {
      expect(saida).not.toContain('PROSA-RAZAO');
      expect(saida).not.toContain('PROSA-SUGESTAO');
    }
    expect(resumoDaReverificacao(r).violacoes).toBe(1);
    expect(JSON.parse(json)).toEqual(resumoDaReverificacao(r));
  });

  it('um anúncio REMOVIDO ganha a linha que diz o que muda para os passos 12/13', () => {
    const texto = renderizarReverificacao(resultado()).join('\n');
    expect(texto).toContain('REMOVIDO na Shopee');
    expect(texto).toContain('anuncio-removido');

    const vivo = renderizarReverificacao(
      resultado({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, itemStatus: 'NORMAL' }),
    ).join('\n');
    expect(vivo).not.toContain('REMOVIDO na Shopee');
  });

  it('as quatro leituras do aviso de receita saem cada uma com a sua frase', () => {
    const frase = (d: ResultadoReverificacao['avisoReceitaKit']): string =>
      renderizarReverificacao(resultado({ avisoReceitaKit: d })).find((l) =>
        l.includes('aviso de receita'),
      ) ?? '';
    expect(frase(null)).toContain('não se aplica');
    expect(frase('nada')).toContain('sem-kit-ativo');
    expect(frase('resolvido')).toContain('receita do ERP');
    expect(frase('aberto')).toContain('ABERTO');
  });

  it('item_status nulo (nada foi lido, o braço not-found) é dito, nunca impresso como vazio', () => {
    const linhas = renderizarReverificacao(resultado({ itemStatus: null, modelos: null }));
    expect(linhas.find((l) => l.includes('item_status'))).toContain('nada foi lido');
    expect(linhas.find((l) => l.includes('modelos'))).toContain('sem perna de modelos');
  });
});

/* ========================================================================== */
/*  3 · o código de saída espelha a rota                                      */
/* ========================================================================== */

describe('codigoDeSaida', () => {
  it('sem vínculo (o 404) e nunca publicado (o 409) ⇒ 1; qualquer leitura ⇒ 0, removido incluído', () => {
    expect(codigoDeSaida(null)).toBe(1);
    expect(codigoDeSaida(resultado({ acao: 'ignorado-sem-item-id', itemId: null }))).toBe(1);
    expect(codigoDeSaida(resultado({ acao: 'removido' }))).toBe(0);
    expect(codigoDeSaida(resultado({ acao: 'atualizado' }))).toBe(0);
    expect(codigoDeSaida(resultado({ acao: 'ignorado-sem-mudanca' }))).toBe(0);
  });
});

/* ========================================================================== */
/*  4 · o script e o package.json                                             */
/* ========================================================================== */

describe('scripts/reverificar-anuncio.ts', () => {
  it('devolve na ajuda ANTES do primeiro await import', () => {
    const ajuda = FONTE_SCRIPT.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = FONTE_SCRIPT.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('chama a reverificação REAL, uma vez, e não declara lógica própria', () => {
    expect(FONTE_SCRIPT.match(/await reverificarAnuncioShopee\(/g)).toHaveLength(1);
    // ONE clock read, handed down — exactly as the route.
    expect(FONTE_SCRIPT.match(/Date\.now\(\)/g)).toHaveLength(1);
    // No second writer: the script names no collection handle.
    expect(FONTE_SCRIPT).not.toMatch(/Collection\b/);
  });

  it('o package.json ganha EXATAMENTE um script, com a string exata', () => {
    const pacote = JSON.parse(PACOTE) as { scripts: Record<string, string> };
    expect(pacote.scripts['reverificar:anuncio']).toBe(
      'dotenv -e ../../.env.local -- tsx scripts/reverificar-anuncio.ts',
    );
    expect(
      Object.values(pacote.scripts).filter((v) => v.includes('scripts/reverificar-anuncio.ts')),
    ).toHaveLength(1);
  });

  it('o texto de uso NÃO documenta o separador "--" e não carrega id real', () => {
    expect(USO_REVERIFICAR_ANUNCIO).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_REVERIFICAR_ANUNCIO).not.toMatch(/pnpm .*[^ ] -- +\\/);
    expect(USO_REVERIFICAR_ANUNCIO).toContain('reverificar:anuncio');
    expect(USO_REVERIFICAR_ANUNCIO).toContain('--link <docId>');
    expect(USO_REVERIFICAR_ANUNCIO).toContain('int-1');
    expect(USO_REVERIFICAR_ANUNCIO).not.toMatch(/partner_key|shop_id|token|secret/i);
    // ⚠️ The same spellings in the script's own docblock.
    expect(FONTE_SCRIPT).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(FONTE_SCRIPT).not.toMatch(/pnpm .*[^ ] -- +\\/);
  });
});

/* ========================================================================== */
/*  5 · o caminho do exit 1: classe + code, nunca payload                     */
/* ========================================================================== */

describe('descreverErroReverificacao', () => {
  it('um argumento inválido imprime a ajuda DESTE comando, não a de outro', () => {
    const linhas = descreverErroReverificacao(new ArgumentoInvalidoError('--produto falta'));
    expect(linhas[0]).toBe('❌ --produto falta');
    expect(linhas.at(-1)).toBe(USO_REVERIFICAR_ANUNCIO);
  });

  it('um erro da Shopee sai por CLASSE + code/path, sem corpo nenhum', () => {
    const err = new ShopeeApiError('Shopee respondeu error_auth (HTTP 403)', {
      code: 'error_auth',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 403,
      path: '/api/v2/product/get_item_base_info',
    });
    const linhas = descreverErroReverificacao(err).join('\n');
    expect(linhas).toContain('ShopeeApiError');
    expect(linhas).toContain('code=error_auth');
    expect(linhas).toContain('path=/api/v2/product/get_item_base_info');
  });
});
