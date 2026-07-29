// Fixture stand-in for @delfrance/schemas: one Zod enum WITH a companion
// constant (opted in), one WITHOUT (not enforced), and a hand-written union
// (never enforced). `z` is a local stub so the fixture needs no dependency —
// the rule reads the declaration shapes, not zod itself.
export declare const z: {
  enum<const T extends readonly string[]>(
    values: T,
  ): { meta(m: unknown): { _out: T[number] }; _out: T[number] };
};

declare namespace zod {
  type infer<T> = T extends { _out: infer O } ? O : never;
}

export const estadoPedidoSchema = z
  .enum(['iniciado', 'carrinho', 'pago', 'cancelado', 'finalizado'])
  .meta({ labels: {} });
export type EstadoPedido = zod.infer<typeof estadoPedidoSchema>;

export const ESTADO_PEDIDO = {
  iniciado: 'iniciado',
  carrinho: 'carrinho',
  pago: 'pago',
  cancelado: 'cancelado',
  finalizado: 'finalizado',
} as const satisfies Record<string, EstadoPedido>;

// Opted OUT: no companion constant, so raw literals stay legal.
export const tipoContatoSchema = z.enum(['email', 'telefone', 'whatsapp']);
export type TipoContato = zod.infer<typeof tipoContatoSchema>;

// Not a Zod enum at all — a hand-written union carries no schema invariant.
export type EstadoBucket = 'aberto' | 'processo' | 'concluido';

// Wire values that are NOT the member names — the `ESTADO_NFE` shape. A raw 'a'
// must resolve to `ESTADO_NFE.aprovada`, never `ESTADO_NFE.a`.
export const estadoNfeSchema = z.enum(['0', 'a', 'c']);
export type EstadoNfe = zod.infer<typeof estadoNfeSchema>;

export const ESTADO_NFE = {
  gerado: '0',
  aprovada: 'a',
  cancelada: 'c',
} as const satisfies Record<string, EstadoNfe>;

// Two enums sharing a member set. The real pair is `Origem` (imposto/tribute.ts)
// and `OrigemProdutoImposto` (the same SEFAZ concept declared again in
// operacao.ts), both '0'…'8'. Each still resolves through its own alias, but once
// the checker erases that alias — a nullable field — nothing in the type says
// which one it is, and both constants would compile in either place.
export const origemSchema = z.enum(['0', '1', '2']);
export type Origem = zod.infer<typeof origemSchema>;

export const ORIGEM = {
  nacional: '0',
  estrangeiraImportacaoDireta: '1',
  estrangeiraMercadoInterno: '2',
} as const satisfies Record<string, Origem>;

export const origemProdutoSchema = z.enum(['0', '1', '2']);
export type OrigemProduto = zod.infer<typeof origemProdutoSchema>;

export const ORIGEM_PRODUTO = {
  nacionalProduto: '0',
  importadoDireto: '1',
  importadoMercadoInterno: '2',
} as const satisfies Record<string, OrigemProduto>;
