/**
 * Fixtures for the product import's suites (master plan step 9), **for tests only** — the same rule
 * as `fakeDb.ts`: nothing outside a `*.test.ts` imports this.
 *
 * A job document is always built through the job schema (`importacaoLojaIntegradaSchema`), so a
 * seeded job has every default a created one has, and a suite overrides only what it is about.
 */
import {
  type ImportacaoLojaIntegrada,
  type ItemImportacaoLi,
  STATUS_IMPORTACAO_LI,
  importacaoLojaIntegradaMeta,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
} from '@delfrance/schemas';

import type { CarimboFake, DocData, FakeDb } from './fakeDb';
import { AGORA_MS } from './fixtures';

/** `importacoesLojaIntegrada/<jobId>`. */
export function caminhoJobLi(jobId: string): string {
  return `${importacaoLojaIntegradaMeta.collectionPath}/${jobId}`;
}

/** `importacoesLojaIntegrada/<jobId>/itens/<itemId>`. */
export function caminhoItemLi(jobId: string, itemId: string): string {
  return `${caminhoJobLi(jobId)}/itens/${itemId}`;
}

/**
 * A job document of `integracaoId`, parsed whole: `executando` at `seq` 0 unless overridden (the
 * state the emulator suites seed, so the job-creation trigger ignores it).
 */
export function jobLi(
  integracaoId: string,
  over: Partial<Record<keyof ImportacaoLojaIntegrada, unknown>> = {},
): ImportacaoLojaIntegrada {
  return importacaoLojaIntegradaSchema.parse({
    integracaoId,
    iniciadoPor: 'u-escritor',
    iniciadoEmMs: AGORA_MS,
    atualizadoEmMs: AGORA_MS,
    status: STATUS_IMPORTACAO_LI.executando,
    ...over,
  });
}

/** Seed a job document; returns its stamp (a dispatch's first precondition). */
export function seedJobLi(
  db: FakeDb,
  jobId: string,
  integracaoId: string,
  over: Partial<Record<keyof ImportacaoLojaIntegrada, unknown>> = {},
): CarimboFake {
  return db.seed(caminhoJobLi(jobId), jobLi(integracaoId, over) as unknown as DocData);
}

/** A report item, parsed whole. */
export function itemLi(liId: number, over: Partial<Record<keyof ItemImportacaoLi, unknown>> = {}) {
  return itemImportacaoLiSchema.parse({
    liId,
    tipo: 'atributo',
    situacaoErp: 'vinculado',
    atualizadoEmMs: AGORA_MS,
    ...over,
  });
}

/** Seed a report item at `itens/<String(liId)>`. */
export function seedItemLi(
  db: FakeDb,
  jobId: string,
  liId: number,
  over: Partial<Record<keyof ItemImportacaoLi, unknown>> = {},
): void {
  db.seed(caminhoItemLi(jobId, String(liId)), itemLi(liId, over) as unknown as DocData);
}
