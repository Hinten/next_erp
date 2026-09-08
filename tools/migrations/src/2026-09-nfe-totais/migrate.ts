import {
  FieldPath,
  type Query,
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase-admin/firestore';

import { extrairTotaisNFe } from '@delfrance/integrations-nfe/http-provider';

import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import { planejarTotais, type MotivoGravar, type MotivoPular } from './transform';

/**
 * Backfill: dar a toda NF-e autorizada o bloco `totais` que a emissão passou a
 * gravar (#1491). Idempotente, dry-run por padrão.
 * Runbook: `tools/migrations/nfe-totais.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:nfe-totais --project <id>
 *   pnpm --filter @delfrance/migrations migrate:nfe-totais --project <id> --report-only
 *   pnpm --filter @delfrance/migrations migrate:nfe-totais --project <id> --apply
 *
 * ⚠️ **Isto LIGA a feature; não arruma nada.** A apuração mensal conta como
 * `notasIlegiveis` toda nota aprovada da janela sem `totais.receitaBruta` e se
 * recusa a publicar uma alíquota enquanto houver uma. Antes desta passada, TODA
 * nota anterior à fatia 1 está nessa conta — ou seja, nenhuma alíquota é
 * promovida em lugar nenhum.
 *
 * ⚠️ **Varredura completa do grupo, sem filtro de estado.** Firestore não sabe
 * filtrar "campo ausente" (uma chave que não existe não está em índice nenhum),
 * então não há query que devolva só as notas sem bloco. Um `where('estado', ...)`
 * cortaria as rejeitadas — que não têm XML e são baratas — ao custo de um índice
 * composto novo, e deixaria de fora as canceladas, que CONSERVAM o
 * `xml_nfe_proc` e o bloco. A regra aqui é a mesma da emissão, e é a única que
 * mantém "tem `xml_nfe_proc` e não tem `totais`" com um significado só: toda
 * nota que carrega o XML autorizado recebe o bloco, qualquer que seja o estado.
 * Quem decide o que é receita é a apuração (que soma só `aprovada`), não este
 * script.
 *
 * ⚠️ **Sem guarda de perda de update, e de propósito (regra 7, tier 0).**
 * `xml_nfe_proc` tem UM escritor não-nulo em todo o repositório —
 * `swapAnchorForProc` — que o grava junto com o próprio `totais` e nunca o
 * reescreve. Os dois escritores calculam então a MESMA função dos MESMOS bytes
 * imutáveis: não há corrida a perder. O write é de campo (`update`), nunca um
 * `set`, então também não pode apagar o que outro escritor pôs ao lado.
 */

/**
 * Estas são as maiores linhas do corpus — um `nfev4` carrega o XML inteiro da
 * NF-e — então a página é pequena de propósito: o que limita aqui é memória do
 * processo, não latência.
 */
const PAGE_SIZE = 100;

/**
 * Só o que a decisão lê. `xml_assinado`, `xml_epec_proc` e `infNFe` também são
 * XMLs inteiros e não interessam a esta passada.
 *
 * ⚠️ No Enterprise isto NÃO reduz a conta — a cobrança é por dado varrido e o
 * documento é lido de qualquer jeito; o que economiza é rede e memória. E é
 * seguro só porque o write é `update` de UM campo: gravar um documento lido pela
 * metade com `set` apagaria tudo que a projeção deixou de fora.
 */
const CAMPOS = ['xml_nfe_proc', 'totais'] as const;

/** Pagina por chave de documento — cursor estável, memória limitada. */
async function* pagesByDocId(base: Query): AsyncGenerator<QueryDocumentSnapshot<DocumentData>[]> {
  let cursor: QueryDocumentSnapshot<DocumentData> | undefined;
  for (;;) {
    let q: Query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

type Motivo = MotivoGravar | MotivoPular;

function conta(mapa: Map<Motivo, number>, chave: Motivo): void {
  mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
}

function notas(mapa: Map<Motivo, number>): string[] {
  return [...mapa.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([motivo, n]) => `    ${motivo.padEnd(12)} ${String(n).padStart(8)}`);
}

/** A consulta das duas passadas — uma definição só, para não divergirem. */
function fonte(ctx: MigrationContext): Query {
  return ctx.db.collectionGroup('nfev4').select(...CAMPOS);
}

/**
 * `--report-only`: classifica e conta, sem escrever e sem log por documento.
 * É o que se lê ANTES de confiar num dry-run — responde "que formas existem
 * mesmo neste corpus?", que o log de mudanças não responde, porque ele só mostra
 * o que o transform já sabe tratar.
 */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const veredito = new Map<Motivo, number>();
  let docsScanned = 0;

  for await (const docs of pagesByDocId(fonte(ctx))) {
    for (const doc of docs) {
      docsScanned += 1;
      conta(veredito, planejarTotais(doc.data(), extrairTotaisNFe).motivo);
    }
  }

  log([`[nfe-totais] ${docsScanned} NF-e no grupo`, ...notas(veredito)].join('\n'));
  return { docsScanned, docsChanged: 0 };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.reportOnly) return runReport(ctx);

  const veredito = new Map<Motivo, number>();
  let docsScanned = 0;
  let docsChanged = 0;
  let ilegiveis = 0;

  for await (const docs of pagesByDocId(fonte(ctx))) {
    for (const doc of docs) {
      docsScanned += 1;
      const plano = planejarTotais(doc.data(), extrairTotaisNFe);
      conta(veredito, plano.motivo);

      if (plano.acao === 'pular') {
        // `sem-xml` e `ja-igual` são a esmagadora maioria depois da primeira
        // passada, e logar cada uma soterraria as linhas que importam — o
        // resumo continua contando as duas. `ilegivel` vai para o log SEMPRE:
        // é uma nota que fica de fora da RBT12 e alguém tem de olhar.
        if (plano.motivo === 'ilegivel') {
          ilegiveis += 1;
          ctx.sink.skip(doc.ref.path, 'totais', null, 'xml_nfe_proc presente mas ilegível');
        }
        continue;
      }

      ctx.sink.change(doc.ref.path, 'totais', plano.motivo, plano.totais);
      await ctx.writer.update(doc.ref, { totais: plano.totais });
      docsChanged += 1;
    }
  }

  log([`[nfe-totais] ${docsScanned} NF-e no grupo`, ...notas(veredito)].join('\n'));
  if (ilegiveis > 0) {
    // ⚠️ Não é um aviso de arrumação: cada uma destas é uma nota que a apuração
    // vai contar em `notasIlegiveis`, e uma só já BLOQUEIA a publicação da
    // alíquota da filial. O número tem de ser lido, não só registrado.
    log(
      `[nfe-totais] ⚠️ ${ilegiveis} nota(s) com XML autorizado e ILEGÍVEL — enquanto ` +
        'existirem, a apuração mensal não publica alíquota para a filial delas. ' +
        'Estão nomeadas no JSONL.',
    );
  }
  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  runMigration('nfe-totais', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
