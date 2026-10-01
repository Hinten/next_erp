import { z } from 'zod';
import { roundReais } from '@delfrance/core/money';
import { INTEGRACAO_TIPO, type Integracao } from '../integracao';
import { ESTADO_PEDIDO } from '../pedido/collection/pedido';
import { ESTADO_FRETE, ESTADOS_FRETE_NAO_POSTADO } from './frete';

export type QueryScalar = string | number | boolean | null;
export type QueryPredicate =
  | { field: string; op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; value: QueryScalar }
  | { field: string; op: 'in'; value: readonly QueryScalar[] }
  | { and: readonly QueryPredicate[] }
  | { or: readonly QueryPredicate[] };

/** Translate the same predicate into client pipelines, Admin pipelines or classic filters. */
export function mapQueryPredicate<T>(
  predicate: QueryPredicate,
  adapter: {
    leaf: (predicate: Extract<QueryPredicate, { field: string }>) => T;
    and: (children: T[]) => T;
    or: (children: T[]) => T;
  },
): T {
  if ('field' in predicate) return adapter.leaf(predicate);
  const children = 'and' in predicate ? predicate.and : predicate.or;
  if (children.length === 0) throw new RangeError('A query predicate must have children.');
  const mapped = children.map((child) => mapQueryPredicate(child, adapter));
  return 'and' in predicate ? adapter.and(mapped) : adapter.or(mapped);
}

const VENDA_TIPOS = new Set<Integracao['tipo']>([
  INTEGRACAO_TIPO.mercadoLivre,
  INTEGRACAO_TIPO.lojaIntegrada,
  INTEGRACAO_TIPO.magalu,
  INTEGRACAO_TIPO.shopee,
  INTEGRACAO_TIPO.amazon,
  INTEGRACAO_TIPO.balcao,
]);
export function canalInicioElegivel(canal: Pick<Integracao, 'ativo' | 'tipo'>): boolean {
  return canal.ativo && VENDA_TIPOS.has(canal.tipo);
}

export const DESPACHO_METRICAS = {
  faltam: 'Faltam',
  atrasados: 'Atrasados',
  despachados: 'Despachados',
  faltaImprimir: 'Falta Imprimir',
  proximosDias: 'Próximos Dias',
  proximosDiasSemImpressao: 'Próx. Dias Sem Impressão',
  total: 'Total',
} as const;
export const despachoMetricaSchema = z.enum([
  'faltam',
  'atrasados',
  'despachados',
  'faltaImprimir',
  'proximosDias',
  'proximosDiasSemImpressao',
  'total',
]);
export type DespachoMetrica = z.infer<typeof despachoMetricaSchema>;
export const inicioDespachoSchema = z
  .strictObject({
    canalId: z
      .string()
      .min(1)
      .max(1500)
      .regex(/^[^/]+$/),
    metrica: despachoMetricaSchema,
    inicioUs: z.number().int().nonnegative().safe(),
    fimUs: z.number().int().nonnegative().safe(),
  })
  .refine((value) => value.inicioUs <= value.fimUs, 'Período inválido.');
export type InicioDespacho = z.infer<typeof inicioDespachoSchema>;

export function parseInicioDespacho(value: unknown): InicioDespacho | null {
  if (typeof value !== 'string' || value.length > 4000) return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = inicioDespachoSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** Operator-local calendar, including the legacy Saturday–Monday window. */
export function inicioDespachoJanela(now: Date): Pick<InicioDespacho, 'inicioUs' | 'fimUs'> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay();
  const weekend = day === 6 || day === 0 || day === 1;
  if (weekend) start.setDate(start.getDate() - (day === 6 ? 0 : day === 0 ? 1 : 2));
  const end = new Date(start);
  end.setDate(end.getDate() + (weekend ? 3 : 1));
  return { inicioUs: start.getTime() * 1000, fimUs: (end.getTime() - 1) * 1000 };
}

export function inicioCheckoutJanela(now: Date) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    diaMs: day.getTime(),
    semanaMs: week.getTime(),
    mesMs: month.getTime(),
    inicioMs: Math.min(week.getTime(), month.getTime()),
    fimMs: now.getTime(),
  };
}
export type InicioCheckoutJanela = ReturnType<typeof inicioCheckoutJanela>;

const DISPATCHED = [
  ESTADO_FRETE.empacotado,
  ESTADO_FRETE.checkFinalizado,
  ESTADO_FRETE.aguardandoPostagem,
  ESTADO_FRETE.aguardandoRetirada,
];
const prazo = (op: 'lt' | 'lte' | 'gt' | 'gte', value: number): QueryPredicate => ({
  field: 'freteInicial.prazoDespacho',
  op,
  value,
});
const pending: QueryPredicate = {
  field: 'freteInicial.estado',
  op: 'in',
  value: [...ESTADOS_FRETE_NAO_POSTADO],
};

/** These conditions are shared by conditional counts and every destination link. */
export function inicioDespachoCondicao({
  metrica,
  inicioUs,
  fimUs,
}: InicioDespacho): QueryPredicate {
  const dispatched: QueryPredicate = {
    and: [{ field: 'freteInicial.estado', op: 'in', value: DISPATCHED }, prazo('gte', inicioUs)],
  };
  switch (metrica) {
    case 'faltam':
      return { and: [pending, prazo('gte', inicioUs), prazo('lte', fimUs)] };
    case 'atrasados':
      return { and: [pending, prazo('lt', inicioUs)] };
    case 'despachados':
      return dispatched;
    case 'faltaImprimir':
      return {
        and: [pending, prazo('lte', fimUs), { field: 'foiImpresso', op: 'eq', value: false }],
      };
    case 'proximosDias':
      return { and: [pending, prazo('gt', fimUs)] };
    case 'proximosDiasSemImpressao':
      return {
        and: [pending, prazo('gt', fimUs), { field: 'foiImpresso', op: 'eq', value: false }],
      };
    case 'total':
      return { or: [{ and: [pending, prazo('lte', fimUs)] }, dispatched] };
  }
}
export function inicioDespachoBase(canalId: string): QueryPredicate {
  return {
    and: [
      { field: 'ehSaida', op: 'eq', value: true },
      { field: 'estado', op: 'eq', value: ESTADO_PEDIDO.pago },
      {
        field: 'integracaoPedidoOuterRef',
        op: 'in',
        value: [`documents/integracao/${canalId}`, `integracao/${canalId}`],
      },
    ],
  };
}
export function inicioDespachoPredicado(value: InicioDespacho): QueryPredicate {
  return { and: [inicioDespachoBase(value.canalId), inicioDespachoCondicao(value)] };
}
/** Source union: pending orders, plus prepared orders from the window's start. */
export function inicioDespachoFonte(value: Omit<InicioDespacho, 'metrica'>): QueryPredicate {
  return {
    and: [
      inicioDespachoBase(value.canalId),
      {
        or: [
          inicioDespachoCondicao({ ...value, metrica: 'total' }),
          inicioDespachoCondicao({ ...value, metrica: 'proximosDias' }),
        ],
      },
    ],
  };
}
export function inicioDespachoHref(value: InicioDespacho): string {
  return `/pedidos?${new URLSearchParams({ inicioDespacho: `eq:${JSON.stringify(inicioDespachoSchema.parse(value))}` })}`;
}
export function inicioVendasPredicado(
  uid: string,
  inicioUs: number,
  fimUs: number,
): QueryPredicate {
  return {
    and: [
      {
        field: 'vendedorPedidoOuterRef',
        op: 'in',
        value: [`documents/usuarios/${uid}`, `usuarios/${uid}`],
      },
      { field: 'ehSaida', op: 'eq', value: true },
      { field: 'estado', op: 'in', value: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado] },
      { field: 'timestamp', op: 'gte', value: inicioUs },
      { field: 'timestamp', op: 'lte', value: fimUs },
    ],
  };
}
export const vendasInicioRespostaSchema = z.strictObject({
  receita: z.number().finite(),
  quantidade: z.number().int().nonnegative().safe(),
  ticketMedio: z.number().finite(),
  inicioUs: z.number().int().safe(),
  fimUs: z.number().int().safe(),
});
export type VendasInicioResposta = z.infer<typeof vendasInicioRespostaSchema>;
export function vendasInicioResultado(
  receita: number,
  quantidade: number,
  inicioUs: number,
  fimUs: number,
): VendasInicioResposta {
  return vendasInicioRespostaSchema.parse({
    receita,
    quantidade,
    ticketMedio: quantidade === 0 ? 0 : roundReais(receita / quantidade),
    inicioUs,
    fimUs,
  });
}
