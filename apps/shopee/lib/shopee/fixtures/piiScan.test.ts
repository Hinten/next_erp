import { describe, expect, it } from 'vitest';

import {
  KINDS_QUE_REPROVAM,
  formatFindings,
  patternFindings,
  redactionResidue,
  scanForPii,
  scanForPiiReprovavel,
} from './piiScan';
import { type WireValue, redactWireBody } from './redact';
import { listarFixtures, lerFixture } from './wireCorpus';

/**
 * A CPF with VALID check digits and an obviously fake body, computed here rather
 * than pasted — a document typed into a test file is a document in the repository.
 */
function cpfSintetico(base: string): string {
  const digitos = [...base].map(Number);
  const dv = (nums: readonly number[]): number => {
    const peso = nums.length + 1;
    const soma = nums.reduce((acc, n, i) => acc + n * (peso - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 || resto === 11 ? 0 : resto;
  };
  const d1 = dv(digitos);
  return `${base}${String(d1)}${String(dv([...digitos, d1]))}`;
}

/** Same idea for a CNPJ: the documented weights, an invented base. */
function cnpjSintetico(base: string): string {
  const digitos = [...base].map(Number);
  const dv = (nums: readonly number[]): number => {
    const pesos =
      nums.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = nums.reduce((acc, n, i) => acc + n * pesos[i]!, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(digitos);
  return `${base}${String(d1)}${String(dv([...digitos, d1]))}`;
}

const CPF_FALSO = cpfSintetico('123456789');
const CNPJ_FALSO = cnpjSintetico('123456780001');
/** The repo's canonical fake CNPJ (`11222333000181`), for the `payment_info` leg. */
const CNPJ_PAGAMENTO_FALSO = cnpjSintetico('112223330001');

function pontuarCpf(cpf: string): string {
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

function pontuarCnpj(cnpj: string): string {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/** An unredacted body — what a raw capture against a real BR order looks like. */
const CRU: WireValue = {
  response: {
    order_list: [
      {
        order_sn: '220810QSK8S7BX',
        buyer_cpf_id: CPF_FALSO,
        buyer_username: 'comprador_inventado',
        message_to_seller: 'meu email é comprador.inventado@example.com',
        // ⚠️ `payment_info` is an ARRAY on the wire, so its leaves sit one `*`
        // segment below the parent. Layer 1 is the ONLY one that catches
        // `transaction_id` at all (no free-text pattern describes it), so this
        // block is what makes the array-parented denylist entries mean
        // something here as well as in `redact.test.ts`. BR-only fields: the
        // committed corpus is a Singapore order and carries `payment_info: null`.
        payment_info: [
          {
            payment_method: 'Pix',
            payment_processor_register: CNPJ_PAGAMENTO_FALSO,
            transaction_id: 'TX-9F3K-PRIVATE',
            payment_amount: 31.99,
          },
        ],
        recipient_address: {
          name: 'Joana Inventada',
          phone: '11987654321',
          city: 'São Paulo',
          state: 'SP',
          zipcode: '01310100',
          full_address: 'Avenida Paulista, 1000',
        },
      },
    ],
  },
};

describe('o corpus __wire__', () => {
  const arquivos = listarFixtures();

  it('está presente e povoado — o piso que faz o resto deste arquivo significar algo', () => {
    // ⚠️ Sem ele, "nenhuma fixture carrega dado pessoal" é verdade sobre o vazio:
    // um diretório apagado, um glob errado ou um .gitignore engolindo a pasta
    // passariam verdes. Três corpos foram promovidos no passo 5.
    expect(
      arquivos.length,
      `esperava >= 3 fixtures, achei ${String(arquivos.length)}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('é JSON válido, arquivo por arquivo', () => {
    for (const file of arquivos) {
      expect(() => lerFixture(file), `${file} não é JSON`).not.toThrow();
    }
  });

  it('NÃO carrega dado pessoal — as duas camadas, arquivo por arquivo', () => {
    const problemas: string[] = [];
    for (const file of arquivos) {
      const findings = scanForPiiReprovavel(lerFixture(file));
      if (findings.length > 0) problemas.push(formatFindings(file, findings));
    }
    // A mensagem carrega caminho e tipo — nunca o valor ofensor.
    expect(problemas.join('\n')).toBe('');
  });

  it('é um PONTO FIXO de redação — um caminho novo no denylist não pode ficar para trás', () => {
    // ⚠️ Esta é a camada forte: alargar REDACTED_PATH_SUFFIXES sem regerar o
    // corpus deixaria os arquivos velhos com a folha nova exposta, e nenhum
    // regex adivinharia isso.
    const desatualizadas = arquivos.filter((file) => redactionResidue(lerFixture(file)).length > 0);
    expect(desatualizadas).toEqual([]);
  });

  it('CARREGA valores mascarados, e isso é evidência e não defeito', () => {
    // ⚠️ Âncora do sentido inverso: `masked` é informativo. Se um dia o corpus
    // parar de ter máscara nenhuma, ou este achado virar reprovação, este teste
    // cai — e as duas coisas seriam mudanças de desenho, não limpezas.
    const mascarados = arquivos.flatMap((file) =>
      scanForPii(lerFixture(file)).filter((f) => f.kind === 'masked'),
    );
    expect(mascarados.length).toBeGreaterThan(0);
    expect(KINDS_QUE_REPROVAM).not.toContain('masked');
  });
});

describe('redactionResidue', () => {
  it('CONTROLE A (sabidamente ruim) — um corpo NÃO redigido reporta cada folha pessoal', () => {
    const paths = redactionResidue(CRU).map((f) => f.path);
    const prefixo = 'response.order_list.*.';

    expect(paths).toContain(`${prefixo}buyer_cpf_id`);
    expect(paths).toContain(`${prefixo}buyer_username`);
    expect(paths).toContain(`${prefixo}message_to_seller`);
    expect(paths).toContain(`${prefixo}recipient_address.name`);
    expect(paths).toContain(`${prefixo}recipient_address.phone`);
    expect(paths).toContain(`${prefixo}recipient_address.city`);
    expect(paths).toContain(`${prefixo}recipient_address.zipcode`);
    expect(paths).toContain(`${prefixo}recipient_address.full_address`);
    // ⚠️ Os dois que moram DENTRO de um array: o caminho que o walk produz leva
    // um `*` entre o pai e a folha, e é por isso que as entradas do denylist são
    // grafadas com o índice. Sem estas duas linhas, a camada 1 seria cega
    // justamente onde o CNPJ do processador e o `transaction_id` moram — e o
    // `transaction_id` não é pego por padrão de texto nenhum.
    expect(paths).toContain(`${prefixo}payment_info.*.payment_processor_register`);
    expect(paths).toContain(`${prefixo}payment_info.*.transaction_id`);
    // …e o NEAR-MISS: os irmãos que NÃO estão no denylist não são acusados.
    expect(paths).not.toContain(`${prefixo}payment_info.*.payment_method`);
    expect(paths).not.toContain(`${prefixo}payment_info.*.payment_amount`);
    expect(redactionResidue(CRU).every((f) => f.kind === 'unredacted-path')).toBe(true);
  });

  it('CONTROLE B (sabidamente bom) — o corpo redigido é ponto fixo e não reporta nada', () => {
    expect(redactionResidue(redactWireBody(CRU))).toEqual([]);
  });

  it('não acusa o que o denylist mantém de propósito', () => {
    const paths = redactionResidue(CRU).map((f) => f.path);
    expect(paths).not.toContain('response.order_list.*.order_sn');
    expect(paths).not.toContain('response.order_list.*.recipient_address.state');
  });
});

/* -------------------------------------------------------------------------- */
/*  A prosa do provedor sobre o ANÚNCIO de um vendedor (push 16 /             */
/*  get_item_violation_info) — o par CONTROLE A / CONTROLE B do passo 11.     */
/*                                                                            */
/*  ⚠️ Os dois corpos moram INLINE, e de propósito: `__wire__/` guarda corpos  */
/*  de RESPOSTA, um envelope de push não é uma resposta, e não temos nenhuma   */
/*  captura real destas duas formas — uma amostra de página de documentação    */
/*  não é wire. Inline, o par exercita cada entrada nova do denylist sem       */
/*  prometer ao corpus um arquivo que ninguém capturou (registro 88).          */
/* -------------------------------------------------------------------------- */

/** Frases inventadas, reconhecíveis, e sem CPF/telefone/e-mail/endereço dentro. */
const SENTINELA_RAZAO = 'PROSA-RAZAO: o titulo deste anuncio copia o de outra loja';
const SENTINELA_SUGESTAO = 'PROSA-SUGESTAO: mova o anuncio para a categoria sugerida';
const SENTINELA_FALHA = 'PROSA-FALHA: detalhe do erro que atingiu este item';

/**
 * O envelope do `push 16` (`violation_item_push`), não redigido.
 *
 * ⚠️ A grafia do contêiner de deboost aqui é `deboosted_details` — a da AMOSTRA
 * da própria página, que discorda da tabela de parâmetros (`deboost_details`,
 * usada no corpo de `get_item_violation_info` abaixo). As duas aparecem neste
 * arquivo porque é exatamente o que uma entrada de UM segmento compra: a folha é
 * pega sob qualquer um dos dois pais, e nenhuma grafia precisa ser adivinhada.
 */
const PUSH_16_CRU: WireValue = {
  code: 16,
  shop_id: 987654,
  timestamp: 1_760_000_000,
  data: {
    item_id: 2500139861,
    item_name: 'Camiseta lisa infantil',
    item_status: 'BANNED',
    deboost: false,
    item_status_details: [
      {
        violation_type: 'Spam',
        violation_reason: SENTINELA_RAZAO,
        suggestion: SENTINELA_SUGESTAO,
        fix_deadline_time: 1_760_500_000,
        update_time: 1_760_000_000,
      },
    ],
    deboosted_details: [
      {
        violation_type: 'Mall Listing Improvement',
        violation_reason: SENTINELA_RAZAO,
        suggestion: SENTINELA_SUGESTAO,
        fix_deadline_time: null,
        update_time: 1_760_000_000,
        suggested_category: [
          { category_id: 100005, category_name: 'Health' },
          { category_id: 107478, category_name: 'Personal Care' },
        ],
      },
    ],
  },
};

/**
 * Uma resposta de `get_item_violation_info`, não redigida — a gêmea do envelope
 * acima, e a única das duas que carrega `fail_message`.
 *
 * ⚠️ Sem a chave `error`: o corpo de SUCESSO medido na sandbox não a traz
 * (registro 73). A falha parcial aqui é EM BANDA, dentro de `item_list[]`
 * (`fail_error` + `fail_message`), e não uma `failure_list` separada.
 */
const VIOLATION_INFO_CRU: WireValue = {
  response: {
    item_list: [
      {
        item_id: 2500139861,
        item_name: 'Camiseta lisa infantil',
        item_status: 'NORMAL',
        deboost: true,
        item_status_details: [],
        deboost_details: [
          {
            violation_type: 'Other Listing Improvement',
            violation_reason: SENTINELA_RAZAO,
            suggestion: SENTINELA_SUGESTAO,
            fix_deadline_time: null,
            update_time: 1_760_000_000,
            suggested_category: null,
          },
        ],
        fail_error: 'error_item_not_found',
        fail_message: SENTINELA_FALHA,
      },
    ],
  },
};

describe('a prosa do provedor sobre um anúncio', () => {
  it('CONTROLE A (sabidamente ruim) — um push 16 não redigido reporta CADA folha de prosa', () => {
    const paths = redactionResidue(PUSH_16_CRU).map((f) => f.path);

    expect(paths).toContain('data.item_status_details.*.violation_reason');
    expect(paths).toContain('data.item_status_details.*.suggestion');
    // ⚠️ O contêiner com a OUTRA grafia, pego pela mesma entrada de um segmento.
    expect(paths).toContain('data.deboosted_details.*.violation_reason');
    expect(paths).toContain('data.deboosted_details.*.suggestion');
    expect(redactionResidue(PUSH_16_CRU).every((f) => f.kind === 'unredacted-path')).toBe(true);
  });

  it('CONTROLE A — o corpo de get_item_violation_info reporta a mesma prosa E o fail_message', () => {
    const paths = redactionResidue(VIOLATION_INFO_CRU).map((f) => f.path);
    const prefixo = 'response.item_list.*.';

    expect(paths).toContain(`${prefixo}deboost_details.*.violation_reason`);
    expect(paths).toContain(`${prefixo}deboost_details.*.suggestion`);
    expect(paths).toContain(`${prefixo}fail_message`);
  });

  it('⚠️ NEAR-MISS: o que o denylist MANTÉM de propósito não é acusado em nenhum dos dois', () => {
    // `violation_type` é um vocabulário FECHADO de sete valores e é o que
    // `params.violacao` do aviso renderiza; `suggested_category` é a taxonomia,
    // o campo mais acionável do push; `fail_error` é um CÓDIGO, não prosa; e
    // `item_name` não é pessoa — `name` é casado por sufixo, `item_name` não.
    const push = redactionResidue(PUSH_16_CRU).map((f) => f.path);
    expect(push).not.toContain('data.item_status_details.*.violation_type');
    expect(push).not.toContain('data.deboosted_details.*.suggested_category.*.category_name');
    expect(push).not.toContain('data.deboosted_details.*.suggested_category.*.category_id');
    expect(push).not.toContain('data.item_name');
    expect(push).not.toContain('data.item_id');

    const info = redactionResidue(VIOLATION_INFO_CRU).map((f) => f.path);
    expect(info).not.toContain('response.item_list.*.fail_error');
    expect(info).not.toContain('response.item_list.*.violation_type');
  });

  it('CONTROLE B (sabidamente bom) — os dois corpos redigidos são ponto fixo e não reportam nada', () => {
    expect(redactionResidue(redactWireBody(PUSH_16_CRU))).toEqual([]);
    expect(redactionResidue(redactWireBody(VIOLATION_INFO_CRU))).toEqual([]);
    // …e nenhuma das duas camadas reprova o que o próprio redator produziu.
    expect(scanForPiiReprovavel(redactWireBody(PUSH_16_CRU))).toEqual([]);
    expect(scanForPiiReprovavel(redactWireBody(VIOLATION_INFO_CRU))).toEqual([]);
  });

  it('CONTROLE B — a redação apaga a PROSA e preserva o que a fixture existe para provar', () => {
    // O ponto do par: se a redação levasse `violation_type` ou
    // `suggested_category` junto, a fixture deixaria de provar a única coisa que
    // o passo 11 lê dela.
    const redigido = JSON.stringify(redactWireBody(PUSH_16_CRU));

    for (const sentinela of [SENTINELA_RAZAO, SENTINELA_SUGESTAO]) {
      expect(redigido).not.toContain(sentinela);
    }
    expect(redigido).toContain('"violation_type":"Spam"');
    expect(redigido).toContain('"category_name":"Personal Care"');
    expect(redigido).toContain('"item_name":"Camiseta lisa infantil"');

    const redigidoInfo = JSON.stringify(redactWireBody(VIOLATION_INFO_CRU));
    expect(redigidoInfo).not.toContain(SENTINELA_FALHA);
    expect(redigidoInfo).toContain('"fail_error":"error_item_not_found"');
  });
});

describe('patternFindings', () => {
  it('CONTROLE A — pega dado pessoal numa chave que denylist nenhum anteciparia', () => {
    // O ponto desta camada: a CHAVE é inocente, a prosa não é.
    const findings = patternFindings({
      item_list: [{ item_name: 'Camiseta lisa' }],
      message_to_seller: `falar com a Joana, CPF ${pontuarCpf(CPF_FALSO)}, tel (11) 98765-4321`,
      note: 'email comprador.inventado@example.com',
      empresa: { obs: `CNPJ ${pontuarCnpj(CNPJ_FALSO)}` },
      endereco_livre: 'Avenida Paulista, 1000',
    });

    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('cpf');
    expect(kinds).toContain('phone');
    expect(kinds).toContain('email');
    expect(kinds).toContain('cnpj');
    expect(kinds).toContain('endereco');
  });

  it('pega também o CPF e o CNPJ SEM pontuação numa string', () => {
    // ⚠️ É a divergência deliberada em relação ao scanner do Mercado Livre: lá um
    // dígito solto é indistinguível de um id de recurso. Aqui os ids da Shopee
    // chegam como NÚMERO JSON, e estes padrões só olham STRING.
    const semPontuacao = patternFindings({ obs: CPF_FALSO, doc: CNPJ_FALSO });
    expect(semPontuacao.map((f) => f.kind)).toContain('cpf');
    expect(semPontuacao.map((f) => f.kind)).toContain('cnpj');
  });

  it('⚠️ NEAR-MISS: um id NUMÉRICO de 11 dígitos não é achado nenhum — só strings são varridas', () => {
    // `buyer_user_id`, `item_id` e `line_item_id` chegam como número; varrer
    // número seria a regra que dispara em todo pedido e é desligada num dia.
    expect(
      patternFindings({ buyer_user_id: 12_345_678_909, line_item_id: 242_672_551_207_922 }),
    ).toEqual([]);
  });

  it('CONTROLE B (sabidamente bom) — dado de produto limpo não reporta nada', () => {
    expect(
      patternFindings({
        order_sn: '220810QSK8S7BX',
        package_number: 'OFG242672552205937',
        item_list: [{ item_name: 'Camiseta lisa infantil 100% algodão', model_sku: '123002002' }],
        shipping_carrier: 'Sandbox -Standard Express LPS',
      }),
    ).toEqual([]);
  });

  it('não reporta os PRÓPRIOS placeholders do redator como vazamento', () => {
    // Sem isso o scanner acusa todo arquivo que ele mesmo acabou de limpar:
    // `00000000000` são onze dígitos e `Rua Redacted, 0` é um endereço por forma.
    expect(patternFindings(redactWireBody(CRU))).toEqual([]);
  });

  it('⚠️ NEAR-MISS: uma estrela NÃO esconde o resto — mascarado E com CPF reporta os DOIS', () => {
    // Se o ramo `masked` retornasse ali, bastaria um `*` em qualquer lugar da
    // string para calar todos os outros padrões.
    const achados = patternFindings({
      obs: `falar com a J****, CPF ${pontuarCpf(CPF_FALSO)}`,
    });
    expect(achados.map((f) => f.kind)).toContain('masked');
    expect(achados.map((f) => f.kind)).toContain('cpf');
    expect(scanForPiiReprovavel({ obs: `J****, CPF ${pontuarCpf(CPF_FALSO)}` }).length).toBe(1);
  });

  it('um valor mascarado é achado INFORMATIVO, nunca reprovação', () => {
    const corpo: WireValue = { recipient_address: { name: '****', phone: '******64' } };
    expect(patternFindings(corpo).map((f) => f.kind)).toEqual(['masked', 'masked']);
    expect(scanForPiiReprovavel(corpo)).toEqual([]);
  });
});

describe('formatFindings', () => {
  it('NUNCA carrega o valor casado — só o caminho e o tipo (#1015)', () => {
    const linhas = formatFindings('get_order_detail.exemplo.json', scanForPii(CRU));

    // Toda a população aqui é texto que suspeitamos ser pessoal, e esta string
    // vai para um log de CI e para a mensagem de falha de um teste.
    for (const segredo of [
      'Joana Inventada',
      'comprador_inventado',
      CPF_FALSO,
      '11987654321',
      'Avenida Paulista',
      '01310100',
      'comprador.inventado@example.com',
      CNPJ_PAGAMENTO_FALSO,
      'TX-9F3K-PRIVATE',
    ]) {
      expect(linhas, `formatFindings vazou "${segredo}"`).not.toContain(segredo);
    }

    expect(linhas).toContain('get_order_detail.exemplo.json');
    expect(linhas).toContain('unredacted-path');
  });
});

describe('os CPF/CNPJ sintéticos deste arquivo', () => {
  it('têm dígitos verificadores válidos — senão os testes de padrão provariam menos do que dizem', () => {
    expect(CPF_FALSO).toBe('12345678909');
    expect(CPF_FALSO).toHaveLength(11);
    expect(CNPJ_FALSO).toHaveLength(14);
    // O CNPJ canônico falso do repositório, derivado e não colado.
    expect(CNPJ_PAGAMENTO_FALSO).toBe('11222333000181');
    // NEAR-MISS: um DV errado NÃO é o que este helper produz.
    expect(cpfSintetico('123456789')).not.toBe('12345678900');
  });
});
