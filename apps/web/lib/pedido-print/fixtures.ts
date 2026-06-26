/**
 * Hand-built {@link PedidoPrintModel} fixtures — decoupled from Firestore — for
 * the rendering tests and the dev print-preview page. They cover the layouts
 * the user asked to eyeball: a few-item page, a many-item order (pagination), a
 * kit order, a no-photo product and an overdue-dispatch order.
 *
 * Photos use tiny inline SVG data URIs so the sheets render offline (no network,
 * no Storage CORS) — real product photos come from `buildPrintModel`.
 */
import type { PedidoPrintModel, PrintItem, PrintKitComponente } from './model';

/** A 1×1-ish colored square as a data URI, so `<img>` resolves without network. */
function swatch(hex: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%23${hex}'/></svg>`;
  return `data:image/svg+xml,${svg}`;
}

const SWATCHES = ['e8590c', '1971c2', '2f9e44', 'd6336c', '6741d9', '0c8599', 'e67700', '343a40'];

/** A fixed "past" dispatch instant (µs) so the overdue marker is deterministic. */
export const OVERDUE_PRAZO_MICROS = Date.UTC(2020, 0, 15) * 1000;
/** A fixed creation instant (µs). */
const CREATED_MICROS = Date.UTC(2026, 5, 20, 13, 30) * 1000;

function makeItem(i: number, overrides: Partial<PrintItem> = {}): PrintItem {
  const preco = 49.9 + i * 10;
  const qtd = (i % 3) + 1;
  return {
    produtoId: `prod-${i}`,
    sku: `SKU-${String(i).padStart(3, '0')}`,
    nome: `Produto de exemplo ${i}`,
    variacoesText: i % 2 === 0 ? 'Tamanho:M/Cor:Azul' : null,
    fotoUrl: swatch(SWATCHES[i % SWATCHES.length]!),
    quantidade: qtd,
    precoUnitario: preco,
    descontoUnitario: 0,
    subtotal: preco * qtd,
    estoqueText: String(((i * 7) % 120) - 5),
    localizacao: `A-${(i % 9) + 1}-${(i % 5) + 1}`,
    isKit: false,
    componentes: [],
    ...overrides,
  };
}

function kitComponent(i: number): PrintKitComponente {
  return {
    produtoId: `comp-${i}`,
    sku: `CMP-${String(i).padStart(3, '0')}`,
    nome: `Componente ${i}`,
    variacoesText: i === 1 ? 'Cor:Preto' : null,
    fotoUrl: swatch(SWATCHES[(i + 3) % SWATCHES.length]!),
    quantidade: i * 2,
    estoqueText: i === 2 ? '99+' : String(i * 4),
    localizacao: `B-${i}-${i}`,
  };
}

export function sampleModel(overrides: Partial<PedidoPrintModel> = {}): PedidoPrintModel {
  return {
    pedidoId: 'pedido-demo',
    numero: '100245',
    estadoLabel: 'Pago',
    timestampMicros: CREATED_MICROS,
    observacoesInternas: 'Cliente pediu embrulho para presente.',
    subtotal: 0,
    descontoTotal: 0,
    total: 0,
    hasDesconto: false,
    totalQuantidadeItens: 0,
    prazoDespachoMicros: Date.UTC(2026, 5, 25) * 1000,
    cliente: {
      nome: 'Maria Oliveira de Souza',
      cpfCnpj: '12345678900',
      idEstrangeiro: null,
      ie: '110042490114',
      imun: null,
      email: 'maria.souza@example.com',
      telefone: '11987654321',
      observacoesInternas: 'Comprou antes pelo WhatsApp.',
    },
    enderecoFiscal: {
      logradouro: 'Rua das Flores',
      numero: '1000',
      complemento: 'Apto 52',
      bairro: 'Centro',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01310100',
      recebedorNome: null,
    },
    enderecoEntrega: {
      logradouro: 'Avenida Brasil',
      numero: '2000',
      complemento: null,
      bairro: 'Jardim América',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01430000',
      recebedorNome: 'Maria O. de Souza',
    },
    frete: {
      tipoNome: 'Melhor Envio',
      modalidadeLabel: 'Contratação por conta do Emitente (CIF)',
      servicoMelhorEnvio: 'PAC',
      transportadora: { nome: 'Correios', cnpj: '34028316000103' },
      veiculo: null,
      valorCobrado: 24.9,
      ehReverso: false,
      dataPrevisaoEntregaMicros: Date.UTC(2026, 5, 28) * 1000,
      temSeguro: true,
      valorSeguro: 150,
    },
    filial: {
      nome: 'Veste France',
      email: 'contato@vestefrance.com.br',
      telefone: '1133334444',
    },
    integracaoNome: 'Balcão',
    vendedorNome: 'João Vendedor',
    items: [],
    ...overrides,
  };
}

/** Recompute the model totals from its items (so fixtures stay self-consistent). */
function withTotals(model: PedidoPrintModel): PedidoPrintModel {
  const subtotal = model.items.reduce((s, it) => s + it.subtotal, 0);
  const itemCount = model.items.reduce(
    (n, it) =>
      n + (it.isKit ? it.componentes.reduce((c, k) => c + k.quantidade, 0) : it.quantidade),
    0,
  );
  const total = subtotal - model.descontoTotal + (model.frete?.valorCobrado ?? 0);
  return {
    ...model,
    subtotal,
    total,
    totalQuantidadeItens: itemCount,
    hasDesconto: model.items.some((it) => it.descontoUnitario > 0),
  };
}

/** A short order — one page. */
export const FEW_ITEMS_MODEL = withTotals(
  sampleModel({ items: [makeItem(1), makeItem(2, { descontoUnitario: 5 }), makeItem(3)] }),
);

/** A long order — forces multi-page pagination in both prints. */
export const MANY_ITEMS_MODEL = withTotals(
  sampleModel({
    numero: '100246',
    items: Array.from({ length: 42 }, (_, i) => makeItem(i + 1)),
  }),
);

/** An order with a kit line that expands into component sub-rows (comum print). */
export const KIT_MODEL = withTotals(
  sampleModel({
    numero: '100247',
    items: [
      makeItem(1, {
        nome: 'Kit Verão Completo',
        isKit: true,
        estoqueText: '-',
        componentes: [kitComponent(1), kitComponent(2), kitComponent(3)],
      }),
      makeItem(2),
    ],
  }),
);

/** An order whose product has no photo (placeholder path). */
export const NO_PHOTO_MODEL = withTotals(
  sampleModel({
    numero: '100248',
    items: [makeItem(1, { fotoUrl: null }), makeItem(2, { fotoUrl: null, variacoesText: null })],
  }),
);

/** An order past its dispatch deadline — the comum print shows the red marker. */
export const OVERDUE_DISPATCH_MODEL = withTotals(
  sampleModel({
    numero: '100249',
    prazoDespachoMicros: OVERDUE_PRAZO_MICROS,
    items: [makeItem(1), makeItem(2)],
  }),
);

/** All single-pedido scenarios, for the preview page. */
export const PREVIEW_MODELS: ReadonlyArray<{ label: string; model: PedidoPrintModel }> = [
  { label: 'Poucos itens', model: FEW_ITEMS_MODEL },
  { label: 'Muitos itens (paginação)', model: MANY_ITEMS_MODEL },
  { label: 'Pedido com kit', model: KIT_MODEL },
  { label: 'Sem foto', model: NO_PHOTO_MODEL },
  { label: 'Despacho atrasado', model: OVERDUE_DISPATCH_MODEL },
];
