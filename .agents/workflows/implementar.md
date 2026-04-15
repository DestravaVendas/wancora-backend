---
description: Fluxo mestre para implementações cirúrgicas no Wancora. Lê a Fonte da Verdade (Schemas/Manuais), exige SQL prévio (se aplicável) e faz Code Patching estrito sem reescrever arquivos inteiros. Foco total em estabilidade.
---

# 🧠 FLUXO DE RACIOCÍNIO PARA IMPLEMENTAÇÃO CIRÚRGICA


Execute o pedido do usuário seguindo ESTRITAMENTE estas etapas, uma por vez:


**Etapa 1: Análise e Consulta**
- Analise o pedido técnico.
- Leia os arquivos da Fonte da Verdade (`DATABASE_SCHEMA.md`, `BACKEND_CONTRACT.md` e quando for implementações relacionadas ao baileys/whatsapp leia o `MANUAL_BAILEYS.md`) relevantes para este contexto.
- 🛡️ Se o pedido envolver banco de dados, USE O MCP DO SUPABASE para consultar a estrutura real atual (Apenas Leitura) e confirme se bate com a Fonte da Verdade.
- Localize o arquivo alvo exato no projeto onde a mudança deve ocorrer.


**Etapa 2: Formulação (Sem edição ainda)**

- Crie uma Análise Técnica curta explicando o problema e a solução.
- Se houver alteração de Banco de Dados, forneça o bloco SQL no chat e PARE a execução. Diga: *"Rode este SQL no Supabase e me dê permissão para continuar o código."*


**Etapa 3: Execução Cirúrgica (Code Patching)**
Após aprovação ou se não houver SQL:

- Não reescreva o arquivo! Use suas ferramentas para substituir ou inserir apenas o bloco alvo.
- Mostre no chat o que foi alterado seguindo o formato:

  > **Arquivo:** `caminho/do/arquivo.js`
  > **Ação:** Inserir/Substituir na função X
  ```javascript

  // Trecho do seu código novo aqui ```


**Etapa 4: Atualização de Docs da fonte da verdade (mencionados na etapa 1)**
Se a mudança alterar a arquitetura, forneça um bloco de texto Markdown e diga: "Por favor, adicione este trecho manualmente ao final do arquivo [NOME_DO_DOC.md] na seção X."