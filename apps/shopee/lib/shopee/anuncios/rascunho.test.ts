/**
 * The draft route's decisions (#1911, P4) over the shared FakeDb, whose
 * `create` answers `ALREADY_EXISTS`, whose `update(…, {lastUpdateTime})` and
 * — since this PR — `delete({lastUpdateTime})` throw `FAILED_PRECONDITION` on a
 * stale stamp: every write here can LOSE, and the tests make it lose.
 *
 * The bodies go through the REAL route schemas (`corpo*RascunhoShopeeSchema`),
 * so every value reaching the module is the normalised one the route hands
 * over. `rascunho.firestore.test.ts` repeats the four engine-shaped facts
 * (the real `ALREADY_EXISTS`, the real stale update and delete) against the
 * emulator, so this double is never the only witness.
 *
 * Fixture ids only: conta `int-1`, invented produto / link ids, Shopee's own
 * doc-sample item ids.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeError } from '@delfrance/integrations-shopee';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  camposDoRascunhoShopee,
  conflitoRascunhoShopeeSchema,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
  respostaAtualizarRascunhoShopeeSchema,
  respostaCriarRascunhoShopeeSchema,
  respostaDescartarRascunhoShopeeSchema,
  vinculoConflitanteShopeeSchema,
} from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '../core/shopee';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  RecusaDeRascunhoShopeeError,
  TENTATIVAS_DO_RASCUNHO,
  atualizarRascunhoShopee,
  corpoDaRecusaDeRascunhoShopee,
  criarRascunhoShopee,
  descartarRascunhoShopee,
  type DepsDoRascunhoShopee,
} from './rascunho';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const OUTRA_CONTA = 'int-12';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const PRODUTO = 'prod-pai';
const OUTRO_PRODUTO = 'prod-outro';
/** Firestore's auto-id shape — 20 letters or digits. */
const RASCUNHO = 'Rascunho0000000000A1';
const IRMAO = 'Rascunho0000000000B2';
const VIVO = 'link-vivo';
const COLECAO = `produtos/${PRODUTO}/prodshopee`;
const CAMINHO = `${COLECAO}/${RASCUNHO}`;
const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
const CAMINHO_CONTA = `integracao/${INTEGRACAO}`;
const ITEM_VIVO = 2500139861;

const AGORA = 1_757_000_000_000;

/**
 * Attributes in the REQUEST shape — what the draft route writes (D9) and what
 * the projection reads back: a value of the category's list (its id, no name)
 * and a CUSTOM one (`value_id: 0` + name, here with a unit). Invented ids.
 */
const ATRIBUTOS = [
  { attribute_id: 100_001, attribute_value_list: [{ value_id: 55 }] },
  {
    attribute_id: 100_002,
    attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão', value_unit: 'cm' }],
  },
];
/** Another operator's attribute save — a different value of the same attribute. */
const ATRIBUTOS_DE_OUTRA_ABA = [
  { attribute_id: 100_001, attribute_value_list: [{ value_id: 56 }] },
];
/** The attributes of the NEW category, chosen in the same patch as the category. */
const ATRIBUTOS_DA_NOVA_CATEGORIA = [
  { attribute_id: 200_001, attribute_value_list: [{ value_id: 7 }] },
];

function rascunho(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: null,
    item_name: 'Camiseta do rascunho',
    description: null,
    category_id: 100_017,
    brand_id: 0,
    original_brand_name: null,
    attributes: null,
    ...extra,
  };
}

function produto(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { nome: 'Camiseta Básica', paiId: null, ehKit: false, ehKitVirtual: false, ...extra };
}

function conta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: 987654,
    ...extra,
  };
}

/** A db holding the conta and the produto — the create's preconditions. */
function base(): FakeDb {
  const db = new FakeDb();
  db.seed(CAMINHO_CONTA, conta());
  db.seed(CAMINHO_PRODUTO, produto());
  return db;
}

function travaAlheia(expiraEm: number) {
  return {
    desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
    expiraEm,
    token: 'token-de-outra-execucao',
  };
}

function deps(db: FakeDb, over: Partial<DepsDoRascunhoShopee> = {}): DepsDoRascunhoShopee {
  return { db: asDb(db), nowMs: AGORA, ...over };
}

function corpoCriar(o: Record<string, unknown> = {}) {
  return corpoCriarRascunhoShopeeSchema.parse({
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    linkDocId: RASCUNHO,
    ...o,
  });
}

function corpoAtualizar(
  baseVista: Record<string, unknown>,
  patch: Record<string, unknown>,
  o: Record<string, unknown> = {},
) {
  return corpoAtualizarRascunhoShopeeSchema.parse({
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    linkDocId: RASCUNHO,
    base: baseVista,
    patch,
    ...o,
  });
}

function corpoDescartar(baseVista: Record<string, unknown>, o: Record<string, unknown> = {}) {
  return corpoDescartarRascunhoShopeeSchema.parse({
    integracaoId: INTEGRACAO,
    produtoId: PRODUTO,
    linkDocId: RASCUNHO,
    base: baseVista,
    ...o,
  });
}

/** What the produto's Shopee tab would send as `base`: THE projection of what is stored. */
function vista(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...camposDoRascunhoShopee(raw) };
}

function doc(db: FakeDb, caminho = CAMINHO): Record<string, unknown> | undefined {
  return db.store[caminho]?.data;
}

function escritasEm(db: FakeDb, caminho = CAMINHO): Record<string, unknown>[] {
  return db.writes.filter((w) => w.path === caminho).map((w) => w.patch);
}

async function recusaDe(p: Promise<unknown>): Promise<RecusaDeRascunhoShopeeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof RecusaDeRascunhoShopeeError)) {
    throw new Error(`esperava RecusaDeRascunhoShopeeError, veio ${String(err)}`);
  }
  return err;
}

/**
 * A db whose `get` of `alvo` lets a CONCURRENT writer land right after it — on
 * the first read only, or on every read (`sempre`). The double's own refs,
 * wrapped; never a raw Firestore ref. (`reservaRascunho.test.ts`'s shape.)
 */
function comEscritaConcorrente(
  db: FakeDb,
  alvo: string,
  escrever: (leitura: number) => void,
  sempre = false,
): FakeDb {
  let leituras = 0;
  const colecao = db.collection.bind(db);
  return new Proxy(db, {
    get(t, prop, r) {
      if (prop !== 'collection') return Reflect.get(t, prop, r) as unknown;
      return (colPath: string) => {
        const col = colecao(colPath);
        return new Proxy(col, {
          get(ct, cp, cr) {
            const original = Reflect.get(ct, cp, cr) as unknown;
            if (cp !== 'doc') return original;
            const construirRef = original as typeof ct.doc;
            return (id?: string) => {
              const ref = construirRef(id);
              if (ref.path !== alvo) return ref;
              return {
                ...ref,
                get: async () => {
                  const snap = await ref.get();
                  leituras += 1;
                  if (sempre || leituras === 1) escrever(leituras);
                  return snap;
                },
              };
            };
          },
        });
      };
    },
  });
}

let avisos: unknown[][];

beforeEach(() => {
  __resetAllReadCaches();
  avisos = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                            1 · criarRascunhoShopee                          */
/* -------------------------------------------------------------------------- */

describe('criarRascunhoShopee — create() no id do cliente (nível 0)', () => {
  it('cria o rascunho INTEIRO: ref canônica da conta, item_id null, conteúdo, AS DUAS chaves da marca, dataCadastro = ultimaModificacao = nowMs', async () => {
    const db = base();

    const r = await criarRascunhoShopee(
      deps(db),
      corpoCriar({
        conteudo: {
          item_name: 'Camiseta Azul ',
          description: 'Algodão',
          category_id: 100_017,
          marca: { brand_id: 77, original_brand_name: 'Marca X' },
        },
      }),
    );

    expect(respostaCriarRascunhoShopeeSchema.parse(r)).toEqual({
      linkDocId: RASCUNHO,
      criado: true,
    });
    const salvo = doc(db);
    expect(salvo).toMatchObject({
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: null,
      // VERBATIM — the trailing space is the operator's, never trimmed here.
      item_name: 'Camiseta Azul ',
      description: 'Algodão',
      category_id: 100_017,
      brand_id: 77,
      original_brand_name: 'Marca X',
      dataCadastro: AGORA,
      ultimaModificacao: AGORA,
    });
    // Never a lock, never an uncertainty record: a new draft is `livre`.
    expect(salvo).not.toHaveProperty('publicacaoEmCurso');
    expect(salvo).not.toHaveProperty('criacaoIncertaDesde');
    // ONE write, the create.
    expect(escritasEm(db)).toHaveLength(1);
    // The projection reads back exactly what was asked — no attributes named,
    // none stored (P6: `attributes: null`, never absent).
    expect(salvo?.attributes).toBeNull();
    expect(camposDoRascunhoShopee(salvo ?? {})).toEqual({
      item_name: 'Camiseta Azul ',
      description: 'Algodão',
      category_id: 100_017,
      marca: { brand_id: 77, original_brand_name: 'Marca X' },
      attributes: null,
    });
  });

  it('sem conteudo: item_name = o nome do produto VERBATIM; descrição, categoria e marca null — e as DUAS chaves da marca existem', async () => {
    const db = base();
    db.seed(CAMINHO_PRODUTO, produto({ nome: '  Camiseta Básica ' }));

    await criarRascunhoShopee(deps(db), corpoCriar());

    const salvo = doc(db) ?? {};
    expect(salvo.item_name).toBe('  Camiseta Básica ');
    expect(salvo.description).toBeNull();
    expect(salvo.category_id).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(salvo, 'brand_id')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(salvo, 'original_brand_name')).toBe(true);
    expect(salvo.brand_id).toBeNull();
    expect(salvo.original_brand_name).toBeNull();
  });

  it('marca "Sem marca" (brand_id 0) grava o nome null; marca null grava as duas chaves null', async () => {
    const db = base();
    await criarRascunhoShopee(
      deps(db),
      corpoCriar({ conteudo: { marca: { brand_id: 0, original_brand_name: 'No Brand' } } }),
    );
    expect(doc(db)).toMatchObject({ brand_id: 0, original_brand_name: null });

    const db2 = base();
    await criarRascunhoShopee(deps(db2), corpoCriar({ conteudo: { marca: null } }));
    expect(doc(db2)).toMatchObject({ brand_id: null, original_brand_name: null });
  });

  describe('os atributos na criação (P6, D9)', () => {
    it('grava a FORMA DE REQUISIÇÃO que o corpo normalizou (nome aparado, unidade em branco omitida) — e a projeção a lê de volta IGUAL', async () => {
      const db = base();
      await criarRascunhoShopee(
        deps(db),
        corpoCriar({
          conteudo: {
            attributes: [
              { attribute_id: 100_001, attribute_value_list: [{ value_id: 55, value_unit: '  ' }] },
              {
                attribute_id: 100_002,
                attribute_value_list: [
                  { value_id: 0, original_value_name: ' Algodão ', value_unit: 'cm' },
                ],
              },
            ],
          },
        }),
      );

      const salvo = doc(db) ?? {};
      // STRICT: no `value_unit: undefined` key rides into the stored value.
      expect(salvo.attributes).toStrictEqual(ATRIBUTOS);
      expect(camposDoRascunhoShopee(salvo).attributes).toEqual(ATRIBUTOS);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('⛔ quase-par: o formato de LEITURA da importação (nome ao lado de um value_id ≠ 0) ou o valor legado sem value_id NÃO é uma escrita ⇒ 400 no corpo, nada gravado', async () => {
      for (const attributes of [
        [
          {
            attribute_id: 100_001,
            attribute_value_list: [{ value_id: 55, original_value_name: 'Azul' }],
          },
        ],
        [{ attribute_id: 100_002, attribute_value_list: [{ original_value_name: 'Algodão' }] }],
        [{ attribute_id: 100_001, attribute_value_list: [{ value_id: '55' }] }],
        [{ attribute_id: 100_001, attribute_value_list: [] }],
      ]) {
        expect(() => corpoCriar({ conteudo: { attributes } }), JSON.stringify(attributes)).toThrow(
          ZodError,
        );
      }
    });

    it('a repetição com os MESMOS atributos (antes de normalizar) ⇒ 200 criado:false; ⛔ quase-par: outro valor ou outra ORDEM ⇒ 409 CONFLITO com o gravado', async () => {
      const db = base();
      await criarRascunhoShopee(deps(db), corpoCriar({ conteudo: { attributes: ATRIBUTOS } }));
      const antes = structuredClone(doc(db));

      const mesmo = await criarRascunhoShopee(
        deps(db),
        corpoCriar({
          conteudo: {
            attributes: [
              ATRIBUTOS[0],
              {
                attribute_id: 100_002,
                attribute_value_list: [
                  { value_unit: 'cm', original_value_name: 'Algodão  ', value_id: 0 },
                ],
              },
            ],
          },
        }),
      );
      expect(mesmo).toEqual({ linkDocId: RASCUNHO, criado: false });

      for (const attributes of [ATRIBUTOS_DE_OUTRA_ABA, [ATRIBUTOS[1], ATRIBUTOS[0]], null]) {
        const err = await recusaDe(
          criarRascunhoShopee(deps(db), corpoCriar({ conteudo: { attributes } })),
        );
        expect(err.code, JSON.stringify(attributes)).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos).toEqual([
          { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: ATRIBUTOS },
        ]);
      }
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });
  });

  it('o produto sem nome utilizável e nenhum item_name ⇒ 400 (code null), zero escritas — ⛔ quase-par: com item_name cria', async () => {
    for (const nome of ['', '   ', null, undefined, 42]) {
      const db = base();
      db.seed(CAMINHO_PRODUTO, produto({ nome }));
      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));
      expect(err.status, String(nome)).toBe(400);
      expect(err.code).toBeNull();
      expect(corpoDaRecusaDeRascunhoShopee(err)).not.toHaveProperty('code');
      expect(db.writes).toEqual([]);

      const r = await criarRascunhoShopee(
        deps(db),
        corpoCriar({ conteudo: { item_name: 'Título do operador' } }),
      );
      expect(r.criado).toBe(true);
      expect(doc(db)?.item_name).toBe('Título do operador');
    }
  });

  describe('a repetição no MESMO id (K1-9)', () => {
    it('um clique duplo: a segunda chamada responde 200 criado:false e NÃO escreve — uma escrita só', async () => {
      const db = base();
      const corpo = corpoCriar({ conteudo: { item_name: 'Camiseta', category_id: 100_017 } });

      expect(await criarRascunhoShopee(deps(db), corpo)).toEqual({
        linkDocId: RASCUNHO,
        criado: true,
      });
      const carimbo = db.store[CAMINHO]?.updateTime;
      expect(await criarRascunhoShopee(deps(db, { nowMs: AGORA + 5_000 }), corpo)).toEqual({
        linkDocId: RASCUNHO,
        criado: false,
      });

      expect(escritasEm(db)).toHaveLength(1);
      expect(db.store[CAMINHO]?.updateTime).toBe(carimbo);
      expect(doc(db)?.dataCadastro).toBe(AGORA);
    });

    it('⛔ quase-par: a repetição com item_name DIFERENTE ⇒ 409 CONFLITO {campo, atual = o gravado}, documento intacto', async () => {
      const db = base();
      await criarRascunhoShopee(deps(db), corpoCriar({ conteudo: { item_name: 'Camiseta' } }));
      const antes = structuredClone(doc(db));

      const err = await recusaDe(
        criarRascunhoShopee(deps(db), corpoCriar({ conteudo: { item_name: 'Camiseta Azul' } })),
      );

      expect(err.status).toBe(409);
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' }]);
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('a comparação é a do conteúdo NORMALIZADO, campo a campo, do documento que ESTA criação gravaria', async () => {
      const db = base();
      await criarRascunhoShopee(
        deps(db),
        corpoCriar({
          conteudo: { item_name: 'Camiseta', marca: { brand_id: 77, original_brand_name: 'X' } },
        }),
      );
      const antes = structuredClone(doc(db));
      // PAR: the SAME content again — description '   ' normalises to the
      // `null` stored, and an explicit `null` is what an absent key writes.
      for (const conteudo of [
        {
          item_name: 'Camiseta',
          marca: { brand_id: 77, original_brand_name: 'X' },
          description: '   ',
        },
        {
          item_name: 'Camiseta',
          marca: { brand_id: 77, original_brand_name: 'X' },
          description: null,
          category_id: null,
          attributes: null,
        },
      ]) {
        const r = await criarRascunhoShopee(deps(db), corpoCriar({ conteudo }));
        expect(r, JSON.stringify(conteudo)).toEqual({ linkDocId: RASCUNHO, criado: false });
      }
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('⛔ quase-par: uma chave que a repetição OMITE não é curinga — é o null (ou o nome do produto) que esta criação gravaria ⇒ 409 CONFLITO, documento intacto', async () => {
      const db = base();
      await criarRascunhoShopee(
        deps(db),
        corpoCriar({
          conteudo: { item_name: 'Camiseta', marca: { brand_id: 77, original_brand_name: 'X' } },
        }),
      );
      const antes = structuredClone(doc(db));
      const titulo = { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' };
      const marca = {
        campo: CAMPO_RASCUNHO_SHOPEE.marca,
        atual: { brand_id: 77, original_brand_name: 'X' },
      };
      const casos: [unknown, unknown[]][] = [
        // The lost-response case: the first create stored brand 77, the
        // operator cleared it, and the retry no longer names `marca` — never
        // a 200 over a brand the tab believes gone.
        [{ item_name: 'Camiseta' }, [marca]],
        // No `item_name` ⇒ the produto's `nome` ("Camiseta Básica") is what
        // this create writes; no `marca` ⇒ `null`.
        [undefined, [titulo, marca]],
        [null, [titulo, marca]],
        [{ description: '   ' }, [titulo, marca]],
        // The brand is a WRITE question here: the same id with another name
        // is other content; another id, and `null`, too.
        [
          { item_name: 'Camiseta', marca: { brand_id: 77, original_brand_name: 'Outro nome' } },
          [marca],
        ],
        [{ item_name: 'Camiseta', marca: { brand_id: 78, original_brand_name: 'X' } }, [marca]],
        [{ item_name: 'Camiseta', marca: null }, [marca]],
      ];
      for (const [conteudo, conflitos] of casos) {
        const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar({ conteudo })));
        expect(err.code, JSON.stringify(conteudo)).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos, JSON.stringify(conteudo)).toEqual(conflitos);
      }
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('PAR: a criação SEM conteúdo repetida sem conteúdo ⇒ 200 (as duas gravariam o nome do produto e o resto null) — ⛔ quase-par: "Sem marca" (0) não é a marca ausente (null)', async () => {
      const db = base();
      await criarRascunhoShopee(deps(db), corpoCriar());
      const antes = structuredClone(doc(db));

      for (const conteudo of [undefined, null, {}, { item_name: 'Camiseta Básica' }]) {
        const r = await criarRascunhoShopee(deps(db), corpoCriar({ conteudo }));
        expect(r, JSON.stringify(conteudo)).toEqual({ linkDocId: RASCUNHO, criado: false });
      }

      const err = await recusaDe(
        criarRascunhoShopee(
          deps(db),
          corpoCriar({ conteudo: { marca: { brand_id: 0, original_brand_name: null } } }),
        ),
      );
      expect(err.conflitos).toEqual([{ campo: CAMPO_RASCUNHO_SHOPEE.marca, atual: null }]);
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('⛔ quase-par: a repetição com DESCRIÇÃO ou CATEGORIA diferente — ou que as OMITE — ⇒ 409 CONFLITO: todo campo projetado é comparado, não só título e marca', async () => {
      const db = base();
      await criarRascunhoShopee(
        deps(db),
        corpoCriar({
          conteudo: { item_name: 'Camiseta', description: 'Algodão', category_id: 100_017 },
        }),
      );
      const antes = structuredClone(doc(db));

      // The same values, named again (in another key order) ⇒ the same draft.
      expect(
        await criarRascunhoShopee(
          deps(db),
          corpoCriar({
            conteudo: { category_id: 100_017, description: 'Algodão', item_name: 'Camiseta' },
          }),
        ),
      ).toEqual({ linkDocId: RASCUNHO, criado: false });

      const titulo = { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' };
      const descricao = { campo: CAMPO_RASCUNHO_SHOPEE.description, atual: 'Algodão' };
      const categoria = { campo: CAMPO_RASCUNHO_SHOPEE.categoryId, atual: 100_017 };
      const casos: [Record<string, unknown>, unknown[]][] = [
        [{ item_name: 'Camiseta', description: 'Poliéster', category_id: 100_017 }, [descricao]],
        // `null` is "the produto's own description" — another choice, never "nothing named".
        [{ item_name: 'Camiseta', description: null, category_id: 100_017 }, [descricao]],
        [{ item_name: 'Camiseta', description: 'Algodão', category_id: 100_020 }, [categoria]],
        [
          { item_name: 'Camiseta', description: 'Poliéster', category_id: 100_020 },
          [descricao, categoria],
        ],
        // A SUBSET is no longer "the same draft": what it omits is what this
        // create would write for it — the produto's name, a `null` description.
        [{ description: 'Algodão', category_id: 100_017 }, [titulo]],
        [{ item_name: 'Camiseta', category_id: 100_017 }, [descricao]],
      ];
      for (const [conteudo, conflitos] of casos) {
        const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar({ conteudo })));
        expect(err.code, JSON.stringify(conteudo)).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos, JSON.stringify(conteudo)).toEqual(conflitos);
      }
      expect(doc(db)).toEqual(antes);
      expect(escritasEm(db)).toHaveLength(1);
    });

    it('o id já é de um rascunho de OUTRA conta ⇒ 409 ID_EM_USO, documento intacto', async () => {
      const db = base();
      const alheio = rascunho({
        contaProdutoShopeeOuterRef: `documents/integracao/${OUTRA_CONTA}`,
      });
      db.seed(CAMINHO, alheio);

      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));

      expect(err.status).toBe(409);
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.idEmUso);
      expect(doc(db)).toEqual(alheio);
      expect(db.writes).toEqual([]);
    });

    it('o id já é de um ANÚNCIO desta conta ⇒ 409 ID_EM_USO (o próprio id fica fora do D15), documento intacto', async () => {
      const db = base();
      const anuncio = rascunho({ item_id: ITEM_VIVO, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
      db.seed(CAMINHO, anuncio);

      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.idEmUso);
      expect(doc(db)).toEqual(anuncio);
      expect(db.writes).toEqual([]);
    });

    it('⛔ quase-par: o MESMO id sob OUTRO produto é OUTRO documento — o id é por produto, então cria (201)', async () => {
      const db = base();
      db.seed(`produtos/${OUTRO_PRODUTO}/prodshopee/${RASCUNHO}`, rascunho());

      expect(await criarRascunhoShopee(deps(db), corpoCriar())).toEqual({
        linkDocId: RASCUNHO,
        criado: true,
      });
    });

    it('o create perdeu para um descarte (ALREADY_EXISTS, e o documento já não existe): tenta de novo e cria', async () => {
      const db = base();
      let primeira = true;
      const colecao = db.collection.bind(db);
      const corrida = new Proxy(db, {
        get(t, prop, r) {
          if (prop !== 'collection') return Reflect.get(t, prop, r) as unknown;
          return (colPath: string) => {
            const col = colecao(colPath);
            const construirRef = col.doc.bind(col);
            return {
              ...col,
              doc: (id?: string) => {
                const ref = construirRef(id);
                if (ref.path !== CAMINHO) return ref;
                return {
                  ...ref,
                  create: (data: Record<string, unknown>) => {
                    if (primeira) {
                      primeira = false;
                      return Promise.reject(grpc(6, 'ALREADY_EXISTS'));
                    }
                    return ref.create(data);
                  },
                };
              },
            };
          };
        },
      });

      expect(await criarRascunhoShopee(deps(corrida), corpoCriar())).toEqual({
        linkDocId: RASCUNHO,
        criado: true,
      });
      expect(escritasEm(db)).toHaveLength(1);
    });

    it(`ALREADY_EXISTS e documento ausente ${String(TENTATIVAS_DO_RASCUNHO)} vezes ⇒ 409 CONFLITO com conflitos []`, async () => {
      const db = base();
      db.falhasDeCriacao.set(CAMINHO, grpc(6, 'ALREADY_EXISTS'));

      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([]);
      expect(db.opLog.filter((o) => o.path === CAMINHO && o.op === 'get')).toHaveLength(
        TENTATIVAS_DO_RASCUNHO,
      );
      expect(avisos).toHaveLength(1);
    });

    it('uma falha do create que NÃO é ALREADY_EXISTS propaga como veio (regra 6)', async () => {
      const db = base();
      const falha = grpc(14, 'UNAVAILABLE');
      db.falhasDeCriacao.set(CAMINHO, falha);
      await expect(criarRascunhoShopee(deps(db), corpoCriar())).rejects.toBe(falha);
    });
  });

  describe('o produto que não leva rascunho (K2-10) — 422 PRODUTO_INVALIDO', () => {
    it('um FILHO (paiId não vazio, o teste do despacho) ⇒ motivo filho, zero escritas', async () => {
      for (const paiId of ['prod-0', ' ']) {
        const db = base();
        db.seed(CAMINHO_PRODUTO, produto({ paiId }));
        const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));
        expect(err.status).toBe(422);
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.produtoInvalido);
        expect(err.motivo).toBe(MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho);
        expect(corpoDaRecusaDeRascunhoShopee(err).motivo).toBe(
          MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho,
        );
        expect(db.writes).toEqual([]);
      }
    });

    it('⛔ quase-par: paiId null, ausente ou "" não é filho ⇒ cria', async () => {
      for (const paiId of [null, undefined, '']) {
        const db = base();
        db.seed(CAMINHO_PRODUTO, produto({ paiId }));
        expect((await criarRascunhoShopee(deps(db), corpoCriar())).criado, String(paiId)).toBe(
          true,
        );
      }
    });

    it('um KIT VIRTUAL (ehKit e ehKitVirtual) ⇒ motivo kit-virtual, zero escritas', async () => {
      const db = base();
      db.seed(CAMINHO_PRODUTO, produto({ ehKit: true, ehKitVirtual: true }));
      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));
      expect(err.status).toBe(422);
      expect(err.motivo).toBe(MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual);
      expect(db.writes).toEqual([]);
    });

    it('⛔ quase-par: ehKitVirtual sem ehKit não é kit virtual (ehKitVirtualEfetivo) ⇒ cria; um kit NÃO virtual também', async () => {
      for (const extra of [
        { ehKit: false, ehKitVirtual: true },
        { ehKit: true, ehKitVirtual: false },
      ]) {
        const db = base();
        db.seed(CAMINHO_PRODUTO, produto(extra));
        expect((await criarRascunhoShopee(deps(db), corpoCriar())).criado).toBe(true);
      }
    });

    it('nenhum desses motivos é uma recusa PERSISTIDA do despacho', () => {
      expect(Object.values(MOTIVO_RASCUNHO_INVALIDO_SHOPEE)).not.toContain(
        ['rascunho', 'em', 'kit', 'virtual'].join('-'),
      );
    });
  });

  it('o produto não existe ⇒ 404 INEXISTENTE, zero escritas', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO_CONTA, conta());
    const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));
    expect(err.status).toBe(404);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);
    expect(db.writes).toEqual([]);
  });

  it('a conta ausente, ou que não é Shopee ⇒ ShopeeContaNotConfiguredError (o 404 do shopeeErrorResponse), zero escritas', async () => {
    for (const semear of [null, conta({ tipo: INTEGRACAO_TIPO.mercadoLivre })]) {
      __resetAllReadCaches();
      const db = new FakeDb();
      db.seed(CAMINHO_PRODUTO, produto());
      if (semear !== null) db.seed(CAMINHO_CONTA, semear);
      await expect(criarRascunhoShopee(deps(db), corpoCriar())).rejects.toBeInstanceOf(
        ShopeeContaNotConfiguredError,
      );
      expect(db.writes).toEqual([]);
    }
  });

  it('o leitor de conta injetado (a costura do emulador) substitui o readConta — nenhum integracao/{id} lido', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO_PRODUTO, produto());
    const lerConta = vi.fn(() => Promise.resolve({ tipo: INTEGRACAO_TIPO.shopee }));

    expect((await criarRascunhoShopee(deps(db, { lerConta }), corpoCriar())).criado).toBe(true);
    expect(lerConta).toHaveBeenCalledWith(asDb(db), INTEGRACAO);
    expect(db.caminhos).not.toContain(CAMINHO_CONTA);
  });

  describe('D15 — um SEGUNDO anúncio na conta exige confirmação', () => {
    it('um anúncio VIVO e um RASCUNHO irmão ⇒ 409 CONTA_JA_TEM_ANUNCIO listando os DOIS, zero escritas', async () => {
      const db = base();
      db.seed(
        `${COLECAO}/${VIVO}`,
        rascunho({ item_id: ITEM_VIVO, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo }),
      );
      db.seed(`${COLECAO}/${IRMAO}`, rascunho());

      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));

      expect(err.status).toBe(409);
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
      expect(err.vinculos).toEqual([
        { linkDocId: VIVO, itemId: ITEM_VIVO, rascunho: false },
        { linkDocId: IRMAO, itemId: null, rascunho: true },
      ]);
      for (const v of corpoDaRecusaDeRascunhoShopee(err).vinculos ?? []) {
        expect(vinculoConflitanteShopeeSchema.parse(v)).toEqual(v);
      }
      expect(db.writes).toEqual([]);
    });

    it('⛔ um rascunho irmão SOZINHO já exige (não é só o anúncio vivo)', async () => {
      const db = base();
      db.seed(`${COLECAO}/${IRMAO}`, rascunho());
      const err = await recusaDe(criarRascunhoShopee(deps(db), corpoCriar()));
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
      expect(err.vinculos).toEqual([{ linkDocId: IRMAO, itemId: null, rascunho: true }]);
    });

    it('com confirmarSegundoAnuncio: true ⇒ 201; null ou ausente NÃO confirma', async () => {
      for (const confirmar of [null, undefined]) {
        const db = base();
        db.seed(`${COLECAO}/${IRMAO}`, rascunho());
        const err = await recusaDe(
          criarRascunhoShopee(deps(db), corpoCriar({ confirmarSegundoAnuncio: confirmar })),
        );
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
      }
      const db = base();
      db.seed(`${COLECAO}/${IRMAO}`, rascunho());
      const r = await criarRascunhoShopee(deps(db), corpoCriar({ confirmarSegundoAnuncio: true }));
      expect(r.criado).toBe(true);
    });

    it('⛔ quase-par: só um anúncio REMOVIDO, ou um vínculo de OUTRA conta ⇒ cria SEM confirmação', async () => {
      const db = base();
      db.seed(
        `${COLECAO}/${VIVO}`,
        rascunho({ item_id: ITEM_VIVO, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
      );
      db.seed(
        `${COLECAO}/${IRMAO}`,
        rascunho({ contaProdutoShopeeOuterRef: `documents/integracao/${OUTRA_CONTA}` }),
      );
      expect((await criarRascunhoShopee(deps(db), corpoCriar())).criado).toBe(true);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                          2 · atualizarRascunhoShopee                        */
/* -------------------------------------------------------------------------- */

describe('atualizarRascunhoShopee — base conferida (nível 3) + update guardado (nível 1)', () => {
  it('base igual ao gravado ⇒ grava SÓ o campo do patch + ultimaModificacao, por UPDATE, e responde gravados', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());

    const r = await atualizarRascunhoShopee(
      deps(db),
      corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta Azul' }),
    );

    expect(respostaAtualizarRascunhoShopeeSchema.parse(r)).toEqual({
      linkDocId: RASCUNHO,
      gravados: [CAMPO_RASCUNHO_SHOPEE.itemName],
    });
    expect(db.patches).toEqual([
      { path: CAMINHO, patch: { item_name: 'Camiseta Azul', ultimaModificacao: AGORA } },
    ]);
    expect(doc(db)).toEqual({
      ...rascunho(),
      item_name: 'Camiseta Azul',
      ultimaModificacao: AGORA,
    });
  });

  it('⛔ quase-par: OUTRO campo mudou por outra pessoa e o patch não o nomeia ⇒ 200 — só os campos do patch são comparados', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ description: 'escrita em outra aba' }));

    const r = await atualizarRascunhoShopee(
      deps(db),
      corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta Azul' }),
    );

    expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
    expect(doc(db)?.description).toBe('escrita em outra aba');
  });

  it('a base do campo editado DIFERE do gravado ⇒ 409 CONFLITO com cada campo e o valor ATUAL, zero escritas', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ item_name: 'Título de outra aba', category_id: 100_020 }));

    const err = await recusaDe(
      atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          // K1-12: a category change without `attributes` in the patch shows
          // the attributes it would clear — here equal to the stored `null`.
          {
            item_name: 'Camiseta do rascunho',
            category_id: 100_017,
            description: null,
            attributes: null,
          },
          { item_name: 'Camiseta Azul', category_id: 100_030, description: 'nova' },
        ),
      ),
    );

    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    // Canonical order; `description` matched, so it is not listed.
    expect(err.conflitos).toEqual([
      { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Título de outra aba' },
      { campo: CAMPO_RASCUNHO_SHOPEE.categoryId, atual: 100_020 },
    ]);
    for (const c of corpoDaRecusaDeRascunhoShopee(err).conflitos ?? []) {
      expect(conflitoRascunhoShopeeSchema.parse(c)).toEqual(c);
    }
    expect(db.writes).toEqual([]);
  });

  it('a base não é aparada: "Camiseta " vista contra "Camiseta" gravada é CONFLITO', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ item_name: 'Camiseta' }));
    const err = await recusaDe(
      atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ item_name: 'Camiseta ' }, { item_name: 'Camiseta Azul' }),
      ),
    );
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
  });

  describe('o rascunho LEGADO (K2-4: a base é VERBATIM)', () => {
    it("description '' gravada e base '' ⇒ sem conflito, grava — ⛔ quase-par: base null ⇒ 409", async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ description: '' }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ description: '' }, { description: 'Algodão' }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.description]);

      const db2 = new FakeDb();
      db2.seed(CAMINHO, rascunho({ description: '' }));
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(db2),
          corpoAtualizar({ description: null }, { description: 'Algodão' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([{ campo: CAMPO_RASCUNHO_SHOPEE.description, atual: '' }]);
      expect(db2.writes).toEqual([]);
    });

    it('item_name AUSENTE no documento aceita base {item_name: null} e a edição do título passa', async () => {
      const db = new FakeDb();
      const legado = rascunho();
      delete legado.item_name;
      db.seed(CAMINHO, legado);

      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ item_name: null }, { item_name: 'Título novo' }),
      );

      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      expect(doc(db)?.item_name).toBe('Título novo');
    });

    it('description AUSENTE ≡ null: base null não é conflito', async () => {
      const db = new FakeDb();
      const legado = rascunho();
      delete legado.description;
      db.seed(CAMINHO, legado);
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ description: null }, { description: 'Algodão' }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.description]);
    });
  });

  it('o patch IGUAL ao gravado ⇒ 200 gravados [] e NENHUMA escrita (description em branco normaliza para null)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    for (const [baseVista, patch] of [
      [{ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta do rascunho' }],
      [{ description: null }, { description: '   ' }],
      [
        { marca: { brand_id: 0, original_brand_name: null } },
        { marca: { brand_id: 0, original_brand_name: null } },
      ],
    ] as const) {
      const r = await atualizarRascunhoShopee(deps(db), corpoAtualizar(baseVista, patch));
      expect(r, JSON.stringify(patch)).toEqual({ linkDocId: RASCUNHO, gravados: [] });
    }
    expect(db.writes).toEqual([]);
  });

  it('⛔ quase-par: "Camiseta do rascunho " (espaço) NÃO é igual — grava', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const r = await atualizarRascunhoShopee(
      deps(db),
      corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta do rascunho ' }),
    );
    expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
  });

  it('só os campos que DIFEREM são gravados — os iguais do patch ficam fora da escrita e de gravados', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const r = await atualizarRascunhoShopee(
      deps(db),
      corpoAtualizar(
        { item_name: 'Camiseta do rascunho', description: null },
        { item_name: 'Camiseta do rascunho', description: 'Algodão' },
      ),
    );
    expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.description]);
    expect(db.patches).toEqual([
      { path: CAMINHO, patch: { description: 'Algodão', ultimaModificacao: AGORA } },
    ]);
  });

  describe('a marca é UM campo sobre DUAS chaves (D10)', () => {
    it('grava o par INTEIRO — brand_id e original_brand_name juntos', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ brand_id: null, original_brand_name: null }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: null },
          { marca: { brand_id: 77, original_brand_name: 'Marca X' } },
        ),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.marca]);
      expect(db.patches[0]?.patch).toEqual({
        brand_id: 77,
        original_brand_name: 'Marca X',
        ultimaModificacao: AGORA,
      });
    });

    it('marca null ⇒ as DUAS chaves null no update', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ brand_id: 77, original_brand_name: 'Marca X' }));
      await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: { brand_id: 77, original_brand_name: 'Marca X' } },
          { marca: null },
        ),
      );
      expect(db.patches[0]?.patch).toEqual({
        brand_id: null,
        original_brand_name: null,
        ultimaModificacao: AGORA,
      });
    });

    it('a base compara a marca pelo brand_id: o nome divergente NÃO é conflito; ⛔ o id divergente é', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ brand_id: 77, original_brand_name: 'Nome lido de volta' }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ marca: { brand_id: 77, original_brand_name: null } }, { marca: null }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.marca]);

      const db2 = new FakeDb();
      db2.seed(CAMINHO, rascunho({ brand_id: 77 }));
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(db2),
          corpoAtualizar({ marca: { brand_id: 0, original_brand_name: null } }, { marca: null }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    });

    /** A legacy draft: `brand_id` stored ALONE — the legacy app never wrote a name. */
    function legadoSoComBrandId(): Record<string, unknown> {
      const legado = rascunho({ brand_id: 77 });
      delete legado.original_brand_name;
      return legado;
    }

    it('⛔ o rascunho LEGADO só com brand_id: escolher de novo a MESMA marca, agora com o nome, GRAVA o par — "nada a gravar" compara o PAR, não só o id', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, legadoSoComBrandId());

      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: { brand_id: 77, original_brand_name: null } },
          { marca: { brand_id: 77, original_brand_name: 'Acme' } },
        ),
      );

      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.marca]);
      expect(db.patches).toEqual([
        {
          path: CAMINHO,
          patch: { brand_id: 77, original_brand_name: 'Acme', ultimaModificacao: AGORA },
        },
      ]);
      expect(camposDoRascunhoShopee(doc(db) ?? {}).marca).toEqual({
        brand_id: 77,
        original_brand_name: 'Acme',
      });

      // …and the next identical save reads the pair back EQUAL: nothing more written.
      const deNovo = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: { brand_id: 77, original_brand_name: 'Acme' } },
          { marca: { brand_id: 77, original_brand_name: 'Acme' } },
        ),
      );
      expect(deNovo.gravados).toEqual([]);
      expect(db.patches).toHaveLength(1);
    });

    it('⛔ quase-par: a MESMA marca SEM nome (null, ou um nome em branco que a escrita dobra para null) sobre o legado sem nome ⇒ gravados [] e NADA escrito', async () => {
      for (const original_brand_name of [null, '   ']) {
        const db = new FakeDb();
        db.seed(CAMINHO, legadoSoComBrandId());
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            { marca: { brand_id: 77, original_brand_name: null } },
            { marca: { brand_id: 77, original_brand_name } },
          ),
        );
        expect(r.gravados, String(original_brand_name)).toEqual([]);
        expect(db.writes).toEqual([]);
      }
    });

    it('⛔ quase-par: o nome da mesma marca mudado só na CAIXA ("Acme" → "ACME") é uma escrita — o nome não é dobrado', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ brand_id: 77, original_brand_name: 'Acme' }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: { brand_id: 77, original_brand_name: 'Acme' } },
          { marca: { brand_id: 77, original_brand_name: 'ACME' } },
        ),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.marca]);
      expect(doc(db)).toMatchObject({ brand_id: 77, original_brand_name: 'ACME' });
    });

    it('o OUTRO sentido do par: a MESMA marca escolhida SEM nome sobre um nome gravado é uma escrita — o par é gravado INTEIRO (D10) e o nome vira null', async () => {
      // Pins the write compare's other direction at the route seam (FIX-P4
      // verifier): before the fix this was a silent no-op that kept the
      // stored name; now the operator's nameless pick is written whole, and
      // the publish's bounded brand walk looks the name up again.
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ brand_id: 77, original_brand_name: 'Acme' }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { marca: { brand_id: 77, original_brand_name: 'Acme' } },
          { marca: { brand_id: 77, original_brand_name: null } },
        ),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.marca]);
      expect(db.patches).toEqual([
        {
          path: CAMINHO,
          patch: { brand_id: 77, original_brand_name: null, ultimaModificacao: AGORA },
        },
      ]);
    });
  });

  it('a mudança de CATEGORIA limpa os atributos gravados (são da categoria velha) e o diz em gravados', async () => {
    const db = new FakeDb();
    // A stored list with nothing usable PROJECTS to `[]` — which is what the
    // operator saw, so `[]` is the base; it is still cleared (it is stored).
    db.seed(CAMINHO, rascunho({ attributes: [{ attribute_id: 1, attribute_value_list: [] }] }));
    const r = await atualizarRascunhoShopee(
      deps(db),
      corpoAtualizar({ category_id: 100_017, attributes: [] }, { category_id: 100_030 }),
    );
    expect(r.gravados).toEqual([
      CAMPO_RASCUNHO_SHOPEE.categoryId,
      CAMPO_RASCUNHO_SHOPEE.attributes,
    ]);
    expect(db.patches[0]?.patch).toEqual({
      category_id: 100_030,
      attributes: null,
      ultimaModificacao: AGORA,
    });
    expect(doc(db)?.attributes).toBeNull();
  });

  it('⛔ quase-par: sem atributos gravados, a mudança de categoria não escreve attributes', async () => {
    for (const extra of [{ attributes: null }, { attributes: undefined }]) {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho(extra));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ category_id: 100_017, attributes: null }, { category_id: 100_030 }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.categoryId]);
      expect(db.patches[0]?.patch).not.toHaveProperty('attributes');
    }
  });

  describe('os atributos (P6, D9) — escritos na forma de requisição, comparados pelo decodificador', () => {
    it('grava a lista do patch por UPDATE guardado — gravados [attributes]', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ attributes: null }, { attributes: ATRIBUTOS }),
      );
      expect(r).toEqual({ linkDocId: RASCUNHO, gravados: [CAMPO_RASCUNHO_SHOPEE.attributes] });
      expect(db.patches).toEqual([
        { path: CAMINHO, patch: { attributes: ATRIBUTOS, ultimaModificacao: AGORA } },
      ]);
      expect(doc(db)?.attributes).toStrictEqual(ATRIBUTOS);
    });

    it('a rota NÃO filtra pela árvore (não tem uma): o atributo de OUTRA categoria vai gravado como veio — descartar o invisível é do salvar do EDITOR (P13)', async () => {
      const deOutraCategoria = [
        ...ATRIBUTOS,
        { attribute_id: 9999, attribute_value_list: [{ value_id: 7 }] },
      ];
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ attributes: null }, { attributes: deOutraCategoria }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
      expect(doc(db)?.attributes).toStrictEqual(deOutraCategoria);
    });

    it('attributes: null no patch LIMPA a lista — ⛔ quase-par: [] também é uma escrita (não é null)', async () => {
      for (const attributes of [null, []]) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ attributes: ATRIBUTOS }, { attributes }),
        );
        expect(r.gravados, JSON.stringify(attributes)).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
        expect(doc(db)?.attributes).toEqual(attributes);
      }
    });

    it('o patch IGUAL ao gravado — chaves em outra ordem, nome com espaços, unidade em branco — ⇒ gravados [] e NADA escrito', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar(
          { attributes: ATRIBUTOS },
          {
            attributes: [
              { attribute_value_list: [{ value_unit: ' ', value_id: 55 }], attribute_id: 100_001 },
              {
                attribute_id: 100_002,
                attribute_value_list: [
                  { value_unit: 'cm', original_value_name: '  Algodão', value_id: 0 },
                ],
              },
            ],
          },
        ),
      );
      expect(r).toEqual({ linkDocId: RASCUNHO, gravados: [] });
      expect(db.writes).toEqual([]);
    });

    it('⛔ quase-par: a MESMA lista em outra ORDEM é uma edição (posicional de propósito) — grava', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
      const invertida = [ATRIBUTOS[1], ATRIBUTOS[0]];
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ attributes: ATRIBUTOS }, { attributes: invertida }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
      expect(doc(db)?.attributes).toEqual(invertida);
    });

    it("⛔ quase-par: unidade 'cm' gravada contra 'CM' no patch é OUTRO valor — grava", async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
      const maiuscula = [
        ATRIBUTOS[0],
        {
          attribute_id: 100_002,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão', value_unit: 'CM' }],
        },
      ];
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ attributes: ATRIBUTOS }, { attributes: maiuscula }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
    });

    it('o formato de LEITURA, um value_id texto ou uma lista vazia no patch ⇒ 400 no corpo (o patch é a forma de requisição)', () => {
      for (const attributes of [
        [
          {
            attribute_id: 100_001,
            original_attribute_name: 'Cor',
            attribute_value_list: [{ value_id: 55 }],
          },
        ],
        [
          {
            attribute_id: 100_001,
            attribute_value_list: [{ value_id: 55, original_value_name: 'Azul' }],
          },
        ],
        [{ attribute_id: 100_001, attribute_value_list: [{ value_id: '55' }] }],
        [{ attribute_id: 100_001, attribute_value_list: [] }],
        [ATRIBUTOS[0], ATRIBUTOS[0]],
      ]) {
        expect(
          () => corpoAtualizar({ attributes: null }, { attributes }),
          JSON.stringify(attributes),
        ).toThrow(ZodError);
      }
    });

    describe('a BASE dos atributos (K2-5: o escopo da comparação)', () => {
      it('as chaves em outra ORDEM na base ⇒ igual, grava', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            {
              attributes: [
                { attribute_value_list: [{ value_id: 55 }], attribute_id: 100_001 },
                {
                  attribute_value_list: [
                    { value_unit: 'cm', original_value_name: 'Algodão', value_id: 0 },
                  ],
                  attribute_id: 100_002,
                },
              ],
            },
            { attributes: ATRIBUTOS_DE_OUTRA_ABA },
          ),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
      });

      it("⛔ quase-par: value_unit '' na base contra a unidade AUSENTE gravada ⇒ 409; a lista em outra ORDEM na base ⇒ 409; nada escrito", async () => {
        const semUnidade = [{ attribute_id: 100_001, attribute_value_list: [{ value_id: 55 }] }];
        const casos: [gravado: unknown[], visto: unknown[]][] = [
          [
            semUnidade,
            [{ attribute_id: 100_001, attribute_value_list: [{ value_id: 55, value_unit: '' }] }],
          ],
          [ATRIBUTOS, [ATRIBUTOS[1], ATRIBUTOS[0]]],
        ];
        for (const [gravado, visto] of casos) {
          const db = new FakeDb();
          db.seed(CAMINHO, rascunho({ attributes: gravado }));
          const err = await recusaDe(
            atualizarRascunhoShopee(
              deps(db),
              corpoAtualizar({ attributes: visto }, { attributes: ATRIBUTOS_DE_OUTRA_ABA }),
            ),
          );
          expect(err.code, JSON.stringify(visto)).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
          expect(err.conflitos).toEqual([
            { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: gravado },
          ]);
          expect(db.writes).toEqual([]);
        }
      });
    });

    describe('o valor LEGADO sem value_id (Q1: lido como PERSONALIZADO, e enviado)', () => {
      const LEGADO = [
        { attribute_id: 100_002, attribute_value_list: [{ original_value_name: 'Algodão' }] },
      ];
      const PROJETADO = [
        {
          attribute_id: 100_002,
          attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }],
        },
      ];

      it('a base é a PROJEÇÃO ({value_id: 0, nome}): passa; o patch igual a ela NÃO escreve (sem migração, D9) — o gravado fica byte-igual', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: LEGADO }));
        expect(camposDoRascunhoShopee(rascunho({ attributes: LEGADO })).attributes).toEqual(
          PROJETADO,
        );

        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ attributes: PROJETADO }, { attributes: PROJETADO }),
        );
        expect(r.gravados).toEqual([]);
        expect(db.writes).toEqual([]);
        expect(doc(db)?.attributes).toEqual(LEGADO);
      });

      it('um patch NOVO sobre o legado grava a FORMA DE REQUISIÇÃO (D9: sempre)', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: LEGADO }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ attributes: PROJETADO }, { attributes: ATRIBUTOS }),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
        expect(doc(db)?.attributes).toStrictEqual(ATRIBUTOS);
      });

      it('⛔ quase-par: a base [] contra o legado com NOME ⇒ 409 (o valor NÃO é descartado); contra o legado com nome EM BRANCO ⇒ passa (esse é descartado)', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: LEGADO }));
        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(db),
            corpoAtualizar({ attributes: [] }, { attributes: ATRIBUTOS }),
          ),
        );
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos).toEqual([
          { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: PROJETADO },
        ]);
        expect(db.writes).toEqual([]);

        const db2 = new FakeDb();
        db2.seed(
          CAMINHO,
          rascunho({
            attributes: [
              { attribute_id: 100_002, attribute_value_list: [{ original_value_name: '   ' }] },
            ],
          }),
        );
        const r = await atualizarRascunhoShopee(
          deps(db2),
          corpoAtualizar({ attributes: [] }, { attributes: ATRIBUTOS }),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
      });
    });

    describe('a troca de CATEGORIA e os atributos (K1-12)', () => {
      it('B gravou atributos; A troca a categoria com a base VELHA dos atributos ⇒ 409 CONFLITO nomeando attributes (atual = os de B), NADA apagado', async () => {
        const db = new FakeDb();
        // A opened the draft holding ATRIBUTOS; B's save of ATRIBUTOS_DE_OUTRA_ABA landed since.
        const deB = rascunho({ attributes: ATRIBUTOS_DE_OUTRA_ABA });
        db.seed(CAMINHO, deB);

        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(db),
            corpoAtualizar(
              { category_id: 100_017, attributes: ATRIBUTOS },
              { category_id: 100_030 },
            ),
          ),
        );

        expect(err.status).toBe(409);
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        // ONLY attributes: the category A saw is still the stored one.
        expect(err.conflitos).toEqual([
          { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: ATRIBUTOS_DE_OUTRA_ABA },
        ]);
        expect(doc(db)).toEqual(deB);
        expect(db.writes).toEqual([]);
      });

      it('⛔ quase-par: A troca a categoria com a base ATUAL dos atributos ⇒ grava category_id + attributes: null, gravados [category_id, attributes]', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ category_id: 100_017, attributes: ATRIBUTOS }, { category_id: 100_030 }),
        );
        expect(r.gravados).toEqual([
          CAMPO_RASCUNHO_SHOPEE.categoryId,
          CAMPO_RASCUNHO_SHOPEE.attributes,
        ]);
        expect(db.patches).toEqual([
          {
            path: CAMINHO,
            patch: { category_id: 100_030, attributes: null, ultimaModificacao: AGORA },
          },
        ]);
      });

      it('a troca de categoria SEM base.attributes ⇒ 400 no corpo (a refine do K1-12), nada lido nem escrito', () => {
        expect(() => corpoAtualizar({ category_id: 100_017 }, { category_id: 100_030 })).toThrow(
          ZodError,
        );
      });

      it('B grava atributos ENTRE a leitura e o update de A ⇒ a precondição recusa, a re-leitura vê o conflito em attributes — os de B ficam', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const corrida = comEscritaConcorrente(db, CAMINHO, () => {
          db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS_DE_OUTRA_ABA }));
        });

        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(corrida),
            corpoAtualizar(
              { category_id: 100_017, attributes: ATRIBUTOS },
              { category_id: 100_030 },
            ),
          ),
        );

        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos).toEqual([
          { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: ATRIBUTOS_DE_OUTRA_ABA },
        ]);
        expect(doc(db)?.attributes).toEqual(ATRIBUTOS_DE_OUTRA_ABA);
        expect(doc(db)?.category_id).toBe(100_017);
        expect(db.writes).toEqual([]);
      });

      it('⛔ quase-par: B grava OUTRO campo entre a leitura e o update ⇒ a re-leitura passa — a categoria muda e os atributos que A VIU são limpos', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const corrida = comEscritaConcorrente(db, CAMINHO, () => {
          db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS, description: 'de outra aba' }));
        });
        const r = await atualizarRascunhoShopee(
          deps(corrida),
          corpoAtualizar({ category_id: 100_017, attributes: ATRIBUTOS }, { category_id: 100_030 }),
        );
        expect(r.gravados).toEqual([
          CAMPO_RASCUNHO_SHOPEE.categoryId,
          CAMPO_RASCUNHO_SHOPEE.attributes,
        ]);
        expect(doc(db)).toMatchObject({
          category_id: 100_030,
          attributes: null,
          description: 'de outra aba',
        });
      });

      it('categoria + attributes NO MESMO patch ⇒ grava os atributos do patch, nunca os apaga', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            { category_id: 100_017, attributes: ATRIBUTOS },
            { category_id: 100_030, attributes: ATRIBUTOS_DA_NOVA_CATEGORIA },
          ),
        );
        expect(r.gravados).toEqual([
          CAMPO_RASCUNHO_SHOPEE.categoryId,
          CAMPO_RASCUNHO_SHOPEE.attributes,
        ]);
        expect(db.patches[0]?.patch).toEqual({
          category_id: 100_030,
          attributes: ATRIBUTOS_DA_NOVA_CATEGORIA,
          ultimaModificacao: AGORA,
        });
      });

      it('⛔ categoria + attributes IGUAIS ao gravado no mesmo patch ⇒ só a categoria é gravada; os atributos FICAM (o operador os escolheu para a nova categoria)', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            { category_id: 100_017, attributes: ATRIBUTOS },
            { category_id: 100_030, attributes: ATRIBUTOS },
          ),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.categoryId]);
        expect(db.patches[0]?.patch).toEqual({ category_id: 100_030, ultimaModificacao: AGORA });
        expect(doc(db)?.attributes).toEqual(ATRIBUTOS);
      });

      it('a categoria do patch IGUAL à gravada, SOZINHA (sem attributes) ⇒ nada escrito, os atributos ficam', async () => {
        // ⚠️ This pins the "nothing to write" EARLY RETURN, not the wipe's key:
        // the only patched field is equal, so `atualizarRascunhoShopee` returns
        // before `limpaAtributosNaTrocaDeCategoria` is ever asked. The near-miss
        // below is the one that reaches it.
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ category_id: 100_017, attributes: ATRIBUTOS }, { category_id: 100_017 }),
        );
        expect(r.gravados).toEqual([]);
        expect(db.writes).toEqual([]);
        expect(doc(db)?.attributes).toEqual(ATRIBUTOS);
      });

      it('⛔ quase-par: a categoria GRAVADA re-enviada JUNTO com um título novo ⇒ só item_name é gravado, os atributos FICAM (a chave é a categoria ESCRITA, não a NOMEADA)', async () => {
        // An editor that posts the whole form sends the stored category beside
        // a title edit: something IS written, so the wipe's predicate is asked —
        // and the category was named, not changed. Keying the wipe on the patch
        // NAMING `category_id` (RA1) would write `attributes: null` here behind
        // a 200.
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            { item_name: 'Camiseta do rascunho', category_id: 100_017, attributes: ATRIBUTOS },
            { item_name: 'Camiseta Azul', category_id: 100_017 },
          ),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
        expect(db.patches).toEqual([
          { path: CAMINHO, patch: { item_name: 'Camiseta Azul', ultimaModificacao: AGORA } },
        ]);
        expect(doc(db)?.attributes).toEqual(ATRIBUTOS);
      });

      it('PAR do anterior: a categoria NOVA junto com um título novo ⇒ item_name + category_id + attributes: null', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: ATRIBUTOS }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar(
            { item_name: 'Camiseta do rascunho', category_id: 100_017, attributes: ATRIBUTOS },
            { item_name: 'Camiseta Azul', category_id: 100_030 },
          ),
        );
        expect(r.gravados).toEqual([
          CAMPO_RASCUNHO_SHOPEE.itemName,
          CAMPO_RASCUNHO_SHOPEE.categoryId,
          CAMPO_RASCUNHO_SHOPEE.attributes,
        ]);
        expect(db.patches).toEqual([
          {
            path: CAMINHO,
            patch: {
              item_name: 'Camiseta Azul',
              category_id: 100_030,
              attributes: null,
              ultimaModificacao: AGORA,
            },
          },
        ]);
      });

      it('um attributes gravado que NÃO é lista (projeta null) também é da categoria velha ⇒ limpo — a leitura é do GRAVADO, não da projeção', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ attributes: 'lixo-legado' }));
        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ category_id: 100_017, attributes: null }, { category_id: 100_030 }),
        );
        expect(r.gravados).toEqual([
          CAMPO_RASCUNHO_SHOPEE.categoryId,
          CAMPO_RASCUNHO_SHOPEE.attributes,
        ]);
        expect(doc(db)?.attributes).toBeNull();
      });
    });
  });

  describe('a TRAVA da publicação (lida, nunca escrita)', () => {
    it('trava VIVA ⇒ 409 EM_ANDAMENTO com aguardarMs, zero escritas', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 60_000) }));
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
      expect(err.aguardarMs).toBe(60_000);
      expect(corpoDaRecusaDeRascunhoShopee(err).aguardarMs).toBe(60_000);
      expect(err).not.toBeInstanceOf(ShopeeError);
      expect(db.writes).toEqual([]);
    });

    it('a CARÊNCIA pós-expiração ainda é EM_ANDAMENTO (expiraEm exato e expiraEm + 240 000 − 1)', async () => {
      for (const [agora, aguardar] of [
        [AGORA, AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS],
        [AGORA + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1, 1],
      ] as const) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA) }));
        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(db, { nowMs: agora }),
            corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
          ),
        );
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
        expect(err.aguardarMs).toBe(aguardar);
        expect(db.writes).toEqual([]);
      }
    });

    it('INCERTA (trava passada da carência): editar o TÍTULO passa — e a trava fica BYTE-idêntica', async () => {
      const db = new FakeDb();
      const trava = travaAlheia(AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS);
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: trava }));

      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta Azul' }),
      );

      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      expect(doc(db)?.publicacaoEmCurso).toEqual(trava);
      expect(db.patches[0]?.patch).not.toHaveProperty('publicacaoEmCurso');
    });

    it('INCERTA + categoria no patch ⇒ 409 CATEGORIA_TRAVADA, zero escritas (trava vencida E criacaoIncertaDesde sem trava)', async () => {
      for (const extra of [
        { publicacaoEmCurso: travaAlheia(AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS) },
        { criacaoIncertaDesde: AGORA - 1_000 },
      ]) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho(extra));
        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(db),
            corpoAtualizar(
              { item_name: 'Camiseta do rascunho', category_id: 100_017, attributes: null },
              { item_name: 'X', category_id: 100_030 },
            ),
          ),
        );
        expect(err.status).toBe(409);
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.categoriaTravada);
        expect(db.writes).toEqual([]);
      }
    });

    it('⛔ INCERTA + a categoria GRAVADA re-enviada no patch ⇒ AINDA 409 CATEGORIA_TRAVADA, e o título ao lado também não grava — a trava é "o patch NOMEIA category_id" (DA-4), nunca "o valor muda"; quase-par: o MESMO título sem category_id grava', async () => {
      for (const extra of [
        { publicacaoEmCurso: travaAlheia(AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS) },
        { criacaoIncertaDesde: AGORA - 1_000 },
      ]) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho(extra));
        const antes = structuredClone(doc(db));

        // The base is exactly the fixture's projection, so a "the value
        // changes" lock would pass the baseline and answer 200 [item_name].
        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(db),
            corpoAtualizar(
              { item_name: 'Camiseta do rascunho', category_id: 100_017, attributes: null },
              { item_name: 'X', category_id: 100_017 },
            ),
          ),
        );
        expect(err.status, JSON.stringify(extra)).toBe(409);
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.categoriaTravada);
        expect(db.writes).toEqual([]);
        expect(doc(db)).toEqual(antes);

        const r = await atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        );
        expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      }
    });

    it('⛔ quase-par: LIVRE + categoria no patch ⇒ grava', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ category_id: 100_017, attributes: null }, { category_id: 100_030 }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.categoryId]);
    });

    it('INCERTA: os ATRIBUTOS ainda mudam (só a categoria trava) — a trava fica BYTE-idêntica', async () => {
      const db = new FakeDb();
      const trava = travaAlheia(AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS);
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: trava }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ attributes: null }, { attributes: ATRIBUTOS }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.attributes]);
      expect(doc(db)?.publicacaoEmCurso).toEqual(trava);
      expect(doc(db)?.attributes).toEqual(ATRIBUTOS);
    });
  });

  describe('o documento que não é (mais) um rascunho desta conta', () => {
    it('ausente ⇒ 404 INEXISTENTE; de OUTRA conta ⇒ 404 INEXISTENTE; zero escritas', async () => {
      const db = new FakeDb();
      let err = await recusaDe(
        atualizarRascunhoShopee(deps(db), corpoAtualizar({ item_name: null }, { item_name: 'X' })),
      );
      expect(err.status).toBe(404);
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);

      db.seed(
        CAMINHO,
        rascunho({ contaProdutoShopeeOuterRef: `documents/integracao/${OUTRA_CONTA}` }),
      );
      err = await recusaDe(
        atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);
      expect(db.writes).toEqual([]);
    });

    it('a ref LEGADA nua (integracao/<id>) é desta conta', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ contaProdutoShopeeOuterRef: `integracao/${INTEGRACAO}` }));
      const r = await atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
      );
      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
    });

    it('um ANÚNCIO (item_id) ⇒ 409 JA_PUBLICADO {linkDocId}, zero escritas (D8)', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ item_id: ITEM_VIVO }));
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.jaPublicado);
      expect(corpoDaRecusaDeRascunhoShopee(err).linkDocId).toBe(RASCUNHO);
      expect(db.writes).toEqual([]);
    });
  });

  describe('perder a precondição RE-DECIDE (nunca re-aplica)', () => {
    it('outra aba gravou o MESMO campo depois da leitura ⇒ a precondição recusa, a re-leitura vê o conflito — o vencedor fica', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () => {
        db.seed(CAMINHO, rascunho({ item_name: 'Escrito pela outra aba' }));
      });

      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(corrida),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta Azul' }),
        ),
      );

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([
        { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Escrito pela outra aba' },
      ]);
      expect(doc(db)?.item_name).toBe('Escrito pela outra aba');
      expect(db.writes).toEqual([]);
    });

    it('⛔ quase-par: a outra aba gravou OUTRO campo ⇒ a re-leitura passa e grava — os dois sobrevivem', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () => {
        db.seed(CAMINHO, rascunho({ description: 'Escrita pela outra aba' }));
      });

      const r = await atualizarRascunhoShopee(
        deps(corrida),
        corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'Camiseta Azul' }),
      );

      expect(r.gravados).toEqual([CAMPO_RASCUNHO_SHOPEE.itemName]);
      expect(doc(db)).toMatchObject({
        item_name: 'Camiseta Azul',
        description: 'Escrita pela outra aba',
      });
      expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(2);
    });

    it('uma publicação reivindicou o rascunho depois da leitura ⇒ 409 JA_PUBLICADO; uma trava foi tomada ⇒ 409 EM_ANDAMENTO', async () => {
      for (const [extra, code] of [
        [{ item_id: ITEM_VIVO }, CODIGO_RASCUNHO_SHOPEE.jaPublicado],
        [
          { publicacaoEmCurso: travaAlheia(AGORA + 10_000) },
          CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
        ],
      ] as const) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho());
        const corrida = comEscritaConcorrente(db, CAMINHO, () => {
          db.seed(CAMINHO, rascunho(extra));
        });
        const err = await recusaDe(
          atualizarRascunhoShopee(
            deps(corrida),
            corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
          ),
        );
        expect(err.code).toBe(code);
        expect(doc(db)).toEqual(rascunho(extra));
      }
    });

    it('o rascunho foi DESCARTADO depois da leitura ⇒ o update falha NOT_FOUND, a re-leitura responde 404', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () => {
        delete db.store[CAMINHO];
      });
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(corrida),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);
      expect(doc(db)).toBeUndefined();
    });

    it(`perder ${String(TENTATIVAS_DO_RASCUNHO)} vezes ⇒ 409 CONFLITO com conflitos [] e UM aviso`, async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      // A concurrent writer that bumps the stamp after EVERY read, never
      // touching the edited field.
      const corrida = comEscritaConcorrente(
        db,
        CAMINHO,
        (n) => db.seed(CAMINHO, rascunho({ description: `outra aba ${String(n)}` })),
        true,
      );
      const err = await recusaDe(
        atualizarRascunhoShopee(
          deps(corrida),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([]);
      expect(db.writes).toEqual([]);
      expect(avisos).toHaveLength(1);
    });

    it('uma falha do update que NÃO é de precondição propaga como veio (regra 6)', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const falha = grpc(14, 'UNAVAILABLE');
      db.falhasDeUpdate.set(CAMINHO, falha);
      await expect(
        atualizarRascunhoShopee(
          deps(db),
          corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
        ),
      ).rejects.toBe(falha);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                          3 · descartarRascunhoShopee                        */
/* -------------------------------------------------------------------------- */

describe('descartarRascunhoShopee — base INTEIRA conferida + delete guardado', () => {
  it('LIVRE e a base é o gravado ⇒ apaga com a precondição, sem atestação, criacaoIncerta: false', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());

    const r = await descartarRascunhoShopee(deps(db), corpoDescartar(vista(rascunho())));

    expect(respostaDescartarRascunhoShopeeSchema.parse(r)).toEqual({
      linkDocId: RASCUNHO,
      descartado: true,
      criacaoIncerta: false,
    });
    expect(doc(db)).toBeUndefined();
    expect(db.deletes).toEqual([{ path: CAMINHO, comPrecondicao: true }]);
    // A delete is not a write in the double's logs.
    expect(db.writes).toEqual([]);
  });

  it('trava VIVA ou na carência ⇒ 409 EM_ANDAMENTO, mesmo com a atestação — o rascunho fica', async () => {
    for (const agora of [AGORA - 1, AGORA + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1]) {
      const db = new FakeDb();
      const raw = rascunho({ publicacaoEmCurso: travaAlheia(AGORA) });
      db.seed(CAMINHO, raw);
      const err = await recusaDe(
        descartarRascunhoShopee(
          deps(db, { nowMs: agora }),
          corpoDescartar(vista(raw), { confirmarCriacaoIncerta: true }),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
      expect(doc(db)).toEqual(raw);
      expect(db.deletes).toEqual([]);
    }
  });

  describe('INCERTA exige a atestação do operador (K1-6)', () => {
    const raw = rascunho({
      publicacaoEmCurso: travaAlheia(AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS),
    });

    it('sem a atestação (ausente, null ou false) ⇒ 409 CRIACAO_INCERTA, documento BYTE-intacto', async () => {
      for (const confirmar of [undefined, null, false]) {
        const db = new FakeDb();
        db.seed(CAMINHO, raw);
        const err = await recusaDe(
          descartarRascunhoShopee(
            deps(db),
            corpoDescartar(vista(raw), { confirmarCriacaoIncerta: confirmar }),
          ),
        );
        expect(err.code, String(confirmar)).toBe(CODIGO_RASCUNHO_SHOPEE.criacaoIncerta);
        expect(doc(db)).toEqual(raw);
        expect(db.deletes).toEqual([]);
      }
    });

    it('com confirmarCriacaoIncerta: true ⇒ apaga, criacaoIncerta: true', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, raw);
      const r = await descartarRascunhoShopee(
        deps(db),
        corpoDescartar(vista(raw), { confirmarCriacaoIncerta: true }),
      );
      expect(r).toEqual({ linkDocId: RASCUNHO, descartado: true, criacaoIncerta: true });
      expect(doc(db)).toBeUndefined();
    });

    it('criacaoIncertaDesde sem trava também é incerta', async () => {
      const db = new FakeDb();
      const incerto = rascunho({ criacaoIncertaDesde: AGORA - 1_000 });
      db.seed(CAMINHO, incerto);
      const err = await recusaDe(descartarRascunhoShopee(deps(db), corpoDescartar(vista(incerto))));
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.criacaoIncerta);
    });
  });

  describe('a base do descarte (K1-13)', () => {
    it('o gravado mudou desde a abertura ⇒ 409 CONFLITO, nada apagado', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho({ category_id: 100_020 }));
      const err = await recusaDe(
        descartarRascunhoShopee(deps(db), corpoDescartar(vista(rascunho()))),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([{ campo: CAMPO_RASCUNHO_SHOPEE.categoryId, atual: 100_020 }]);
      expect(doc(db)).toBeDefined();
      expect(db.deletes).toEqual([]);
    });

    it('⛔ a MARCA mudou desde a abertura (outra marca; "Sem marca" contra não escolhida) ⇒ 409 CONFLITO, nada apagado — quase-par: só o NOME da mesma marca ⇒ apaga', async () => {
      const marca77 = { brand_id: 77, original_brand_name: 'Marca X' };
      const casos: [visto: Record<string, unknown>, gravado: Record<string, unknown>][] = [
        // `rascunho()` holds brand 0 ("Sem marca", a choice); another tab picked 77.
        [rascunho(), rascunho(marca77)],
        // brand 0 is NOT "not chosen": seen null, stored 0.
        [rascunho({ brand_id: null }), rascunho()],
      ];
      for (const [visto, gravado] of casos) {
        const db = new FakeDb();
        db.seed(CAMINHO, gravado);
        const err = await recusaDe(descartarRascunhoShopee(deps(db), corpoDescartar(vista(visto))));
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
        expect(err.conflitos).toEqual([
          { campo: CAMPO_RASCUNHO_SHOPEE.marca, atual: camposDoRascunhoShopee(gravado).marca },
        ]);
        expect(doc(db)).toEqual(gravado);
        expect(db.deletes).toEqual([]);
      }

      // The name FOLLOWS the id: the same brand under an older name is what the operator saw.
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho(marca77));
      const visto = rascunho({ ...marca77, original_brand_name: 'Nome antigo' });
      expect(await descartarRascunhoShopee(deps(db), corpoDescartar(vista(visto)))).toEqual({
        linkDocId: RASCUNHO,
        descartado: true,
        criacaoIncerta: false,
      });
      expect(db.deletes).toEqual([{ path: CAMINHO, comPrecondicao: true }]);
    });

    it('⛔ os ATRIBUTOS mudaram desde a abertura (P6) ⇒ 409 CONFLITO nomeando attributes, nada apagado — quase-par: a base com os atuais ⇒ apaga', async () => {
      const gravado = rascunho({ attributes: ATRIBUTOS_DE_OUTRA_ABA });
      const db = new FakeDb();
      db.seed(CAMINHO, gravado);
      const err = await recusaDe(
        descartarRascunhoShopee(
          deps(db),
          corpoDescartar(vista(rascunho({ attributes: ATRIBUTOS }))),
        ),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([
        { campo: CAMPO_RASCUNHO_SHOPEE.attributes, atual: ATRIBUTOS_DE_OUTRA_ABA },
      ]);
      expect(doc(db)).toEqual(gravado);
      expect(db.deletes).toEqual([]);

      expect(
        (await descartarRascunhoShopee(deps(db), corpoDescartar(vista(gravado)))).descartado,
      ).toBe(true);
      expect(db.deletes).toEqual([{ path: CAMINHO, comPrecondicao: true }]);
    });

    it('uma edição CONCORRENTE depois da leitura ⇒ o delete guardado recusa, a re-leitura vê o conflito — a edição sobrevive', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () => {
        db.seed(CAMINHO, rascunho({ item_name: 'Editado em outra aba' }));
      });

      const err = await recusaDe(
        descartarRascunhoShopee(deps(corrida), corpoDescartar(vista(rascunho()))),
      );

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(err.conflitos).toEqual([
        { campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Editado em outra aba' },
      ]);
      expect(doc(db)?.item_name).toBe('Editado em outra aba');
      expect(db.deletes).toEqual([]);
    });

    it('a publicação reivindicou o rascunho depois da leitura ⇒ 409 JA_PUBLICADO, o anúncio fica', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () => {
        db.seed(CAMINHO, rascunho({ item_id: ITEM_VIVO }));
      });
      const err = await recusaDe(
        descartarRascunhoShopee(deps(corrida), corpoDescartar(vista(rascunho()))),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.jaPublicado);
      expect(doc(db)?.item_id).toBe(ITEM_VIVO);
    });

    it("description '' gravada contra base '' ⇒ apaga; ⛔ contra base null ⇒ 409", async () => {
      const legado = rascunho({ description: '' });
      const db = new FakeDb();
      db.seed(CAMINHO, legado);
      expect(
        (await descartarRascunhoShopee(deps(db), corpoDescartar(vista(legado)))).descartado,
      ).toBe(true);

      const db2 = new FakeDb();
      db2.seed(CAMINHO, legado);
      const err = await recusaDe(
        descartarRascunhoShopee(deps(db2), corpoDescartar({ ...vista(legado), description: null })),
      );
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
      expect(doc(db2)).toEqual(legado);
    });
  });

  it('ausente ⇒ 404; de OUTRA conta ⇒ 404; um ANÚNCIO ⇒ 409 JA_PUBLICADO — nada apagado', async () => {
    const db = new FakeDb();
    let err = await recusaDe(descartarRascunhoShopee(deps(db), corpoDescartar(vista(rascunho()))));
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);

    const alheio = rascunho({ contaProdutoShopeeOuterRef: `documents/integracao/${OUTRA_CONTA}` });
    db.seed(CAMINHO, alheio);
    err = await recusaDe(descartarRascunhoShopee(deps(db), corpoDescartar(vista(alheio))));
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.inexistente);

    const anuncio = rascunho({ item_id: ITEM_VIVO });
    db.seed(CAMINHO, anuncio);
    err = await recusaDe(descartarRascunhoShopee(deps(db), corpoDescartar(vista(anuncio))));
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.jaPublicado);
    expect(db.deletes).toEqual([]);
  });

  it(`perder ${String(TENTATIVAS_DO_RASCUNHO)} vezes ⇒ 409 CONFLITO com conflitos [] — nada apagado`, async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const corrida = comEscritaConcorrente(db, CAMINHO, () => db.seed(CAMINHO, rascunho()), true);
    const err = await recusaDe(
      descartarRascunhoShopee(deps(corrida), corpoDescartar(vista(rascunho()))),
    );
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    expect(err.conflitos).toEqual([]);
    expect(doc(db)).toBeDefined();
    expect(avisos).toHaveLength(1);
  });

  it('uma falha do delete que NÃO é de precondição propaga como veio (regra 6)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const falha = grpc(14, 'UNAVAILABLE');
    db.falhasDeDelete.set(CAMINHO, falha);
    await expect(descartarRascunhoShopee(deps(db), corpoDescartar(vista(rascunho())))).rejects.toBe(
      falha,
    );
    expect(doc(db)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                       4 · corpoDaRecusaDeRascunhoShopee                     */
/* -------------------------------------------------------------------------- */

describe('corpoDaRecusaDeRascunhoShopee — o corpo, POR NOME', () => {
  it('as chaves de detalhe só existem quando a recusa as carrega — ausente é "não se aplica"', () => {
    const simples = new RecusaDeRascunhoShopeeError({
      status: 409,
      code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
      linkDocId: RASCUNHO,
      mensagem: 'm',
    });
    // STRICT: a detail key present with `undefined` is not "absent" to a reader
    // of the object, even if `JSON.stringify` would drop it.
    expect(corpoDaRecusaDeRascunhoShopee(simples)).toStrictEqual({
      error: 'm',
      code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
      linkDocId: RASCUNHO,
    });

    const cheia = new RecusaDeRascunhoShopeeError({
      status: 409,
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      linkDocId: RASCUNHO,
      mensagem: 'm',
      conflitos: [],
      aguardarMs: 0,
    });
    // `[]` and `0` are VALUES, not absences.
    expect(corpoDaRecusaDeRascunhoShopee(cheia)).toStrictEqual({
      error: 'm',
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      linkDocId: RASCUNHO,
      conflitos: [],
      aguardarMs: 0,
    });
  });

  it('a recusa NÃO é um ShopeeError e não carrega nenhum conteúdo do rascunho na mensagem', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ item_name: 'Título SECRETO de outra aba' }));
    const err = await recusaDe(
      atualizarRascunhoShopee(
        deps(db),
        corpoAtualizar({ item_name: 'Camiseta do rascunho' }, { item_name: 'X' }),
      ),
    );
    expect(err).not.toBeInstanceOf(ShopeeError);
    expect(err.message).toContain(RASCUNHO);
    expect(err.message).not.toContain('SECRETO');
  });
});

/* -------------------------------------------------------------------------- */
/*                5 · ONE projection, ONE comparison (#1369, P6)               */
/* -------------------------------------------------------------------------- */

/**
 * Spelled in FRAGMENTS, so this file never names them either (the
 * `statusAnuncio.test.ts` precedent).
 */
const COMPARACOES_DE_MAO = [
  ['JSON', '.stringify('].join(''),
  ['deep', 'Equal'].join(''),
  ['values', 'Equal'].join(''),
  ['isDeep', 'StrictEqual'].join(''),
];
const LEITURAS_CRUAS_DE_ATRIBUTOS = [
  ['lerAtributos', 'ArmazenadosShopee'].join(''),
  ['attribute', '_value_list'].join(''),
];

describe('rascunho.ts decide com o módulo do @delfrance/schemas, nunca com uma cópia', () => {
  it('nenhuma comparação feita à mão e nenhuma leitura crua dos atributos: só a projeção e a comparação de shopeeRascunho.ts', () => {
    // Every value the route compares is canonical on BOTH sides by construction
    // (the base's parse and the projection fix the key order), so a hand-rolled
    // serialising compare would pass every behavioural test here — and drift the
    // day either side changes. Only the raw text can say it is not there.
    const fonte = readFileSync(fileURLToPath(new URL('./rascunho.ts', import.meta.url)), 'utf8');

    // ÂNCORA: the file read is the module, and it calls THE pair.
    expect(fonte).toContain('export async function atualizarRascunhoShopee(');
    expect(fonte).toContain('mesmoValorDoRascunhoShopee');
    expect(fonte).toContain('mesmoValorGravadoDoRascunhoShopee(');
    expect(fonte).toContain('camposDoRascunhoShopee(');
    expect(fonte).toContain('camposDaBaseDoRascunhoShopee(');

    for (const proibido of [...COMPARACOES_DE_MAO, ...LEITURAS_CRUAS_DE_ATRIBUTOS]) {
      expect(fonte, `rascunho.ts nomeia ${proibido}`).not.toContain(proibido);
    }
  });
});
