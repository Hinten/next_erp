/**
 * NF-e orchestrator — Pedido → emit → persist → apply outcome.
 *
 * The single source of truth for the **anti-loss persistence invariant**:
 * an NF-e document is written to Firestore with `estado='enviando'` and
 * its computed `chave` (44 digits) and signed `xml_assinado` **before**
 * the SOAP send. From that moment on, a crash anywhere is recoverable
 * by either the inline `consultarSituacaoNFe` (called on
 * `recover-via-consulta` outcomes) or the `processar-pendentes` cron.
 *
 * This barrel splits the orchestrator into per-service modules so each
 * SEFAZ operation lives in its own file, while preserving the public
 * `@/lib/nfe/orchestrator` import surface:
 *   - `errors.ts`          — shared `NFe*Error` classes
 *   - `bundle.ts`          — Pedido bundle loading + fiscal-item validation
 *   - `audit.ts`           — `enviNfe` audit log + state-persist helpers
 *   - `generator-input.ts` — `GeneratorInput` builders
 *   - `emitir.ts`          — emit (single + lote)
 *   - `consultar.ts`       — standalone SEFAZ consulta
 *   - `cancelar.ts`        — cancelamento (RecepcaoEvento 110111)
 *   - `carta-correcao.ts`  — carta de correção / CC-e (RecepcaoEvento 110110)
 *   - `inutilizar.ts`      — inutilização de numeração (NfeInutilizacao4)
 *   - `danfe.ts`           — DANFE artifact rendering (PDF + ZPL) from procNFe
 */
export * from './errors';
export * from './bundle';
export * from './audit';
export * from './generator-input';
export * from './emitir';
export * from './consultar';
export * from './cancelar';
export * from './carta-correcao';
export * from './inutilizar';
export * from './danfe';

import { flattenAndValidate, loadPagamentosFromSnapshot, parseFreteFromPedido } from './bundle';
import {
  buildCardFromCartao,
  buildCobrFromPagamentos,
  buildExporta,
  buildGenItems,
  buildInfAdic,
  buildInfIntermed,
  buildPaymentsFromPagamentos,
  buildTranspFromFrete,
} from './generator-input';

// Internals exposed for tests only.
export const __internal = {
  flattenAndValidate,
  buildPaymentsFromPagamentos,
  buildCardFromCartao,
  buildGenItems,
  loadPagamentosFromSnapshot,
  buildTranspFromFrete,
  buildCobrFromPagamentos,
  buildInfAdic,
  buildExporta,
  buildInfIntermed,
  parseFreteFromPedido,
};

// Re-export Zod so test fixtures can use the same z instance.
export { z } from 'zod';
