import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from '../anuncios/errosPublicacao';
import { MENSAGEM_KIT_INCERTO, comandoDeRetomada, type ArmaKit } from './resultadoKit';

const BASE = { integracaoId: 'int-1', produtoId: 'prod-kit', linkDocId: null, principal: null };

describe('MENSAGEM_KIT_INCERTO — a frase do 202 (S1F-03, L10-R2)', () => {
  it('é a frase do seam, byte a byte', () => {
    expect(MENSAGEM_KIT_INCERTO).toBe(
      'a Shopee pode ter criado o kit — aguarde 4 minutos e rode exatamente este comando de novo: ' +
        'se o kit existir, o ERP recusa com «já existe na Shopee — importe-o» e importar:anuncio o ' +
        'liga a este produto; senão, o ERP o cria. Se outra execução tiver vinculado um kit a este ' +
        'produto nesse meio-tempo, o comando não procura mais pelo SKU: um kit duplicado só aparece ' +
        'num próximo --recriar',
    );
  });
});

describe('comandoDeRetomada — a re-execução é LITERALMENTE o mesmo comando', () => {
  it('kit-criar: nenhum --link, mesmo que um tenha sido passado', () => {
    expect(comandoDeRetomada('kit-criar', { ...BASE, linkDocId: 'link-x' })).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit',
    );
  });

  it('kit-recriar: SEMPRE --link <alvo> --recriar (R-a)', () => {
    expect(comandoDeRetomada('kit-recriar', { ...BASE, linkDocId: 'link-velho' })).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit --link link-velho --recriar',
    );
  });

  it('kit-converter: --converter-em-kit, e --link só quando o antecessor foi nomeado', () => {
    expect(comandoDeRetomada('kit-converter', BASE)).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit --converter-em-kit',
    );
    expect(comandoDeRetomada('kit-converter', { ...BASE, linkDocId: 'link-comum' })).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit --converter-em-kit --link link-comum',
    );
  });

  it('kit-atualizar: o --link nomeado volta; sem nome, nenhum', () => {
    expect(comandoDeRetomada('kit-atualizar', BASE)).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit',
    );
    expect(comandoDeRetomada('kit-atualizar', { ...BASE, linkDocId: 'link-kit' })).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit --link link-kit',
    );
  });

  it('--principal quando enviado, e os extras da CLI por último, na ordem dada', () => {
    expect(
      comandoDeRetomada('kit-recriar', {
        ...BASE,
        linkDocId: 'link-velho',
        principal: 'prod-comp-a',
        extras: ['--live', '--json'],
      }),
    ).toBe(
      'publicar:anuncio --integracao int-1 --produto prod-kit --link link-velho --recriar ' +
        '--principal prod-comp-a --live --json',
    );
  });

  it('⛔ QUASE-PAR (M176): os quatro braços dão quatro comandos distintos para a mesma entrada', () => {
    const armas: readonly ArmaKit[] = [
      'kit-criar',
      'kit-atualizar',
      'kit-recriar',
      'kit-converter',
    ];
    const comandos = armas.map((arma) => comandoDeRetomada(arma, { ...BASE, linkDocId: 'link-x' }));
    expect(new Set(comandos).size).toBe(4);
    expect(comandos.filter((c) => c.includes('--recriar'))).toHaveLength(1);
    expect(comandos.filter((c) => c.includes('--converter-em-kit'))).toHaveLength(1);
  });
});

describe('o módulo de TIPOS não produz recusa nenhuma', () => {
  it('nenhum slug bloqueado aparece entre aspas em resultadoKit.ts (O7 o lê)', () => {
    // O7 conta uma grafia entre aspas em `kits/` como PRODUTOR; um tipo aqui que
    // soletrasse um slug manteria "produzido" um membro cujo produtor sumiu.
    const fonte = readFileSync(new URL('./resultadoKit.ts', import.meta.url), 'utf8');
    const aspas = Object.values(MOTIVO_PUBLICACAO_BLOQUEADA).filter(
      (slug) => fonte.includes(`'${slug}'`) || fonte.includes(`"${slug}"`),
    );
    expect(aspas).toEqual([]);
  });
});
