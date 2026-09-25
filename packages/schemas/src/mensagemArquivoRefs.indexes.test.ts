import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENSAGEM_ARQUIVO_REF_FIELDS } from './mensagemArquivoRefs';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  indexes?: Array<{
    collectionGroup?: string;
    queryScope?: string;
    fields?: Array<{ fieldPath?: string; order?: string }>;
  }>;
};

describe('mensagem arquivo reference indexes', () => {
  it('declares one collection-group equality index for every ref field', () => {
    const mensagemRefIndexes = (parsed.indexes ?? []).filter(
      (index) =>
        index.collectionGroup === 'mensagem' &&
        index.queryScope === 'COLLECTION_GROUP' &&
        index.fields?.length === 1 &&
        MENSAGEM_ARQUIVO_REF_FIELDS.some((field) => field === index.fields?.[0]?.fieldPath),
    );
    expect(mensagemRefIndexes).toHaveLength(MENSAGEM_ARQUIVO_REF_FIELDS.length);

    for (const field of MENSAGEM_ARQUIVO_REF_FIELDS) {
      const matches = mensagemRefIndexes.filter(
        (index) => index.fields[0]?.fieldPath === field && index.fields[0]?.order === 'ASCENDING',
      );
      expect(
        matches,
        `missing or duplicate mensagem(${field}) COLLECTION_GROUP index`,
      ).toHaveLength(1);
    }
  });
});
