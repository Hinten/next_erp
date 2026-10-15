/**
 * Captures C5 (the order detail, `GET /v1/pedido/{numero}/`) and the owner's
 * situação-history captures (`GET /v1/situacao_historico/search/`), read
 * through the order import's OWN wire schemas (master-plan step 5, PR 5-a):
 * `liPedidoSchema`, and the history page as `listarHistoricoSituacaoLi` decodes
 * it.
 *
 * The package's schema tests run on an invented copy of the captured shape;
 * this file is what keeps the schemas confirmed against the real corpus:
 *
 *  - every capture parses, and each one answers the numero it was asked for
 *    (the detail by its path, every history row by the `numero` filter);
 *  - an empty string `''` put at ANY leaf of a captured body (one leaf at a
 *    time, every key at every depth, undeclared ones included) is refused only
 *    on the required set, at its own path, and every other leaf reads it as
 *    `null` or keeps it as `''`. So a leaf added to the schema with an idiom
 *    that refuses the provider's "nothing" fails here by construction, as long
 *    as a capture carries it.
 *
 * ⚠️ Every assertion is a boolean, a count or a set of KEY paths, labelled with
 * the fixture name, so a failure never prints a body value (the
 * `wireCorpus.test.ts` convention), and a Zod error is never printed: it can
 * quote the value it refused. Fixtures are read only through the corpus loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMINHO_HISTORICO_SITUACAO_LI,
  liEnvelopeSchema,
  liPedidoSchema,
  liSituacaoHistoricoLinhaSchema,
} from '@delfrance/integrations-loja-integrada';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
} from '../fixtures/wireCorpus';

/** Every order-detail capture in the corpus (the 404 one is not a body). */
const PEDIDOS = [
  'pedido-aguardando.json',
  'pedido-boleto.json',
  'pedido-cancelado.json',
  'pedido-cartao.json',
  'pedido-pix.json',
] as const;

/** Every situação-history capture in the corpus. */
const HISTORICOS = ['historico-pedido-cancelado.json', 'historico-pedido-enviado.json'] as const;

/**
 * The history rows across {@link HISTORICOS}: the observed count, so a row that
 * disappears fails here instead of silently shrinking what the sweep covers.
 */
const MINIMO_DE_LINHAS_DE_HISTORICO = 5;

/**
 * Where `''` must still be refused in an order body, with a list entry written
 * `*`: the required set, and an entry of a list (an object, never "nothing").
 */
const ESTRITOS_PEDIDO = new Set([
  'numero',
  'situacao',
  'itens',
  'itens.*',
  'envios',
  'envios.*',
  'pagamentos',
  'pagamentos.*',
]);

/** Where `''` must still be refused in a history row: its required set. */
const ESTRITOS_LINHA = new Set(['id', 'numero', 'situacao']);

/** The history page exactly as the listing decodes it (`paginarLi`). */
const paginaDoHistorico = liEnvelopeSchema(liSituacaoHistoricoLinhaSchema);

/** The body's rows as they are on disk, before any schema touched them. */
const corpoBruto = z.object({ objects: z.array(z.unknown()) }).passthrough();

type Caminho = readonly (string | number)[];

/** A capture, through the corpus loader. */
function captura(nome: string): EnvelopeFixtureLi {
  if (!listarArquivosDoCorpusLi().includes(nome)) {
    throw new Error(`${nome}: missing from the corpus`);
  }
  const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
  // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
  if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
  return leitura.data;
}

/** Every key path of a JSON value: each object key and each list index, at every depth. */
function caminhosDoCorpo(v: unknown, prefixo: Caminho = []): Caminho[] {
  const filhos: [string | number, unknown][] = Array.isArray(v)
    ? v.map((x, i) => [i, x])
    : v !== null && typeof v === 'object'
      ? Object.entries(v)
      : [];
  return filhos.flatMap(([chave, x]) => {
    const caminho = [...prefixo, chave];
    return [caminho, ...caminhosDoCorpo(x, caminho)];
  });
}

/** `corpo` with its leaf at `caminho` set to `valor`, as a deep copy. */
function comFolha(corpo: unknown, caminho: Caminho, valor: unknown): unknown {
  const copia = structuredClone(corpo);
  let alvo = copia as Record<string | number, unknown>;
  for (const seg of caminho.slice(0, -1)) alvo = alvo[seg] as Record<string | number, unknown>;
  alvo[caminho[caminho.length - 1]!] = valor;
  return copia;
}

function folha(corpo: unknown, caminho: Caminho): unknown {
  let v = corpo;
  for (const seg of caminho) v = (v as Record<string | number, unknown>)[seg];
  return v;
}

/** A path with every list index written `*`, so one set covers every entry. */
const nomeDe = (caminho: Caminho): string =>
  caminho.map((s) => (typeof s === 'number' ? '*' : s)).join('.');

/**
 * Puts `''` at every key path of `corpo`, one at a time, and parses. Returns
 * the paths refused (indices as `*`) and every path that broke the contract: a
 * refusal must name only that path, and a parse must read the leaf as `null`
 * (folded) or keep it as `''` (text).
 */
function varrerVazios(schema: z.ZodType, corpo: unknown) {
  const recusados = new Set<string>();
  const problemas = new Set<string>();
  for (const caminho of caminhosDoCorpo(corpo)) {
    const r = schema.safeParse(comFolha(corpo, caminho, ''));
    if (!r.success) {
      recusados.add(nomeDe(caminho));
      const onde = r.error.issues.map((i) => i.path.join('.'));
      if (onde.length !== 1 || onde[0] !== caminho.join('.')) {
        problemas.add(`${nomeDe(caminho)}: refused elsewhere`);
      }
      continue;
    }
    const lido = folha(r.data, caminho);
    if (lido !== null && lido !== '')
      problemas.add(`${nomeDe(caminho)}: read as neither null nor ''`);
  }
  return { recusados, problemas };
}

/** The `numero` a capture's request asked for, from its path or its filter. */
function numeroPedido(e: EnvelopeFixtureLi): string | undefined {
  const doCaminho = /^\/v1\/pedido\/([1-9][0-9]*)\/$/.exec(e.requisicao.caminho)?.[1];
  return doCaminho ?? e.requisicao.query.find(([k]) => k === 'numero')?.[1];
}

describe('capture C5: the order-detail captures', () => {
  it('are all in the corpus, and each is the detail GET, answered 200 with a JSON body', () => {
    for (const nome of PEDIDOS) {
      const e = captura(nome);
      expect(e.requisicao.metodo === 'GET', `${nome} metodo`).toBe(true);
      expect(numeroPedido(e) !== undefined, `${nome} caminho`).toBe(true);
      expect(e.resposta.status === 200 && e.resposta.forma === 'json', `${nome} status`).toBe(true);
    }
  });

  it('every body passes `liPedidoSchema`, and answers the numero its path asked for', () => {
    for (const nome of PEDIDOS) {
      const e = captura(nome);
      const r = liPedidoSchema.safeParse(e.resposta.corpo);
      expect(r.success, `${nome} schema`).toBe(true);
      expect(r.success && String(r.data.numero) === numeroPedido(e), `${nome} numero`).toBe(true);
    }
  });

  it("'' at any leaf is refused only on the required set, at its own path; any other leaf reads null or ''", () => {
    for (const nome of PEDIDOS) {
      const { recusados, problemas } = varrerVazios(liPedidoSchema, captura(nome).resposta.corpo);
      expect([...problemas], `${nome} problemas`).toEqual([]);
      expect(recusados, `${nome} recusados`).toEqual(ESTRITOS_PEDIDO);
    }
  });
});

describe('the situação-history captures', () => {
  it('are all in the corpus, and each is the listing GET filtered by numero, answered 200', () => {
    expect(listarArquivosDoCorpusLi().filter((a) => a.startsWith('historico-'))).toEqual([
      ...HISTORICOS,
    ]);
    for (const nome of HISTORICOS) {
      const e = captura(nome);
      expect(e.requisicao.metodo === 'GET', `${nome} metodo`).toBe(true);
      expect(e.requisicao.caminho === CAMINHO_HISTORICO_SITUACAO_LI, `${nome} caminho`).toBe(true);
      expect(numeroPedido(e) !== undefined, `${nome} filtro`).toBe(true);
      expect(e.resposta.status === 200 && e.resposta.forma === 'json', `${nome} status`).toBe(true);
    }
  });

  it('every page passes the listing’s page schema, and every row is about the numero filtered on', () => {
    let linhas = 0;
    for (const nome of HISTORICOS) {
      const e = captura(nome);
      const r = paginaDoHistorico.safeParse(e.resposta.corpo);
      expect(r.success, `${nome} schema`).toBe(true);
      if (!r.success) continue;
      r.data.objects.forEach((linha, i) => {
        expect(String(linha.numero) === numeroPedido(e), `${nome} objects[${String(i)}]`).toBe(
          true,
        );
      });
      linhas += r.data.objects.length;
    }
    expect(linhas).toBeGreaterThanOrEqual(MINIMO_DE_LINHAS_DE_HISTORICO);
  });

  it("'' at any leaf of a row is refused only on `id`, `numero` and `situacao`, at its own path", () => {
    for (const nome of HISTORICOS) {
      const brutas = corpoBruto.safeParse(captura(nome).resposta.corpo);
      if (!brutas.success) throw new Error(`${nome}: no objects array`);
      brutas.data.objects.forEach((bruta, i) => {
        const rotulo = `${nome} objects[${String(i)}]`;
        const { recusados, problemas } = varrerVazios(liSituacaoHistoricoLinhaSchema, bruta);
        expect([...problemas], `${rotulo} problemas`).toEqual([]);
        expect(recusados, `${rotulo} recusados`).toEqual(ESTRITOS_LINHA);
      });
    }
  });
});
