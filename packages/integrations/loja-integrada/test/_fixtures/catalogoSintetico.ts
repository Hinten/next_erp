/**
 * INVENTED catalogue bodies, shaped like the owner's catalogue capture C9: the
 * same keys and the same leaf TYPES, with every `null | string` alternative the
 * capture showed present at least once. No captured value is here: every id,
 * name, slug, text and URI is fabricated, and every URL host is `.invalid`.
 *
 * What the capture recorded, leaf by leaf (types only, every request a `GET`
 * on the slash path, every answer a 200):
 *
 *  - `meta`: `limit`, `offset`, `total_count` numbers; `previous` null; `next`
 *    a string while more rows follow, else null;
 *  - categoria row: `id` number, `id_externo` null, `categoria_pai` null or a
 *    string, `descricao` null or a string, `nome`, `resource_uri`, `seo` null or
 *    a string, `url`;
 *  - marca row: `id`, `ativo` boolean, `id_externo` null, `apelido`,
 *    `descricao` null or a string, `nome`, `destaque` boolean, `resource_uri`,
 *    `imagem` null or a string;
 *  - grade row: `id`, `id_externo` null, `nome`, `nome_visivel` a string or
 *    null, `specification_id` null, `resource_uri`;
 *  - grade detail: the grade row's keys plus `variacoes[]`, each `grade` (a URI
 *    string), `id`, `id_externo` null, `nome`, `resource_uri`.
 *
 * ⚠️ The URI strings are placeholders. The capture says they are strings, not
 * which form the categoria ones take (they did not match `/api/v1/…`), and the
 * package reads no id from any of them: ids come from `id`. The tests also hand
 * a categoria row an absolute URL as its parent, to pin that the package never
 * refuses a page over a URI's form.
 */

/** One categoria row; `pai` is the parent's URI or `null` for a root. */
export function categoriaSintetica(id: number, pai: string | null, variante: number) {
  return {
    id,
    id_externo: null,
    categoria_pai: pai,
    descricao: variante % 3 === 0 ? null : `Descrição sintética ${String(id)}`,
    nome: `Categoria sintética ${String(id)}`,
    resource_uri: `/api/v1/categoria/${String(id)}`,
    seo: variante % 4 === 0 ? null : `/api/v1/seo/${String(id + 500_000)}`,
    url: `https://loja.invalid/categoria-${String(id)}`,
  };
}

/** A synthetic categoria page: `quantos` rows from `primeiroId`, every third a root. */
export function paginaCategoriasSintetica(
  offset: number,
  next: string | null,
  primeiroId: number,
  quantos: number,
) {
  const objects = Array.from({ length: quantos }, (_, i) => {
    const id = primeiroId + i;
    const pai = i % 3 === 0 ? null : `/api/v1/categoria/${String(primeiroId)}`;
    return categoriaSintetica(id, pai, i);
  });
  return {
    meta: { limit: 50, offset, total_count: 57, previous: null, next },
    objects,
  };
}

export const marcasSinteticas = {
  meta: { limit: 50, offset: 0, total_count: 2, previous: null, next: null },
  objects: [
    {
      id: 7001,
      ativo: true,
      id_externo: null,
      apelido: 'marca-sintetica-um',
      descricao: null,
      nome: 'Marca sintética um',
      destaque: false,
      resource_uri: '/api/v1/marca/7001',
      imagem: null,
    },
    {
      id: 7002,
      ativo: false,
      id_externo: null,
      apelido: 'marca-sintetica-dois',
      descricao: 'Texto sintético.',
      nome: 'Marca sintética dois',
      destaque: true,
      resource_uri: '/api/v1/marca/7002',
      imagem: 'https://imagens.invalid/marca-7002.png',
    },
  ],
} as const;

export const gradesSinteticas = {
  meta: { limit: 50, offset: 0, total_count: 3, previous: null, next: null },
  objects: [
    {
      id: 900001,
      id_externo: null,
      nome: 'Grade sintética um',
      nome_visivel: 'Visível um',
      specification_id: null,
      resource_uri: '/api/v1/grades/900001',
    },
    {
      id: 900002,
      id_externo: null,
      nome: 'Grade sintética dois',
      nome_visivel: null,
      specification_id: null,
      resource_uri: '/api/v1/grades/900002',
    },
    {
      id: 8001,
      id_externo: null,
      nome: 'Grade sintética da plataforma',
      nome_visivel: 'Visível plataforma',
      specification_id: null,
      resource_uri: '/api/v1/grades/8001',
    },
  ],
} as const;

/** One grade detail, with `quantas` options of its own grade. */
export function gradeDetalheSintetica(id: number, quantas: number) {
  return {
    id,
    id_externo: null,
    nome: `Grade sintética ${String(id)}`,
    nome_visivel: `Visível ${String(id)}`,
    specification_id: null,
    resource_uri: `/api/v1/grades/${String(id)}`,
    variacoes: Array.from({ length: quantas }, (_, i) => {
      const opcao = id * 100 + i + 1;
      return {
        grade: `/api/v1/grades/${String(id)}`,
        id: opcao,
        id_externo: null,
        nome: `Opção ${String(i + 1)}`,
        resource_uri: `/api/v1/grade/${String(id)}/variacao/${String(opcao)}`,
      };
    }),
  };
}
