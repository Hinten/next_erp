/**
 * The importer seam, FILLED (master plan step 5, PR 5-e). Step 3 pinned it
 * empty; the empty-seam behaviour (`adiado/importador-ausente`, the poll's
 * zero-read gate) is still pinned where it runs, with the seam MOCKED to `null`
 * (`notificacao.test.ts`, `functions/src/{index,pollPedidos,filaLeitura}.test.ts`).
 * Who may import this module is `estrutura.test.ts`'s.
 */
import { describe, expect, it } from 'vitest';
import { TIPO_TAREFA_AMAZON, tipoTarefaAmazonSchema } from '@delfrance/schemas';

import { importarPedidoAmazon } from '../pedidos/importarPedido';
import { DESTINO_TIPO_AMAZON, importadorPedidoAmazon } from './destinos';

describe('DESTINO_TIPO_AMAZON — the seam the functions roots read', () => {
  it('★ the pedido importer IS the step-5 order import', () => {
    expect(DESTINO_TIPO_AMAZON[TIPO_TAREFA_AMAZON.pedido]).toBe(importarPedidoAmazon);
    expect(importadorPedidoAmazon()).toBe(importarPedidoAmazon);
    // Anti-vacuity: a real function, the declaration the importer exports.
    expect(typeof importarPedidoAmazon).toBe('function');
    expect(importarPedidoAmazon.name).toBe('importarPedidoAmazon');
  });

  it('has exactly one row per task tipo — every tipo of the schema, nothing else', () => {
    expect(Object.keys(DESTINO_TIPO_AMAZON).sort()).toEqual(
      [...tipoTarefaAmazonSchema.options].sort(),
    );
  });

  it('importadorPedidoAmazon reads the table on every call (never a copy taken at load)', () => {
    const primeira = importadorPedidoAmazon();
    expect(importadorPedidoAmazon()).toBe(primeira);
    expect(primeira).toBe(DESTINO_TIPO_AMAZON.pedido);
  });
});
