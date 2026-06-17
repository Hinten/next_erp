/**
 * Seed sample clientes — each with one or more endereços — so the
 * "find a client by address" search can be exercised manually.
 *
 * Docs are written to the real `clientes` collection (and the
 * `clientes/{id}/enderecos` subcollection the search scans). Every seeded
 * cliente carries `observacoesInternas = SEED_MARKER` so `--clean` (and a
 * human scanning the table) can tell demo data apart from real records.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT='<service-account-json>' \
 *   FIREBASE_PROJECT_ID='<project>' \
 *   pnpm --filter @delfrance/test-fixtures seed-clientes
 *
 *   # remove the seeded data again
 *   pnpm --filter @delfrance/test-fixtures seed-clientes --clean
 */
import { db } from './admin';

/**
 * Written to `observacoesInternas` on every seeded cliente. `--clean` queries
 * on it to remove exactly the demo data this script created.
 */
export const SEED_MARKER = 'seed:clientes-com-enderecos';

interface SeedEndereco {
  logradouro: string;
  numero: string;
  bairro: string;
  cep: string;
  cidade: string;
  estado: string;
  complemento?: string;
}

interface SeedCliente {
  nome: string;
  /** '0' = Pessoa Física, '1' = Pessoa Jurídica. */
  tipo: '0' | '1';
  cpf_cnpj: string;
  email: string | null;
  enderecos: SeedEndereco[];
}

/**
 * Fixed sample — addresses span several cities/streets so the search has
 * obvious things to match (e.g. search "Paulista", "Copacabana", "Curitiba").
 */
const SAMPLE_CLIENTES: SeedCliente[] = [
  {
    nome: 'Padaria Pão Quente',
    tipo: '1',
    cpf_cnpj: '11222333000181',
    email: 'contato@paoquente.example.com',
    enderecos: [
      {
        logradouro: 'Avenida Paulista',
        numero: '1000',
        bairro: 'Bela Vista',
        cep: '01310100',
        cidade: 'São Paulo',
        estado: 'SP',
      },
    ],
  },
  {
    nome: 'Maria Oliveira',
    tipo: '0',
    cpf_cnpj: '39053344705',
    email: 'maria.oliveira@example.com',
    enderecos: [
      {
        logradouro: 'Rua das Laranjeiras',
        numero: '250',
        bairro: 'Laranjeiras',
        cep: '22240003',
        cidade: 'Rio de Janeiro',
        estado: 'RJ',
      },
      {
        logradouro: 'Avenida Atlântica',
        numero: '1702',
        bairro: 'Copacabana',
        cep: '22021001',
        cidade: 'Rio de Janeiro',
        estado: 'RJ',
        complemento: 'Apto 802',
      },
    ],
  },
  {
    nome: 'Ferragens Minas Ltda',
    tipo: '1',
    cpf_cnpj: '47960950000121',
    email: 'vendas@ferragensminas.example.com',
    enderecos: [
      {
        logradouro: 'Avenida Afonso Pena',
        numero: '4000',
        bairro: 'Funcionários',
        cep: '30130009',
        cidade: 'Belo Horizonte',
        estado: 'MG',
      },
    ],
  },
  {
    nome: 'João Pereira',
    tipo: '0',
    cpf_cnpj: '30621143049',
    email: null,
    enderecos: [
      {
        logradouro: 'Rua XV de Novembro',
        numero: '88',
        bairro: 'Centro',
        cep: '80020310',
        cidade: 'Curitiba',
        estado: 'PR',
      },
    ],
  },
  {
    nome: 'Sul Distribuidora',
    tipo: '1',
    cpf_cnpj: '08402398000170',
    email: 'comercial@suldistribuidora.example.com',
    enderecos: [
      {
        logradouro: 'Avenida Borges de Medeiros',
        numero: '1501',
        bairro: 'Centro Histórico',
        cep: '90119900',
        cidade: 'Porto Alegre',
        estado: 'RS',
      },
      {
        logradouro: 'Rua dos Andradas',
        numero: '300',
        bairro: 'Centro Histórico',
        cep: '90020007',
        cidade: 'Porto Alegre',
        estado: 'RS',
      },
    ],
  },
  {
    nome: 'Ana Costa',
    tipo: '0',
    cpf_cnpj: '52998224725',
    email: 'ana.costa@example.com',
    enderecos: [
      {
        logradouro: 'Avenida Sete de Setembro',
        numero: '1200',
        bairro: 'Campo Grande',
        cep: '40080001',
        cidade: 'Salvador',
        estado: 'BA',
      },
    ],
  },
];

export interface SeedClientesResult {
  clientes: number;
  enderecos: number;
}

/**
 * Write the `SAMPLE_CLIENTES` to the `clientes` collection, each cliente plus
 * its endereços committed together in one batch. Returns how many docs landed.
 */
export async function seedClientesComEnderecos(): Promise<SeedClientesResult> {
  const firestore = db();
  const clientesCol = firestore.collection('clientes');
  // cliente.timestamp is milliseconds since epoch (numeric-epoch standard).
  const now = Date.now();
  let enderecos = 0;

  for (const sample of SAMPLE_CLIENTES) {
    const batch = firestore.batch();
    const clienteRef = clientesCol.doc();
    batch.set(clienteRef, {
      tipo: sample.tipo,
      nome: sample.nome,
      cpf_cnpj: sample.cpf_cnpj,
      idEstrangeiro: null,
      ie: null,
      imun: null,
      isUF: null,
      email: sample.email,
      telefone: null,
      observacoesInternas: SEED_MARKER,
      timestamp: now,
      nome_embedding: null,
      telefone_embedding: null,
      userCliente: null,
    });
    for (const endereco of sample.enderecos) {
      batch.set(clienteRef.collection('enderecos').doc(), {
        idExterno: null,
        logradouro: endereco.logradouro,
        numero: endereco.numero,
        bairro: endereco.bairro,
        complemento: endereco.complemento ?? null,
        cep: endereco.cep,
        codigoMunicipio: null,
        cidade: endereco.cidade,
        estado: endereco.estado,
        cPais: null,
        pais: null,
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      });
      enderecos += 1;
    }
    await batch.commit();
  }

  return { clientes: SAMPLE_CLIENTES.length, enderecos };
}

/**
 * Delete every cliente this script seeded (matched by `SEED_MARKER`) together
 * with its `enderecos` subdocs — Firestore does not cascade.
 */
export async function cleanupClientesComEnderecos(): Promise<SeedClientesResult> {
  const firestore = db();
  const snap = await firestore
    .collection('clientes')
    .where('observacoesInternas', '==', SEED_MARKER)
    .get();

  let clientes = 0;
  let enderecos = 0;
  for (const clienteDoc of snap.docs) {
    const enderecoSnap = await clienteDoc.ref.collection('enderecos').get();
    const batch = firestore.batch();
    for (const enderecoDoc of enderecoSnap.docs) {
      batch.delete(enderecoDoc.ref);
      enderecos += 1;
    }
    batch.delete(clienteDoc.ref);
    await batch.commit();
    clientes += 1;
  }

  return { clientes, enderecos };
}

// Invoked via `tsx src/seed-clientes.ts` (see package.json scripts).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('seed-clientes.ts') ||
  process.argv[1]?.endsWith('seed-clientes.js');

if (isDirectInvocation) {
  const clean = process.argv.slice(2).includes('--clean');
  const run = clean ? cleanupClientesComEnderecos() : seedClientesComEnderecos();
  run
    .then(({ clientes, enderecos }) => {
      const verb = clean ? 'removed' : 'wrote';
      // eslint-disable-next-line no-console
      console.log(`[seed-clientes] ${verb} ${clientes} cliente(s) and ${enderecos} endereço(s)`);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
