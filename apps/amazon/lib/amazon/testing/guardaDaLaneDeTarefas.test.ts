/**
 * The emulator lane's D11 refusals (`guardaDaLaneDeTarefas.ts`), proved offline
 * in `CI test` — the setup that runs them throws on import under `CI`, so this
 * is the only place they can be exercised without the emulators. Pure: an
 * in-memory reader, no disk, no network.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CHAMADAS_ENV_AMAZON, lerChaveDeChamadasAmazon } from '../core/valvulas';
import {
  CHAVE_DE_CHAMADAS_DA_LANE,
  DIRETORIO_DO_ARTEFATO_AMAZON,
  type LeitorDoArtefato,
  NOME_DE_ENV_DO_ARTEFATO,
  chamadasLigadasNoAmbiente,
  envsDoArtefatoQueNomeiamAChave,
} from './guardaDaLaneDeTarefas';

const RAIZ_REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTEFATO = '/artefato';

/** An in-memory artifact folder: name → text. `null` = the folder does not exist. */
function leitor(arquivos: Record<string, string> | null): LeitorDoArtefato {
  return {
    existe: (caminho) => arquivos !== null && caminho === ARTEFATO,
    listar: () => Object.keys(arquivos ?? {}),
    ler: (caminho) => {
      const nome = caminho.slice(ARTEFATO.length + 1);
      const texto = arquivos?.[nome];
      if (texto === undefined || join(ARTEFATO, nome) !== caminho) {
        throw new TypeError(`leitura fora do artefato: ${caminho}`);
      }
      return texto;
    },
  };
}

describe('the read switch in the shell', () => {
  it('spells the switch exactly as the module it polices does', () => {
    expect(CHAVE_DE_CHAMADAS_DA_LANE).toBe(CHAMADAS_ENV_AMAZON);
  });

  it.each([
    ['on', true],
    ['off', false],
    ['ON', false],
    [' on', false],
    ['on ', false],
    ['true', false],
    ['1', false],
    ['', false],
    [undefined, false],
  ])('%j → refused: %s, exactly when the loader would call Amazon', (valor, ligada) => {
    const ambiente = { [CHAVE_DE_CHAMADAS_DA_LANE]: valor };
    expect(chamadasLigadasNoAmbiente(ambiente)).toBe(ligada);
    // The guard refuses EXACTLY what the loader would accept — no wider (a
    // false alarm on `ON` would teach people to unset the guard), no narrower.
    expect(chamadasLigadasNoAmbiente(ambiente)).toBe(lerChaveDeChamadasAmazon(ambiente));
  });

  it('reads no other variable', () => {
    expect(chamadasLigadasNoAmbiente({ OUTRA: 'on', AMAZON_CHAMADAS_X: 'on' })).toBe(false);
  });
});

describe('an artifact env file that NAMES the switch', () => {
  it('refuses any value, commented out, exported, quoted or with CRLF', () => {
    const encontrados = envsDoArtefatoQueNomeiamAChave(
      ARTEFATO,
      leitor({
        '.env': 'AMAZON_CHAMADAS=on\n',
        '.env.demo-erp': '# AMAZON_CHAMADAS=off\nOUTRA=1\n',
        '.env.local': 'export AMAZON_CHAMADAS="off"\r\n',
        '.env.deploy': 'AMAZON_CHAMADAS=\n',
      }),
    );
    // ⚠️ Every one of them, including the two that say `off`: whether an
    // artifact value overrides the job env inside the emulator is unverified,
    // and a value check is the mutation this suite exists to kill.
    expect(encontrados).toEqual(['.env', '.env.demo-erp', '.env.deploy', '.env.local']);
  });

  it('passes an artifact whose env files never name it (the near-miss)', () => {
    expect(
      envsDoArtefatoQueNomeiamAChave(
        ARTEFATO,
        leitor({
          '.env': 'FUNCTIONS_REGION=x\nAMAZON_TASKS_DISABLED=1\n',
          '.env.demo-erp': 'AMAZON_LWA_CLIENT_ID=x\n',
          'index.js': 'process.env.AMAZON_CHAMADAS',
          'package.json': '{}',
        }),
      ),
    ).toEqual([]);
  });

  it('selects files by an ANCHORED name: a file outside the shapes firebase-tools loads is not read', () => {
    // Each of these names the switch, and none is an env file the functions
    // emulator loads — so none is read (the reader would throw on any read
    // the fake does not expect, which a prefix selection would make).
    const arquivos = {
      env: 'AMAZON_CHAMADAS=on',
      '.envrc': 'AMAZON_CHAMADAS=on',
      '.env.Local': 'AMAZON_CHAMADAS=on',
      '.env.deploy.secrets': 'AMAZON_CHAMADAS=on',
      'x.env': 'AMAZON_CHAMADAS=on',
    };
    expect(envsDoArtefatoQueNomeiamAChave(ARTEFATO, leitor(arquivos))).toEqual([]);
    for (const nome of Object.keys(arquivos)) {
      expect(NOME_DE_ENV_DO_ARTEFATO.test(nome), nome).toBe(false);
    }
    for (const nome of ['.env', '.env.deploy', '.env.demo-erp', '.env.local']) {
      expect(NOME_DE_ENV_DO_ARTEFATO.test(nome), nome).toBe(true);
    }
  });

  it('has nothing to police before the artifact exists', () => {
    expect(envsDoArtefatoQueNomeiamAChave(ARTEFATO, leitor(null))).toEqual([]);
  });

  it('polices the folder the emulator config serves', () => {
    const config = JSON.parse(
      readFileSync(join(RAIZ_REPO, 'firebase.amazon.tasks.json'), 'utf8'),
    ) as {
      functions: Array<{ source: string; codebase: string }>;
    };
    expect(config.functions).toHaveLength(1);
    expect(config.functions[0]?.codebase).toBe('amazon');
    expect(relative(RAIZ_REPO, DIRETORIO_DO_ARTEFATO_AMAZON).split(sep).join('/')).toBe(
      config.functions[0]?.source,
    );
  });
});
