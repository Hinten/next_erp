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
