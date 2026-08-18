import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every `new GoogleGenAI(...)` argument, in order. */
  constructed: [] as Array<Record<string, unknown>>,
  /** What the fake model returns as raw text. */
  text: '{}',
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor(args: Record<string, unknown>) {
      h.constructed.push(args);
    }
    models = { generateContent: async () => ({ text: h.text }) };
  },
}));

const { AiNotConfiguredError, AiUnparseableAnswerError, DEFAULT_AI_LOCATION, __resetAiClient } =
  await import('./provider');
const { createVertexGenerateFn } = await import('./provider');

const ENV = { ...process.env };

function callOnce() {
  return createVertexGenerateFn()({
    model: 'gemini-3.5-flash-lite',
    request: {
      systemInstruction: 'sys',
      text: 'produto',
      images: [],
      responseSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  });
}

beforeEach(() => {
  h.constructed = [];
  h.text = '{}';
  __resetAiClient();
  delete process.env.GOOGLE_CLOUD_LOCATION;
  process.env.GOOGLE_CLOUD_PROJECT = 'projeto-x';
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('the Vertex location', () => {
  it('defaults to `global`, which is where our models are actually served', async () => {
    // ⚠️ Verified against Vertex on 2026-08-11: gemini-3.5-flash-lite (our
    // shipped default), 3.1-flash-lite and 3.6-flash answer at `global` and
    // return 404 at `us-central1`. A regional default is a deploy-time 404 for
    // the exact models this feature was chosen around, and nothing else in CI
    // can catch it — every other test drives the `GenerateFn` seam and never
    // constructs a real client.
    expect(DEFAULT_AI_LOCATION).toBe('global');
    await callOnce();
    expect(h.constructed[0]).toMatchObject({ vertexai: true, location: 'global' });
  });

  it('lets a deployment pin a region for a model that needs one', async () => {
    process.env.GOOGLE_CLOUD_LOCATION = 'southamerica-east1';
    await callOnce();
    expect(h.constructed[0]).toMatchObject({ location: 'southamerica-east1' });
  });

  it('builds the client once and reuses it', async () => {
    await callOnce();
    await callOnce();
    expect(h.constructed).toHaveLength(1);
  });
});

describe('createVertexGenerateFn', () => {
  it('authenticates through ADC — no API key is ever passed', async () => {
    // The whole auth posture: `apphosting.yaml` has no `secret:` entry and no
    // key exists in this repo. A key appearing here would be the first one.
    await callOnce();
    expect(h.constructed[0]).not.toHaveProperty('apiKey');
  });

  it('refuses to build a client with no project rather than guessing one', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.FIREBASE_PROJECT_ID;
    await expect(callOnce()).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it('reports a non-JSON answer as such instead of throwing a SyntaxError', async () => {
    h.text = 'Claro! Aqui estão os atributos:';
    await expect(callOnce()).rejects.toBeInstanceOf(AiUnparseableAnswerError);
  });
});
