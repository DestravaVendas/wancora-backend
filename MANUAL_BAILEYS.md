# MANUAL TÉCNICO DEFINITIVA: BAILEYS (ATUALIZADO)

**Versão da Documentação:** 6.0 (Hyper-Density Technical Specification & Implementation Roadmap - Abril/2026)
**Escopo:** Engenharia Reversa, Arquitetura de Protocolo, Sincronização de Dados, Estabilidade de Longo Prazo, Prevenção de Banimentos e Plano de Melhoria para o Wancora Backend.

Este documento é a fonte única da verdade para o ecossistema Baileys. Ele consolida uma auditoria exaustiva linha a linha do repositório oficial `@whiskeysockets/baileys` (Abril/2026), integrando todas as recomendações estratégicas para o `wancora-backend`.

---

## 1. ARQUITETURA E ENGENHARIA DE PROTOCOLO (BLUEPRINT BRUTO)

A biblioteca Baileys opera como uma implementação "Headless" do protocolo proprietário do WhatsApp Web, comunicando-se diretamente via WebSockets sem a necessidade de uma interface gráfica.

### 1.1. Anatomia do Ecossistema (Mapeamento de Arquivos Críticos)

A estrutura modular do Baileys divide responsabilidades críticas. Para manutenção e debugging avançado, consulte este mapa:

**Módulo de Socket (Core & Transport):**
*   **src/Socket/socket.ts:** O orquestrador central. Define a função `makeSocket`. Gerencia o handshake inicial (Noise Protocol), ciclo de vida da conexão TCP/WS e roteamento de stanzas. **Importância: Alta.**
*   **src/Socket/messages-send.ts:** Motor de envio. Responsável por construir a estrutura Protobuf, encriptar o payload com chaves Signal (SenderKey) e despachar para o socket. **Importância: Crítica.**
*   **src/Socket/messages-recv.ts:** Motor de recebimento. Ouve eventos do socket, desencripta pacotes recebidos, processa recibos de leitura (delivery/read receipts) e notifica a aplicação via `messages.upsert`. **Importância: Crítica.**
*   **src/Socket/chats.ts:** [CRÍTICO] Gerenciador de estado de chats e app-state. Lida com sincronização de contatos, fotos de perfil, status de presença e patches de sincronização (`WAPatchName`). **Importância: Alta.**
*   **src/Socket/groups.ts:** Gerenciador de comunidades e grupos. Contém a lógica para criar grupos, alterar metadados e gerenciar participantes.
*   **src/Socket/business.ts:** Interface com a API Business (Catálogos, Lojas, Pedidos).
*   **src/Socket/newsletter.ts:** [NOVO] Suporte nativo para Canais (Newsletters), incluindo criação, edição e reações.

**Módulo de Utilitários e Criptografia (O "Cérebro"):**
*   **src/Utils/use-multi-file-auth-state.ts:** Implementação de referência para persistência de sessão. Divide o estado de autenticação em múltiplos arquivos JSON para evitar corrupção de dados. **Importância: Alta.**
*   **src/Utils/message-retry-manager.ts:** [CRÍTICO] Gerenciador de retentativas e recuperação de sessão. Essencial para tratar erros de "Bad MAC" e recriar sessões Signal automaticamente. **Importância: Vital para Estabilidade.**
*   **src/Utils/history.ts:** [ATUALIZADO] Processador de sincronização de histórico. Lida com `INITIAL_BOOTSTRAP`, `FULL` e `ON_DEMAND` syncs, incluindo mapeamentos LID-PN. **Importância: Alta.**
*   **src/Utils/process-message.ts:** [NOVO] Normalizador de mensagens. Limpa JIDs, corrige chaves de reações/enquetes e filtra mensagens de protocolo. **Importância: Alta.**
*   **src/Utils/messages-media.ts:** Manipulador de binários. Contém a lógica de download, upload, cálculo de hash SHA-256 e desencriptação AES-256-CTR para mídias.
*   **src/Utils/chat-utils.ts:** [NOVO] Core para processamento de app-state e mutações de chat (arquivar, fixar, deletar).
*   **src/Signal/**: Implementação do protocolo de criptografia de ponta a ponta (Double Ratchet Algorithm, X3DH).

**Definição de Protocolo:**
*   **WAProto/index.js (gerado de .proto):** O "DNA" do WhatsApp. Define o schema binário exato de cada mensagem, nó e estrutura de dados aceita pelo servidor. **Importância: Fundamental.**

---

## 2. GESTÃO DE CONEXÃO E RESILIÊNCIA (ANTI-BAN & STABILITY)

A estabilidade de um bot depende de como ele lida com quedas de rede e erros de protocolo.

### 2.1. Configuração de Alta Disponibilidade (makeWASocket)

Para ambientes de produção (Serverless/Docker), a configuração deve priorizar cache e performance de I/O.

**Snippet de Inicialização Otimizada (v6.0):**

```typescript
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    DEFAULT_CACHE_TTLS
} from '@whiskeysockets/baileys'
import NodeCache from '@cacheable/node-cache'
import pino from 'pino'

async function connectToWhatsApp() {
    const logger = pino({ level: 'info' }) // Logs informativos para auditoria
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    // SEMPRE busque a versão mais recente para evitar bans por obsolescência
    const { version, isLatest } = await fetchLatestBaileysVersion()
    logger.info(`Usando Baileys v${version.join('.')} (Latest: ${isLatest})`)

    // PERFORMANCE: Cache para metadados de grupos e retentativas
    const msgRetryCounterCache = new NodeCache()
    const groupMetadataCache = new NodeCache({ stdTTL: DEFAULT_CACHE_TTLS.QUERIED_GROUP_METADATA })

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            // PERFORMANCE: Envolve o state.keys com um cache em memória.
            // Isso reduz drasticamente a leitura de disco durante rajadas de mensagens.
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        // ANTI-BAN: Simula um navegador Desktop real (Ubuntu/Chrome)
        browser: Browsers.ubuntu("Chrome"),
        // Otimização: Gera previews de link ricos
        generateHighQualityLinkPreview: true,
        // Otimização: Baixa todo o histórico antigo para popular o CRM
        syncFullHistory: true, 
        // COMPORTAMENTO HUMANO: Aparece online ao conectar
        markOnlineOnConnect: true,
        // RESILIÊNCIA: Retry Logic para mensagens falhas
        msgRetryCounterCache,
        groupMetadataCache,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        getMessage: async (key) => {
            // OBRIGATÓRIO: Implementar busca no banco de dados (Supabase/Postgres)
            // Se retornar undefined, o Baileys não conseguirá processar retentativas de decriptografia (Bad MAC)
            return await getMessageFromDB(key) 
        }
    })

    sock.ev.on('creds.update', saveCreds)
    return sock
}
```

### 2.2. Tratamento Técnico de Desconexão (DisconnectReason)

O evento `connection.update` fornece códigos de erro cruciais do Boom Error. A lógica abaixo é baseada no `message-retry-manager.ts` oficial.

**Códigos de Erro e Procedimentos:**

*   **401 (loggedOut):** A sessão foi encerrada pelo celular (Menu "Sair" ou desconexão remota).
    *   *Ação:* DELETAR a pasta de autenticação (`rm -rf auth_info`) e reiniciar para gerar novo QR Code. Não tente reconectar.
*   **408 (timedOut):** O servidor demorou para responder.
    *   *Ação:* Reconectar imediatamente.
*   **411 (multideviceMismatch) / Bad MAC:** Corrupção nas chaves de criptografia multi-dispositivo.
    *   *Ação:* O Baileys oficial recomenda recriar a sessão Signal. Limpar chaves específicas ou re-autenticar se persistir.
*   **428 (connectionClosed):** Conexão fechada inesperadamente.
    *   *Ação:* Reconectar.
*   **440 (connectionReplaced):** Outra sessão ativa foi aberta com as mesmas credenciais (conflito).
    *   *Ação:* Não reconectar automaticamente. Alertar admin.
*   **500 (badSession):** Sessão inválida no servidor.
    *   *Ação:* Deletar auth e reiniciar.
*   **515 (restartRequired):** O servidor solicitou reinício (comum durante atualizações do WA).
    *   *Ação:* Reconectar imediatamente.

### 2.3. Pairing Code (Alternativa ao QR Code)
Em ambientes de nuvem (Render/AWS) onde a latência de renderização do QR Code pode causar falhas, o método de Pairing Code é preferível.

* **Implementação:**
    ```javascript
    if (usePairingCode && !sock.authState.creds.me) {
        const code = await sock.requestPairingCode(phoneNumber); // phoneNumber format: 5511999999999
        console.log(`Pairing Code: ${code}`);
    }
    ```
* **Vantagem:** O código é estático e dura mais tempo que o QR Code rotativo.

### 2.4. Monitoramento de Erros (Console Hijacking)
Para ambientes de produção sem acesso fácil ao terminal (Docker/Render), o Backend Wancora implementa um "sequestro" do `console.error`.
*   Como o Baileys utiliza `pino` logger por baixo dos panos, erros críticos de conexão e falhas de descriptografia que seriam apenas printados no terminal agora são capturados e enviados para a tabela `system_logs` no Supabase com a source `baileys`.
*   Isso permite diagnosticar quedas de conexão correlacionando com logs do banco de dados em tempo real.

---

## 3. SINCRONIZAÇÃO DE DADOS E PROTOCOLO "BARREIRA DE CORRIDA" (SYNC BARRIER)

Para evitar condições de corrida (Race Conditions) onde mensagens tentam ser salvas antes dos contatos existirem, o sistema implementa uma **Barreira de Sincronização Estrita** durante o evento `messaging-history.set`.

### 3.1. Fluxo de Execução Obrigatório (Full Data Sync)

1.  **Bloqueio (Lock):** Ao iniciar o sync, a flag `isProcessingHistory` é ativada.
2.  **Fase 1 - Contatos (Prioridade Absoluta):**
    *   O array `contacts` é processado primeiro.
    *   **LID-PN Mapping:** [CRÍTICO] Capture os mapeamentos `lidPnMappings`. O WhatsApp está migrando para LIDs (Logical IDs). Sem esse mapeamento, você não conseguirá identificar o número de telefone de contatos em grupos novos.
3.  **Fase 2 - Chats e Mensagens:**
    *   Após os contatos estarem no banco, processe `chats` e `messages`.
    *   Isso garante que a chave estrangeira do contato já exista ao salvar a mensagem.
4.  **Fase 3 - Enriquecimento (Fotos de Perfil):**
    *   O Baileys não envia fotos de perfil no sync inicial.
    *   **Ação:** Após o sync, itere sobre os contatos e chame `sock.profilePictureUrl(jid, 'image')` para baixar as URLs das fotos.

### 3.2. Vinculação de Mensagens e Integridade de Conversas (Message Linking)

Para garantir que mensagens de reações, enquetes e respostas (quoted) funcionem 100%:
1.  **Normalização de JIDs:** Use `jidNormalizedUser(jid)` para remover sufixos de dispositivos (`:1@s.whatsapp.net` -> `@s.whatsapp.net`).
2.  **Persistência de Chave Composta:** Salve o `messageId` e o `remoteJid` como chave primária composta no seu banco.
3.  **ContextInfo:** Ao receber uma mensagem, verifique `message.contextInfo.stanzaId` para vincular à mensagem que está sendo respondida.

---

## 4. MENSAGERIA AVANÇADA E FUNCIONALIDADES "REVELADAS"

Implementações baseadas na engenharia reversa de `WAProto.proto` para funcionalidades nativas.

### 4.1. Enquetes (Polls): A Solução Moderna para Menus

Diferente de botões (que falham no iOS/Desktop), as enquetes são nativas e criptografadas.

**Envio de Enquete:**
```typescript
await sock.sendMessage(remoteJid, {
    poll: {
        name: "Qual departamento deseja falar?",
        values: ["Comercial", "Suporte", "Financeiro"],
        selectableCount: 1 // 1 = Radio Button, >1 = Checkbox
    }
})
```

**Recebimento de Votos (Lógica Complexa):**
Os votos chegam como uma mensagem de atualização (`messages.update`). O payload contém um hash criptografado da opção escolhida.
```typescript
import { getAggregateVotesInPollMessage } from '@whiskeysockets/baileys'

sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
        if (update.update.pollUpdates) {
            const pollMsg = await getMessageFromDB(update.key) // Recupera a mensagem original do banco
            if (pollMsg) {
                const votes = getAggregateVotesInPollMessage({
                    message: pollMsg,
                    pollUpdates: update.update.pollUpdates,
                })
                console.log('Votos atualizados:', votes)
                // Salve os votos agregados no CRM
            }
        }
    }
})
```

### 4.2. PIX Nativo (Engenharia Native Flow)

O WhatsApp não possui um tipo "PIX". Utilizamos `interactiveMessage` com o componente `nativeFlowMessage` para criar o botão de cópia.

**Payload de Engenharia:**
```typescript
const pixPayload = {
    interactiveMessage: {
        header: { title: "PAGAMENTO PIX", hasMediaAttachment: false },
        body: { text: "Copie a chave abaixo para finalizar seu pedido." },
        footer: { text: "Segurança Garantida" },
        nativeFlowMessage: {
            buttons: [{
                name: "cta_copy",
                buttonParamsJson: JSON.stringify({
                    display_text: "COPIAR CHAVE PIX",
                    id: "copy_code",
                    copy_code: "00020126360014BR.GOV.BCB.PIX01..." // Chave Pix completa
                })
            }]
        }
    }
}

// O envio deve ser feito via relayMessage para garantir a estrutura exata
await sock.relayMessage(remoteJid, { viewOnceMessage: { message: pixPayload } }, { messageId: generatedId })
```

### 4.3. Simulação de Presença (Humanização & Anti-Ban)

Essencial para evitar detecção de automação.
```typescript
// Simulando digitação
await sock.sendPresenceUpdate('composing', remoteJid)
await delay(2000) // Delay variável baseado no tamanho do texto

// Simulando gravação de áudio
await sock.sendPresenceUpdate('recording', remoteJid)
await delay(5000) 

// Parando
await sock.sendPresenceUpdate('paused', remoteJid)
```

---

## 5. MANIPULAÇÃO DE MÍDIA E CRIPTOGRAFIA

O WhatsApp não envia o arquivo de mídia diretamente. Ele envia uma URL encriptada, uma chave (`mediaKey`) e metadados.

### 5.1. Download de Mídia (`src/Utils/messages-media.ts`)
Para baixar mídias, o Baileys utiliza `downloadContentFromMessage`.
```typescript
import { downloadContentFromMessage } from '@whiskeysockets/baileys'

const stream = await downloadContentFromMessage(message.imageMessage, 'image')
let buffer = Buffer.from([])
for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
}
// Salve o buffer no S3 ou Supabase Storage
```

### 5.2. Geração de Thumbnails e Waveforms
O Baileys tenta gerar miniaturas automaticamente usando `sharp` ou `jimp`.
*   **Imagens/Vídeos:** Gera um buffer JPEG de baixa resolução para o campo `jpegThumbnail`.
*   **Áudios:** Gera um `waveform` (Uint8Array) para visualização da onda sonora.

---

## 6. GESTÃO DE GRUPOS E COMUNIDADES (ADVANCED)

### 6.1. Criação e Hierarquia
```typescript
const group = await sock.groupCreate("Nome do Grupo", ["5511999999999@s.whatsapp.net"])
console.log('Grupo criado com ID:', group.id)
```
**Comunidades:** A implementação nativa reside em `src/Socket/newsletter.ts` e `src/Socket/groups.ts`. O processo envolve criar o grupo e, em seguida, linkar sub-grupos como `linkedParent`.

---

## 7. MÓDULO DE STATUS (STORIES)

O sistema de Status opera através do JID especial `status@broadcast`.

### 7.1. Postar Status
```typescript
// Status de Texto
await sock.sendMessage('status@broadcast', {
    text: "Meu Status do Dia!",
    backgroundArgb: 0xFF000000,
    font: 1
}, { statusJidList: [/* Contatos permitidos */] });

// Status de Mídia
await sock.sendMessage('status@broadcast', {
    image: { url: './foto.jpg' },
    caption: "Legenda"
});
```

---

## 8. PERFIL E CONFIGURAÇÕES (BUSINESS & USER)

### 8.1. Foto de Perfil (Avatar)
```typescript
const ppUrl = await sock.profilePictureUrl(jid, 'image') // Buscar
await sock.updateProfilePicture(jid, { url: './nova-foto.jpg' }) // Atualizar
```

### 8.2. Perfil Business (Metadados)
```typescript
await sock.updateBusinessProfile({
    description: "Atendimento Automático 24h",
    address: "Av. Paulista, 1000",
    email: "contato@empresa.com",
    website: ["https://empresa.com"],
    categories: [{ id: '123', name: 'Software' }]
})
```

---

## 9. ÁUDIO & PTT (WAVEFORMS)

Para que o áudio apareça como "Nota de Voz" (PTT):
1.  **Formato:** Deve ser `.ogg` com codec `libopus`.
2.  **Mimetype:** `audio/ogg; codecs=opus`.
3.  **Flag:** `ptt: true`.

**Conversão FFmpeg Obrigatória:**
```bash
ffmpeg -i input.mp4 -c:a libopus -b:a 64k -vbr on -compression_level 10 output.ogg
```

---

## 10. PLANO DE IMPLEMENTAÇÃO: WANCORA BACKEND (ESTABILIDADE & CONEXÃO)

Com base na auditoria do `wancora-backend`, estas são as implementações obrigatórias para garantir estabilidade a longo prazo.

### 10.1. Otimização do `makeWASocket` (`services/baileys/connection.js`)

**Configuração Recomendada:**
```typescript
const sock = makeWASocket({
    version: (await fetchLatestBaileysVersion()).version,
    logger: pinoLogger,
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pinoLogger),
    },
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: true,              // OBRIGATÓRIO para carregar histórico inicial
    markOnlineOnConnect: true,          // Simulação humana
    enableAutoSessionRecreation: true,  // [NOVO] Deixar o Baileys gerenciar sessões Signal
    msgRetryCounterCache: new NodeCache(),
    groupMetadataCache: new NodeCache({ stdTTL: 60 * 60 }),
    getMessage: async (key) => {
        // [MELHORIA] Buscar no Supabase para reconstruir mensagens em retentativas
        return await getMessageFromSupabase(key);
    }
});
```

### 10.2. Recuperação de Sessão e Erros de MAC

**Ação:** Substituir a lógica genérica de reconexão por uma baseada no `RetryReason` do Baileys.
*   **Erros de MAC (411/Bad MAC):** Acionar `sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: new Boom('Bad MAC', { statusCode: 411 }) } })` para forçar a recriação da sessão Signal, em vez de apenas reiniciar o processo.

---

## 11. SINCRONIZAÇÃO DE DADOS (FULL DATA SYNC & CRM)

### 11.1. Barreira de Sincronização Estrita (`services/baileys/listener.js`)

Para evitar que mensagens falhem ao serem salvas por falta de contatos, implemente o fluxo de fases no evento `messaging-history.set`:

1.  **Fase 1 (LID-PN Mapping):** Salvar todos os `lidPnMappings`. Isso é vital para identificar leads em grupos novos.
2.  **Fase 2 (Contatos):** Upsert massivo de `contacts` no Supabase.
3.  **Fase 3 (Chats & Mensagens):** Processar o histórico de mensagens somente após a Fase 2.

### 11.2. Enriquecimento de Leads (`services/crm/sync.js`)

**Ação:** Implementar rotina de download de fotos de perfil e metadados.
*   Após o sync inicial, disparar um worker para cada contato:
    ```typescript
    const ppUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
    const bizProfile = await sock.getBusinessProfile(jid).catch(() => null);
    await supabase.from('leads').update({ avatar_url: ppUrl, metadata: bizProfile }).eq('jid', jid);
    ```

---

## 12. SEGURANÇA E LIMITES (HARD RULES)

1.  **Rate Limit:** Não envie mais de 20 mensagens por minuto para contatos novos.
2.  **Versão:** Use `fetchLatestBaileysVersion()` para evitar detecção de cliente antigo.
3.  **Sessão:** Se receber erro `401`, pare o bot. Tentar reconectar repetidamente com sessão banida queima o IP do servidor.
4.  **LID Mapping:** Sempre salve o mapeamento LID-PN para garantir que o CRM não perca a identidade dos leads em grupos novos.

---

**Fim da Bíblia Técnica do Baileys.**
Este documento reflete a realidade bruta do Baileys em Abril de 2026 e deve ser seguido rigorosamente para garantir a integridade do Wancora Backend.

**Autor:** Manus AI (Baseado na Auditoria de Abril/2026)
