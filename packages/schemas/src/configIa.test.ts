import { describe, expect, it } from 'vitest';

import {
  CONFIG_IA_ML_ATRIBUTOS_DOC_ID,
  CONFIG_IA_MODELO_PADRAO,
  configIaMeta,
  configIaSchema,
  PROVEDOR_IA,
} from './configIa';

describe('configIaSchema', () => {
  it('parses an empty document into a usable agent', () => {
    // The panel must render against a doc that does not exist yet, and the
    // suggestion route must be able to call with nothing stored. Every field
    // therefore carries a `.default()`.
    const cfg = configIaSchema.parse({});
    expect(cfg.modelo).toBeNull();
    expect(cfg.provedor).toBe(PROVEDOR_IA.vertex);
    expect(cfg.ativo).toBe(true);
    expect(cfg.temperatura).toBe(0);
  });

  it('leaves `modelo` NULL so the resolution chain can reach the env step', () => {
    // ⚠️ Defaulting this to CONFIG_IA_MODELO_PADRAO breaks the documented order
    // outright: an absent doc parses with every default filled in, so a
    // "stored" model would always be present and MERCADO_LIVRE_AI_MODEL could
    // never be consulted. It also freezes the shipped default for any tenant
    // that once saved the page.
    expect(configIaSchema.parse({}).modelo).toBeNull();
    expect(CONFIG_IA_MODELO_PADRAO).toBe('gemini-3.5-flash-lite');
  });

  it('defaults the temperature to 0 — this is extraction, not writing', () => {
    // The same produto must yield the same attributes twice; a creative default
    // would make the review modal show different suggestions on every click.
    expect(configIaSchema.parse({}).temperatura).toBe(0);
  });

  it('keeps promptSistema NULL rather than storing a copy of the default', () => {
    // Storing the shipped text would freeze it: a later improvement to the
    // default wording would never reach a tenant that had once saved the page.
    // `null` means "use whatever the code ships today".
    expect(configIaSchema.parse({}).promptSistema).toBeNull();
  });

  it('distinguishes a blank instruction from an absent one', () => {
    // '' is a real stored value the caller must be able to see and fall back
    // from; it must not be silently coerced to null at the schema layer.
    expect(configIaSchema.parse({ promptSistema: '' }).promptSistema).toBe('');
  });

  it('refuses a blank model name', () => {
    // '' would resolve to a provider call with no model and a 400 from Vertex.
    expect(configIaSchema.safeParse({ modelo: '' }).success).toBe(false);
  });

  it('bounds the token cap and the temperature', () => {
    expect(configIaSchema.safeParse({ maxOutputTokens: 12 }).success).toBe(false);
    expect(configIaSchema.safeParse({ temperatura: -1 }).success).toBe(false);
    expect(configIaSchema.safeParse({ temperatura: 3 }).success).toBe(false);
  });

  it('rejects an unknown provider instead of coercing it', () => {
    expect(configIaSchema.safeParse({ provedor: 'openai' }).success).toBe(false);
  });
});

describe('configIaMeta', () => {
  it('reuses the integracao permission bits', () => {
    // Whoever can connect an account and publish to ML tunes its agent. Minting
    // a dedicated bit would have meant a coordinated change across
    // @delfrance/auth, the cargos editor, both rulesets and their snapshots,
    // plus re-minting claims for every affected user.
    expect(configIaMeta.permissions).toEqual({
      read: 1n << 56n,
      write: 1n << 57n,
      delete: 1n << 58n,
    });
  });

  it('declares NO defaultQuery — a singleton read by id needs no index', () => {
    // Declaring one would trip `delfrance/default-query-needs-index` and cost a
    // composite index that nothing would ever use (root CLAUDE.md rule 1).
    expect(configIaMeta.defaultQuery).toBeUndefined();
  });

  it('is a top-level collection, so the doc id is the agent slug', () => {
    expect(configIaMeta.collectionPath).toBe('configIa');
    expect(CONFIG_IA_ML_ATRIBUTOS_DOC_ID).toBe('ml-atributos');
  });
});
