/**
 * Synthetic Loja Integrada ORDERS and a scripted platform, **for tests only**
 * (the `fakeDb.ts` rule: nothing outside a `*.test.ts` imports this) — shared by
 * the importer's offline suite (`pedidos/importarPedido.test.ts`) and its
 * emulator suite (`pedidos/importarPedido.firestore.test.ts`).
 *
 * Every value is invented, in the shape the sanitized captures show (money as
 * decimal strings, line prices with four decimals, naive stamps). Nothing here
 * comes from a capture, and nothing reaches the network: the platform is a
 * `fetch` the context's client is handed (D17).
 */
import { URL_BASE_LI } from '@delfrance/integrations-loja-integrada';

import type { DocData } from './fakeDb';

/** The synthetic order's numero (its pedido id is the digest of it). */
export const NUMERO_LI = 9001;

/** A line's write key, the shipment's and the payment's (positive ids). */
export const ID_ITEM_LI = 501;
export const ID_ENVIO_LI = 801;
export const ID_PAGAMENTO_LI = 601;

/** The Loja Integrada produto id the line names, and its parent's. */
export const ID_PRODUTO_LI = 7001;
export const ID_PRODUTO_PAI_LI = 7000;

/** The line's SKU — text that only LOOKS numeric (14 digits). */
export const SKU_LI = '12345678901234';

/** The shipping method's two key parts (invented, neutral), and the key step 20 builds of them. */
export const FORMA_ENVIO_LI = {
  id: 4242,
  code: 'TRANSP-1',
  nome: 'Gateway de teste',
  tipo: 'Transportadora',
} as const;
export const CHAVE_FORMA_ENVIO_LI = '4242---TRANSP-1';

/** A check-digit-valid CPF, the textbook example (never a person's). */
export const CPF_VALIDO_LI = '529.982.247-25';

/** A naive stamp `n` hours after the order's creation, canonical (26 characters). */
export function carimboLi(horas: number, micros = 0): string {
  const base = Date.UTC(2027, 0, 10, 10, 0, 0) + horas * 3_600_000;
  const d = new Date(base);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${String(d.getUTCFullYear())}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` +
    `.${String(micros).padStart(6, '0')}`
  );
}

/** The order detail as the platform answers it — a paid PIX order by default. */
export function pedidoLiBruto(over: DocData = {}): DocData {
  return {
    id: 0,
    numero: NUMERO_LI,
    situacao: { codigo: 'pedido_pago', id: 4, aprovado: true, cancelado: false, final: false },
    data_criacao: carimboLi(0),
    data_modificacao: carimboLi(2),
    valor_total: '114.80',
    valor_subtotal: '100.00',
    valor_envio: '14.80',
    valor_desconto: '0.00',
    cliente: {
      id: 1,
      nome: 'Comprador de Teste',
      razao_social: null,
      cpf: null,
      cnpj: null,
      email: 'comprador@example.com',
      telefone_celular: '11999990000',
      telefone_principal: null,
    },
    endereco_entrega: {
      nome: 'Recebedor de Teste',
      razao_social: null,
      cpf: null,
      cnpj: null,
      cep: '01310-100',
      endereco: 'Rua de Teste',
      numero: '100',
      complemento: null,
      bairro: 'Centro',
      cidade: 'Sao Paulo',
      estado: 'SP',
      pais: 'Brasil',
      referencia: null,
    },
    itens: [
      {
        id: ID_ITEM_LI,
        linha: 1,
        sku: SKU_LI,
        nome: 'Produto de Teste',
        quantidade: '2.000',
        preco_venda: '50.0000',
        preco_subtotal: '100.0000',
        preco_custo: null,
        produto: `/api/v1/produto/${String(ID_PRODUTO_LI)}`,
        produto_pai: `/api/v1/produto/${String(ID_PRODUTO_PAI_LI)}`,
      },
    ],
    envios: [
      {
        id: ID_ENVIO_LI,
        objeto: null,
        link_rastreio: null,
        prazo: 5,
        valor: '14.80',
        data_criacao: carimboLi(0),
        data_modificacao: carimboLi(0),
        forma_envio: { ...FORMA_ENVIO_LI },
      },
    ],
    pagamentos: [
      {
        id: ID_PAGAMENTO_LI,
        valor: '114.80',
        valor_pago: '114.80',
        pagamento_tipo: 'instantPayment',
        // The codigo is the provider's vocabulary token the forma table maps; the id is invented.
        forma_pagamento: { id: 1, codigo: 'proxy-pagali-v2-pix', nome: 'PIX' },
        parcelamento: {},
        bandeira: null,
        authorization_code: null,
      },
    ],
    id_anymarket: null,
    cliente_obs: null,
    utm_campaign: null,
    ...over,
  };
}

/** One situação-history row of the synthetic order. */
export function linhaHistoricoLi(
  id: number,
  data: string,
  codigo: string,
  anterior: string | null,
  numero: number = NUMERO_LI,
): DocData {
  return {
    id,
    numero,
    data,
    situacao: { codigo },
    situacao_anterior: anterior === null ? null : { codigo: anterior },
  };
}

/** The usual history of a paid order: 9 → 2 → 4. */
export function historicoPagoLi(numero: number = NUMERO_LI): DocData[] {
  return [
    linhaHistoricoLi(1, carimboLi(0, 100), 'aguardando_pagamento', 'pedido_efetuado', numero),
    linhaHistoricoLi(2, carimboLi(1), 'pedido_pago', 'aguardando_pagamento', numero),
  ];
}

/** What the scripted platform answers for one request. */
export interface RespostaRoteirizadaLi {
  readonly status: number;
  readonly corpo: unknown;
}

export interface RoteiroLi {
  /** The detail of each numero (a function, so a test can change it between imports). */
  readonly pedidos: Map<number, () => RespostaRoteirizadaLi | DocData>;
  /** The history rows of each numero (one page). */
  readonly historicos: Map<number, () => DocData[]>;
  /** The `id_externo` GET's answer per external id. */
  readonly produtosPorIdExterno?: Map<string, () => RespostaRoteirizadaLi>;
  /**
   * Runs right before the platform answers a produto GET: the window between the
   * pedido read (import step 3) and the batch (step 10), where a concurrent
   * writer lands.
   */
  readonly antesDoProduto?: (idExterno: string) => Promise<void> | void;
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ehResposta(v: unknown): v is RespostaRoteirizadaLi {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { status?: unknown }).status === 'number' &&
    'corpo' in v
  );
}

/**
 * A scripted Loja Integrada: the three GETs of the import, from `roteiro`.
 * Anything else answers 500, and every URL is recorded — a test asserts the
 * calls it expected, and that nothing reached the real platform.
 */
export function plataformaLi(roteiro: RoteiroLi): {
  readonly fetch: typeof globalThis.fetch;
  readonly urls: string[];
} {
  const urls: string[] = [];
  const base = new URL(URL_BASE_LI);
  const fetch: typeof globalThis.fetch = async (input) => {
    const texto = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(texto);
    const url = new URL(texto);
    if (url.origin !== base.origin) return json(500, { erro: 'origem inesperada' });
    const caminho = url.pathname.slice(base.pathname.replace(/\/$/, '').length);

    const detalhe = /^\/v1\/pedido\/([0-9]+)\/$/.exec(caminho);
    if (detalhe !== null) {
      const resposta = roteiro.pedidos.get(Number(detalhe[1]))?.();
      if (resposta === undefined) return json(404, { erro: 'nao encontrado' });
      return ehResposta(resposta) ? json(resposta.status, resposta.corpo) : json(200, resposta);
    }
    if (caminho === '/v1/situacao_historico/search/') {
      const numero = Number(url.searchParams.get('numero'));
      const linhas = roteiro.historicos.get(numero)?.() ?? [];
      return json(200, {
        meta: { limit: 50, offset: 0, next: null, previous: null, total_count: linhas.length },
        objects: linhas,
      });
    }
    const produto = /^\/v1\/produto\/([0-9]+)\/$/.exec(caminho);
    if (produto !== null && url.searchParams.get('id_externo') === '1') {
      const id = produto[1]!;
      await roteiro.antesDoProduto?.(id);
      const resposta = roteiro.produtosPorIdExterno?.get(id)?.();
      if (resposta === undefined) return json(404, { erro: 'nao encontrado' });
      return json(resposta.status, resposta.corpo);
    }
    return json(500, { erro: 'rota nao roteirizada' });
  };
  return { fetch, urls };
}
