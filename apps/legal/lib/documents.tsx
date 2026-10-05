import type { ReactNode } from 'react';
import Link from 'next/link';

export interface LegalDocumentContent {
  title: string;
  revision: { iso: string; label: string };
  introduction: string;
  sections: readonly { id: string; title: string; content: ReactNode }[];
}

// Canonical, authored documents. This is a revision date, not a request timestamp.
const REVISION = { iso: '2026-10-01', label: '1 de outubro de 2026' };

export const termsOfUse: LegalDocumentContent = {
  title: 'Termos de Uso',
  revision: REVISION,
  introduction:
    'Estes termos descrevem as condições de acesso e uso do Delfrance, um sistema de gestão empresarial (ERP) e de relacionamento com clientes (CRM).',
  sections: [
    {
      id: 'finalidade',
      title: '1. Finalidade e aplicação',
      content: (
        <>
          <p>
            O Delfrance reúne ferramentas para cadastros, produtos, estoque, pedidos, pagamentos,
            documentos fiscais, atendimento e integrações comerciais. As funcionalidades disponíveis
            dependem das configurações e das permissões concedidas pela organização que opera o
            sistema.
          </p>
          <p>
            Estes termos se aplicam ao uso da instalação do Delfrance por pessoas autorizadas pela
            organização responsável. A consulta às páginas legais é pública e não exige conta.
            Contratos de trabalho, fornecimento, compra e venda ou prestação de serviços continuam
            sujeitos às suas próprias condições e à legislação aplicável.
          </p>
          <p>
            A leitura destes documentos não constitui consentimento geral para o tratamento de dados
            pessoais. As finalidades e as condições desse tratamento são descritas na{' '}
            <Link href="/politica-privacidade" prefetch={false}>
              Política de Privacidade
            </Link>
            .
          </p>
        </>
      ),
    },
    {
      id: 'acesso',
      title: '2. Acesso e permissões',
      content: (
        <>
          <p>
            O acesso ao ERP depende de credenciais e autorização. A criação de contas e a concessão,
            alteração ou revogação de permissões são administradas pela organização responsável. Ter
            acesso a uma funcionalidade não autoriza o uso dos dados para finalidades estranhas às
            atividades para as quais o acesso foi concedido.
          </p>
          <p>
            Use apenas a sua conta e as permissões atribuídas a ela. Informe ao responsável pela
            administração do sistema quando deixar de precisar de acesso ou identificar uma
            permissão incompatível com suas atividades.
          </p>
        </>
      ),
    },
    {
      id: 'credenciais',
      title: '3. Proteção das credenciais e do dispositivo',
      content: (
        <>
          <p>
            Mantenha suas credenciais confidenciais, não compartilhe senhas e proteja o dispositivo
            utilizado para acessar o sistema. Encerre a sessão ao terminar o uso, especialmente em
            dispositivos compartilhados. A sessão e determinados dados do ERP podem permanecer
            armazenados no navegador para facilitar o uso do sistema.
          </p>
          <p>
            Comunique prontamente à organização responsável qualquer suspeita de acesso indevido,
            perda de dispositivo ou exposição de credenciais, para que sejam avaliadas as medidas de
            proteção e de recuperação de acesso.
          </p>
        </>
      ),
    },
    {
      id: 'uso-responsavel',
      title: '4. Uso responsável',
      content: (
        <>
          <p>Utilize o Delfrance de forma lícita e dentro das suas atribuições. Não é permitido:</p>
          <ul>
            <li>Acessar, extrair ou divulgar dados sem autorização ou sem finalidade legítima.</li>
            <li>
              Contornar controles de acesso, usar credenciais de terceiros ou explorar
              vulnerabilidades.
            </li>
            <li>
              Introduzir código malicioso, prejudicar a disponibilidade do sistema ou alterar
              registros de forma fraudulenta.
            </li>
            <li>
              Inserir conteúdo que viole direitos de terceiros, obrigações de confidencialidade ou a
              legislação.
            </li>
          </ul>
          <p>
            Relate falhas de segurança de forma confidencial à organização responsável. Evite
            divulgar dados pessoais ou detalhes que permitam explorar a falha.
          </p>
        </>
      ),
    },
    {
      id: 'dados-inseridos',
      title: '5. Dados inseridos e decisões de negócio',
      content: (
        <>
          <p>
            Insira informações necessárias, pertinentes e corretas. Antes de cadastrar dados de
            clientes, fornecedores ou outras pessoas, verifique se a organização possui uma
            finalidade e uma hipótese legal adequadas para o tratamento. Evite inserir dados
            pessoais sensíveis ou informações de crianças e adolescentes quando não forem
            necessários e autorizados.
          </p>
          <p>
            Revise valores, destinatários, documentos fiscais, informações de produtos e demais
            dados antes de confirmar operações. O sistema auxilia a gestão, mas não substitui a
            avaliação de profissionais responsáveis por decisões contábeis, fiscais, jurídicas ou
            comerciais.
          </p>
        </>
      ),
    },
    {
      id: 'integracoes',
      title: '6. Integrações e serviços de terceiros',
      content: (
        <>
          <p>
            Quando utilizadas, as integrações podem transmitir dados a serviços de pagamento,
            transporte, emissão fiscal, marketplaces e comunicação. A organização responsável
            administra as contas conectadas e deve avaliar as condições de uso e as políticas de
            privacidade desses serviços.
          </p>
          <p>
            O funcionamento de cada integração também depende da disponibilidade, dos requisitos e
            das decisões do respectivo fornecedor. Mensagens de sucesso ou status devem ser
            analisadas no contexto da operação; uma tentativa de envio não equivale, por si só, à
            conclusão de uma venda, pagamento, emissão fiscal ou entrega.
          </p>
        </>
      ),
    },
    {
      id: 'inteligencia-artificial',
      title: '7. Recursos de inteligência artificial',
      content: (
        <>
          <p>
            Se utilizados, recursos de inteligência artificial podem auxiliar na preparação de
            atributos, descrições e informações de produtos ou tabelas de medidas. Para gerar as
            sugestões, o serviço pode receber os textos, imagens e instruções envolvidos na
            solicitação.
          </p>
          <p>
            Sugestões podem conter erros ou informações imprecisas. Revise o resultado antes de
            aplicá-lo ou publicá-lo e não envie dados pessoais ou informações confidenciais sem
            necessidade e autorização. A decisão de uso permanece com a pessoa autorizada e com a
            organização responsável.
          </p>
        </>
      ),
    },
    {
      id: 'disponibilidade',
      title: '8. Disponibilidade e manutenção',
      content: (
        <>
          <p>
            O sistema pode passar por manutenção, atualizações ou interrupções relacionadas à
            infraestrutura, à conexão de internet ou a serviços externos. Não há promessa de
            disponibilidade ininterrupta ou de ausência de falhas.
          </p>
          <p>
            A organização responsável deve definir procedimentos compatíveis com suas necessidades
            de continuidade, recuperação e conferência das operações. Condições de suporte ou níveis
            de serviço especificamente contratados continuam sujeitos ao respectivo contrato.
          </p>
        </>
      ),
    },
    {
      id: 'suspensao',
      title: '9. Suspensão e encerramento de acesso',
      content: (
        <>
          <p>
            O acesso pode ser restringido ou encerrado pela organização responsável quando houver
            alteração de atribuições, término do vínculo, risco à segurança ou uso incompatível com
            estas condições. A medida deve considerar a necessidade, a proporcionalidade e as
            obrigações legais e contratuais aplicáveis.
          </p>
          <p>
            Encerrar uma conta não implica a exclusão automática de todos os registros vinculados a
            ela. Dados necessários para obrigações legais, registros de operações e exercício
            regular de direitos podem precisar ser conservados, conforme a Política de Privacidade.
          </p>
        </>
      ),
    },
    {
      id: 'licenca',
      title: '10. Código aberto e direitos aplicáveis',
      content: (
        <>
          <p>
            O código-fonte deste projeto é disponibilizado sob a licença Apache-2.0. Estes termos
            regulam o uso da instalação do sistema e não revogam nem restringem as permissões
            concedidas pela licença do código. Marcas, dados empresariais e conteúdo de terceiros
            podem estar sujeitos a direitos e condições próprios.
          </p>
          <p>
            Nenhuma disposição destes termos afasta responsabilidades ou direitos que a legislação
            torne obrigatórios. Relações de consumo, quando existentes, permanecem sujeitas às
            proteções aplicáveis do Código de Defesa do Consumidor.
          </p>
        </>
      ),
    },
    {
      id: 'alteracoes-e-contato',
      title: '11. Alterações, legislação e contato',
      content: (
        <>
          <p>
            Estes termos podem ser atualizados para refletir alterações no sistema ou na legislação.
            A versão vigente e sua data de atualização serão disponibilizadas nesta página. Mudanças
            relevantes devem ser comunicadas às pessoas afetadas por meios adequados ao
            relacionamento.
          </p>
          <p>
            Aplica-se a legislação brasileira, preservadas as regras legais de competência e os
            direitos das partes. Questões sobre acesso, uso do sistema ou estes termos devem ser
            direcionadas à organização responsável pela operação do Delfrance.
          </p>
        </>
      ),
    },
  ],
};

export const privacyPolicy: LegalDocumentContent = {
  title: 'Política de Privacidade',
  revision: REVISION,
  introduction:
    'Esta política explica o tratamento de dados pessoais relacionado à operação do Delfrance ERP e CRM e à consulta de suas páginas legais.',
  sections: [
    {
      id: 'responsaveis',
      title: '1. Responsáveis pelo tratamento',
      content: (
        <>
          <p>
            A organização responsável pela operação do Delfrance define as finalidades e as
            condições essenciais do tratamento de dados realizado em suas atividades. Nessa
            condição, atua como controladora e responde pelo atendimento aos direitos dos titulares.
          </p>
          <p>
            Fornecedores de infraestrutura ou serviços podem atuar como operadores, seguindo
            instruções da controladora, ou como controladores de operações próprias, conforme o
            serviço e a relação contratual. A licença de código aberto não transforma os autores do
            software em controladores dos dados de toda instalação do Delfrance.
          </p>
        </>
      ),
    },
    {
      id: 'dados-e-origem',
      title: '2. Dados tratados e sua origem',
      content: (
        <>
          <p>
            O ERP pode tratar os dados abaixo, conforme as atividades realizadas e os recursos
            utilizados. Nem todas as categorias se aplicam a todas as pessoas:
          </p>
          <ul>
            <li>
              Dados cadastrais e de contato, como nome, CPF ou CNPJ, e-mail, telefone e endereço de
              clientes, fornecedores e usuários autorizados.
            </li>
            <li>
              Dados de conta e acesso, como identificação do usuário, e-mail, permissões e
              informações de autenticação gerenciadas pelo serviço de identidade.
            </li>
            <li>
              Dados de operações comerciais, como pedidos, valores, pagamentos, entregas e
              documentos fiscais.
            </li>
            <li>
              Dados de atendimento, como mensagens, contatos e arquivos enviados pelos canais de
              comunicação utilizados.
            </li>
            <li>
              Registros de alterações, informações técnicas e eventos necessários ao funcionamento,
              à segurança e à conferência das operações.
            </li>
          </ul>
          <p>
            Os dados podem ser fornecidos pelo próprio titular, inseridos por pessoas autorizadas,
            importados de registros da organização ou recebidos de serviços integrados utilizados em
            vendas, pagamentos, logística e atendimento.
          </p>
          <p>
            Dados sensíveis e dados de crianças ou adolescentes exigem avaliação específica de
            necessidade, hipótese legal e proteção. A existência de um campo livre ou de uma função
            de anexos não autoriza sua coleta indiscriminada.
          </p>
        </>
      ),
    },
    {
      id: 'finalidades-e-bases',
      title: '3. Finalidades e hipóteses legais',
      content: (
        <>
          <p>
            O tratamento deve se limitar aos dados necessários e possuir uma hipótese legal adequada
            para cada operação. Conforme a relação e a finalidade, podem ser aplicáveis:
          </p>
          <ul>
            <li>
              Execução de contrato ou procedimentos preliminares solicitados pelo titular, para
              processar pedidos, pagamentos, entregas e atendimento relacionado.
            </li>
            <li>
              Cumprimento de obrigação legal ou regulatória, para emissão e conservação de
              documentos fiscais e outros registros exigidos.
            </li>
            <li>
              Exercício regular de direitos, para comprovar operações e tratar questões em processos
              judiciais, administrativos ou arbitrais.
            </li>
            <li>
              Legítimo interesse, quando cabível e após avaliação da necessidade e dos direitos do
              titular, para segurança, prevenção de uso indevido e continuidade das atividades.
            </li>
            <li>
              Consentimento, quando necessário para uma finalidade específica, obtido de forma
              livre, informada e inequívoca e sujeito à revogação.
            </li>
          </ul>
          <p>
            A organização responsável deve avaliar e documentar a hipótese aplicável; esta lista não
            autoriza todas as operações de forma genérica. Consultar a política, entrar no sistema
            ou manter uma relação comercial não equivale a consentir com finalidades opcionais.
          </p>
        </>
      ),
    },
    {
      id: 'compartilhamento',
      title: '4. Compartilhamento e integrações',
      content: (
        <>
          <p>
            Dados podem ser disponibilizados a pessoas autorizadas da organização e a prestadores
            necessários às atividades, observados finalidade, necessidade, controles de acesso e
            obrigações aplicáveis. Dependendo dos recursos utilizados, isso pode incluir:
          </p>
          <ul>
            <li>
              Google Cloud e Firebase, para hospedagem, autenticação, banco de dados, arquivos e
              processamento.
            </li>
            <li>Mercado Pago e outros serviços utilizados no fluxo de pagamento.</li>
            <li>
              Melhor Envio e transportadores envolvidos na cotação, na contratação e no
              acompanhamento de entregas.
            </li>
            <li>
              Mercado Livre e Shopee, quando suas contas estiverem conectadas para operações de
              marketplace.
            </li>
            <li>WhatsApp/Meta, quando utilizados no atendimento e na comunicação.</li>
            <li>
              Autoridades fiscais e outros órgãos competentes, quando necessário para obrigações
              legais ou requisições legítimas.
            </li>
          </ul>
          <p>
            Utilizar uma integração pode exigir o envio de dados necessários à operação
            correspondente. Os fornecedores também possuem condições e políticas próprias para
            tratamentos sob sua responsabilidade. A organização deve avaliar esses serviços e
            restringir o compartilhamento ao necessário.
          </p>
        </>
      ),
    },
    {
      id: 'ia',
      title: '5. Recursos de inteligência artificial',
      content: (
        <>
          <p>
            Quando uma pessoa autorizada utiliza um recurso de IA, textos, imagens e instruções
            relacionados à solicitação podem ser enviados ao serviço de modelos Google/Vertex AI. Os
            recursos existentes auxiliam na preparação de informações de produtos e tabelas de
            medidas.
          </p>
          <p>
            A organização deve limitar o conteúdo enviado ao necessário, avaliar as condições do
            fornecedor e orientar a revisão humana dos resultados. O uso desses recursos não deve
            servir para inserir dados pessoais ou informações confidenciais sem finalidade e
            autorização adequadas.
          </p>
        </>
      ),
    },
    {
      id: 'transferencias',
      title: '6. Transferências internacionais',
      content: (
        <>
          <p>
            A utilização de serviços de nuvem e integrações pode envolver armazenamento ou
            processamento de dados fora do Brasil. A localização e o fluxo dependem da
            infraestrutura e dos serviços efetivamente utilizados.
          </p>
          <p>
            Quando houver transferência internacional, a organização responsável deve verificar a
            hipótese legal e o mecanismo aplicáveis, conforme a LGPD e a{' '}
            <a href="https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024">
              Resolução CD/ANPD nº 19/2024
            </a>
            . Isso pode envolver decisões de adequação, cláusulas contratuais ou outros mecanismos
            admitidos pela legislação. Esta política não declara que um mecanismo contratual
            específico já tenha sido adotado para todos os fornecedores.
          </p>
        </>
      ),
    },
    {
      id: 'navegador-e-paginas-publicas',
      title: '7. Navegador e páginas públicas',
      content: (
        <>
          <p>
            No ERP autenticado, o navegador pode manter a sessão e armazenar dados em IndexedDB,
            armazenamento local e cache para persistência de acesso e funcionamento do sistema. Essa
            persistência requer cuidado adicional em dispositivos compartilhados. As opções do
            navegador permitem remover dados locais; isso pode exigir novo login e nova leitura das
            informações necessárias.
          </p>
          <p>
            Estas páginas legais não têm formulários, publicidade ou ferramentas de análise de
            navegação adicionadas pela aplicação e não inicializam o serviço de autenticação do ERP.
            A infraestrutura de hospedagem pode registrar informações técnicas das requisições, como
            endereço IP, data, caminho acessado e dados do navegador, para operação e segurança.
          </p>
          <p>
            Tecnologias ou finalidades opcionais que venham a ser adicionadas devem ser avaliadas e
            informadas de forma específica, com escolhas adequadas quando exigidas. A navegação não
            substitui consentimento quando ele for necessário.
          </p>
        </>
      ),
    },
    {
      id: 'retencao',
      title: '8. Conservação e eliminação',
      content: (
        <>
          <p>
            Os dados devem ser conservados pelo tempo necessário às finalidades informadas e às
            obrigações aplicáveis. Prazos variam conforme a categoria, a relação com o titular e
            requisitos fiscais, contratuais ou de exercício regular de direitos.
          </p>
          <p>
            O fim do vínculo ou uma solicitação de exclusão não determina a eliminação imediata de
            registros cuja conservação seja legalmente necessária. Encerrada a necessidade, cabe à
            organização avaliar a eliminação ou anonimização, observadas as hipóteses de conservação
            do art. 16 da LGPD e as condições dos serviços utilizados.
          </p>
        </>
      ),
    },
    {
      id: 'seguranca-e-incidentes',
      title: '9. Segurança e incidentes',
      content: (
        <>
          <p>
            O ERP utiliza autenticação, permissões de acesso e registros de operações. A organização
            responsável deve manter medidas técnicas e administrativas adequadas ao risco,
            administrar contas e fornecedores e orientar as pessoas que acessam os dados.
          </p>
          <p>
            Nenhum sistema oferece segurança absoluta. Suspeitas de acesso indevido ou exposição
            devem ser comunicadas à organização responsável para investigação, contenção e avaliação
            das providências necessárias. Incidentes que possam causar risco ou dano relevante
            exigem avaliação e comunicação à ANPD e aos titulares nos termos e prazos da{' '}
            <a href="https://www.gov.br/anpd/pt-br/canais_atendimento/agente-de-tratamento/comunicado-de-incidente-de-seguranca-cis">
              regulamentação de incidentes de segurança
            </a>
            .
          </p>
        </>
      ),
    },
    {
      id: 'direitos',
      title: '10. Direitos dos titulares e solicitações',
      content: (
        <>
          <p>Nos termos da LGPD e conforme as condições aplicáveis, o titular pode solicitar:</p>
          <ul>
            <li>Confirmação da existência de tratamento e acesso aos seus dados.</li>
            <li>Correção de informações incompletas, inexatas ou desatualizadas.</li>
            <li>
              Anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados
              em desconformidade com a lei.
            </li>
            <li>Portabilidade, observadas a regulamentação aplicável e as proteções legais.</li>
            <li>
              Eliminação de dados tratados com consentimento, ressalvadas as hipóteses legais de
              conservação.
            </li>
            <li>
              Informação sobre compartilhamento, sobre a possibilidade de negar consentimento e
              sobre as consequências dessa escolha.
            </li>
            <li>
              Revogação do consentimento e oposição a tratamento irregular realizado com fundamento
              em outra hipótese legal.
            </li>
            <li>
              Revisão de decisões tomadas unicamente com base em tratamento automatizado que afetem
              seus interesses, quando aplicável.
            </li>
          </ul>
          <p>
            Direcione sua solicitação à organização responsável pelo tratamento. Pode ser necessária
            a confirmação proporcional de identidade para proteger os dados contra acesso indevido.
            As solicitações devem ser analisadas gratuitamente e respondidas nos prazos e condições
            previstos na legislação, com explicação quando houver impedimento legal ao atendimento.
          </p>
          <p>
            Também é possível apresentar reclamação à{' '}
            <a href="https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados">ANPD</a> ou aos órgãos
            competentes, conforme as condições aplicáveis. A disponibilização de um canal de
            privacidade não implica, por si só, a designação formal de um encarregado.
          </p>
        </>
      ),
    },
    {
      id: 'atualizacoes',
      title: '11. Atualizações desta política',
      content: (
        <>
          <p>
            Esta política pode ser revisada para refletir mudanças nas atividades, nos serviços ou
            na legislação. A data no início do documento identifica a revisão do texto. Alterações
            relevantes devem ser informadas por meios adequados, preservando os direitos do titular.
          </p>
          <p>
            Uma alteração de política não amplia automaticamente as finalidades de tratamento nem
            substitui a obtenção de novo consentimento quando este for necessário.
          </p>
        </>
      ),
    },
    {
      id: 'referencias',
      title: '12. Referências oficiais',
      content: (
        <>
          <p>
            As referências abaixo permitem consultar a legislação e orientações utilizadas neste
            documento:
          </p>
          <ul>
            <li>
              <a href="https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm">
                Lei Geral de Proteção de Dados Pessoais — Lei nº 13.709/2018
              </a>
              .
            </li>
            <li>
              <a href="https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados">
                ANPD — informações e direitos dos titulares
              </a>
              .
            </li>
            <li>
              <a href="https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_orientativo_cookies_e_protecao_de_dados_pessoais">
                ANPD — Cookies e proteção de dados pessoais
              </a>
              .
            </li>
          </ul>
        </>
      ),
    },
  ],
};
