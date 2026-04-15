# 🗄️ WANCORA CRM - Database Schema Definitions v5.0

Este documento define a estrutura oficial do Banco de Dados Supabase (PostgreSQL).
**Regra:** Qualquer SQL gerado deve ser validado contra este arquivo.

## 1. Tabelas Core

### `companies` (Tenants)
Tabela mestre das organizações.
* `id`: uuid (PK)
* `name`: text
* `plan`: text
* `status`: text
* `ai_config`: jsonb
 * Estrutura: `{ "provider": "gemini", "apiKey": "...", "model": "gemini-1.5-flash" }`
* `storage_retention_days`: integer (Default: 30) - [NOVO] Ciclo de vida da mídia. Arquivos no Supabase mais antigos que isso são movidos para o Google Drive e deletados do bucket.

### `instances` (Conexões)
Gerencia o estado físico da conexão com o WhatsApp.
* `id`: uuid (PK)
* `company_id`: uuid (FK -> companies)
* `session_id`: text (Unique)
* `status`: text ('qrcode', 'connected', 'disconnected', 'connecting')
* `qrcode_url`: text
* `sync_status`: text ('waiting', 'importing_contacts', 'importing_messages', 'completed') - Controla a barra de progresso.
* `sync_percent`: integer (0-100) - Feedback visual para o usuário.
* `updated_at`: timestamptz
* `webhook_url`: text
* `webhook_enabled`: boolean (Default: false)
* `webhook_events`: text[] (Default: ['message.upsert'])

### `contacts` (Agenda)
Contatos brutos sincronizados do celular.
* `jid`: text (PK) - Ex: `551199999999@s.whatsapp.net`
* `company_id`: uuid (PK)
* `name`: text (Nome da agenda do celular e grupos - **Autoridade Máxima**)
* `verified_name`: text (Nome verificado do WhatsApp Business - **Autoridade Média**)
* `push_name`: text (Nome do perfil público - **Autoridade Baixa**)
* `is_business`: boolean (Default: false) - Identificado via API ou Sync.
* `profile_pic_url`: text (Sincronizado via Lazy Load e Realtime Refresh)
* `profile_pic_updated_at`: timestamptz (Controle de Cache de 24h)
* `is_ignored`: boolean (Default: false) - Se true, não vira Lead.
* `is_muted`: boolean (Default: false)
* `last_message_at`: timestamptz
* `last_seen_at`: timestamptz
* `is_online`: boolean
* `phone`: text (Telefone limpo para vínculo com Leads e Buscas)
* `unread_count`: integer (Default: 0) - Contador atômico atualizado via Trigger.
* `parent_jid`: text (Para vincular Grupos a Comunidades)
* `is_community`: boolean

### `baileys_auth_state`
Armazena chaves criptográficas e credenciais de sessão do WhatsApp (Multi-Device).
* `session_id`: text (PK)
* `data_type`: text (PK)
* `key_id`: text (PK)
* `payload`: jsonb
* `updated_at`: timestamptz

### `identity_map` (LID Resolver)
Tabela técnica essencial para o ecossistema Multi-Device (iOS/Android). O WhatsApp envia atualizações de presença e reações usando IDs ocultos (`@lid`) que não correspondem ao número de telefone. Esta tabela faz a ponte.
* `lid_jid`: text (PK) - O ID opaco (Ex: `123456@lid`)
* `phone_jid`: text - O ID real do telefone (Ex: `55119999@s.whatsapp.net`)
* `company_id`: uuid (PK, FK -> companies)
* `created_at`: timestamptz

### `leads` (CRM)
A entidade de negócio principal.
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `phone`: text (Vinculado ao contato)
* `name`: text (Nullable) - Pode ser NULL se o contato não tiver identificação. O Frontend formata o telefone.
* `status`: text ('new', 'open', 'won', 'lost', 'archived')
* `pipeline_stage_id`: uuid (FK)
* `owner_id`: uuid (FK)
* `position`: double precision
* `value_potential`: numeric
* `tags`: text[]
* `deadline`: timestamptz
* `lead_score`: integer (Default: 0)
* `temperature`: text ('cold', 'warm', 'hot')
* `custom_data`: jsonb (Campos personalizados)
* `next_appointment_at`: timestamptz
* `appointment_status`: text
* `type`: text ('b2c', 'b2b')
* `bot_status`: text ('active', 'paused', 'off')
* `reactions`: jsonb (Default: '[]')
* `poll_votes`: jsonb (Default: '[]')
*   **Constraint de Integridade:** `UNIQUE (company_id, phone)` - Impede fisicamente a criação de dois leads com o mesmo número na mesma empresa, forçando o Backend a tratar a duplicidade antes da inserção.
*   **Regra de Exclusão (Lead Guard):** O Trigger de banco `auto_create_lead_on_message` agora bloqueia *fisicamente* a criação de leads para:
    * Grupos (`@g.us`)
    * Newsletters (`@newsletter`)
    * Broadcasts de Status (`status@broadcast`)
    * Mensagens enviadas por mim (`from_me = true`)

### `lead_activities` (Logs & Timeline) [NOVO]
Registro de interações e auditoria.
* `id`: uuid (PK)
* `lead_id`: uuid (FK)
* `company_id`: uuid (FK)
* `type`: text ('note', 'log', 'call', 'meeting', 'email')
* `content`: text
* `created_by`: uuid (FK -> profiles)
* `created_at`: timestamptz

### `lead_links` (Recursos) [NOVO]
Links úteis atrelados ao lead.
* `id`: uuid (PK)
* `lead_id`: uuid (FK)
* `company_id`: uuid (FK)
* `title`: text
* `url`: text
* `created_at`: timestamptz

### `lead_checklists` (Tarefas) [NOVO]
To-do list interna do lead.
* `id`: uuid (PK)
* `lead_id`: uuid (FK)
* `company_id`: uuid (FK)
* `text`: text
* `is_completed`: boolean
* `deadline`: timestamptz
* `created_at`: timestamptz

### `messages` (Chat)
Histórico de mensagens.
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `session_id`: text
* `remote_jid`: text (O Chat ID - Grupo ou Pessoa)
* `participant`: text (Nullable) <- [NOVO] O ID real de quem enviou a mensagem (Vital para Grupos).
* `whatsapp_id`: text (Unique Index composto com remote_jid)
* `from_me`: boolean
* `content`: text (Para Cards, armazena o JSON com título/descrição/link)
* `transcription`: text (Nullable)
* `message_type`: text
* `media_url`: text
* `created_at`: timestamptz
* `delivered_at`: timestamptz
* `read_at`: timestamptz
* `reactions`: jsonb
* `poll_votes`: jsonb

### `custom_field_definitions` (Campos Personalizados do CRM)
Define os campos extras criados pelo usuário para enriquecer os dados de um Lead (além dos campos padrão).
Os valores preenchidos são armazenados na coluna `leads.custom_data` (JSONB), indexada pelo `label` deste campo.
* `id`: uuid (PK, Default: `gen_random_uuid()`)
* `company_id`: uuid (NOT NULL, FK -> companies)
* `label`: text (NOT NULL) - Nome exibido no formulário. Ex: "CNPJ", "Segmento".
* `type`: text (NOT NULL) - Tipo do campo. Valores esperados: `'text'` | `'number'` | `'date'` | `'select'` | `'checkbox'`.
* `options`: jsonb (Nullable) - Usado apenas quando `type = 'select'`. Armazena o array de opções possíveis. Ex: `["Varejo", "Indústria", "Serviços"]`.
* `created_at`: timestamptz (Default: `now()`)

### `products` (Catálogo) [NOVO]
Cache dos produtos sincronizados do WhatsApp Business.
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `product_id`: text (ID original do WA)
* `name`: text
* `description`: text
* `price`: numeric
* `currency`: text
* `image_url`: text
* `is_hidden`: boolean

### `pipelines` & `pipeline_stages`
Estrutura do Kanban.
* **`pipelines`**: `id`, `company_id`, `name`, `is_default`
* **`pipeline_stages`**: `id`, `pipeline_id`, `name`, `position` (int), `color`

### `agents` (IA & Personas)
Configuração dos Agentes Inteligentes (Junior, Pleno, Sênior).
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `name`: text
* `level`: text ('junior', 'pleno', 'senior')
* `prompt_instruction`: text - O "System Prompt" final compilado.
* `personality_config`: jsonb - **[ATUALIZADO]** Estrutura:
    * `role`, `tone`, `context`: Strings básicas.
    * `verbosity`: 'minimalist' | 'standard' | 'mixed'.
    * `emoji_level`: 'rare' | 'moderate' | 'frequent'.
    * `mental_triggers`: Array de strings (ex: ['scarcity', 'urgency']).
    * `negative_prompts`, `escape_rules`: Arrays de strings.
* `knowledge_config`: jsonb - Referências a arquivos.
* `flow_config`: jsonb - **[ATUALIZADO v5.2]** Estrutura:
    * `technique`: Técnica de vendas (SPIN, BANT, etc).
    * `timing`: Configuração de delay humano.
        * `min_delay_seconds`: integer (Padrão sugerido: 20s)
        * `max_delay_seconds`: integer (Padrão sugerido: 120s)
    * `response_mode`: text ('standard', 'verbose').
* `tools_config`: jsonb - Integrações (Drive, Agenda, CRM).
* `is_active`: boolean
* `instance_ids`: text[] (Default: '{}') - [NOVO v6.1] Lista de session_ids autorizados. Se vazio, atende todas as instâncias da empresa.
* `model`: text ('gemini-1.5-flash' - Modelo Padrão Comercial).

### `campaigns` (Motor de Disparos)
Gestão avançada de disparos em massa.
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `name`: text
* `message_template`: text
* `target_tags`: text[]
* `status`: text ('draft', 'pending', 'processing', 'completed', 'failed')
* `execution_mode`: text ('standard', 'warmup')
* `warmup_config`: jsonb (Configuração de aquecimento de chip)
* `stats`: jsonb (Contadores de leitura/envio em tempo real)
* `scheduled_at`: timestamptz

### `campaign_leads` (Fila de Disparo)
Relacionamento N:N rastreando o status de cada lead dentro de uma campanha.
* `id`: uuid (PK)
* `campaign_id`: uuid (FK)
* `lead_id`: uuid (FK)
* `status`: text ('pending', 'processing', 'sent', 'failed', 'replied')
* `sent_at`: timestamptz
* `error_log`: text

### `campaign_logs` (Histórico Técnico)
Logs detalhados de execução para auditoria.
* `id`: uuid (PK)
* `error_message`: text
* `status`: text

### `appointments` (Agenda Integrada & Tarefas)
Unificação de calendário e gerenciador de tarefas.
* `id`: uuid (PK)
* `user_id`: uuid (FK - Responsável/Dono da agenda)
* `lead_id`: uuid (FK - Opcional) -> Nullable pois pode ser tarefa pessoal.
* `title`: text
* `title`, `description`, `start_time`, `end_time`
* `start_time`: timestamptz
* `end_time`: timestamptz
* `status`: text ('pending', 'confirmed', 'cancelled')
* `is_task`: boolean (True = Checklist, False = Evento de Tempo)
* `completed_at`: timestamptz -> Se preenchido, a tarefa foi concluída.
* `category`: text -> Categoria visual (ex: 'Reunião', 'Pessoal').
* `color`: text -> Hex code para UI.
* `recurrence_rule`: jsonb (Ex: `{ "frequency": "weekly", "count": 10 }`)
* `meet_link`: text
* `origin`: text (Default: 'internal')
* `ai_summary`: text
* `reminder_sent`: boolean (Default: false) - Evita disparo duplicado pelo Worker.
* `confirmation_sent`: boolean (Default: false) - Controle de envio imediato.
* `send_notifications`: boolean (Default: true) - Toggle por evento.
* `custom_notification_config`: jsonb - Sobrescreve a regra global se preenchido.

### `availability_rules` (Agendamento Inteligente)
Define as regras de horários para o sistema de agendamento (tipo Calendly).
* `id`: uuid (PK)
* `company_id`: uuid (FK)
* `user_id`: uuid (FK - Nullable) - Se null, é uma agenda global/time.
* `name`: text - Nome descritivo (ex: "Mentoria 30min")
* `slug`: text (Unique) - URL amigável.
* `days_of_week`: integer[] - Array de dias ativos (0-6).
* `start_hour`: time
* `end_hour`: time
* `slot_duration`: integer
* `buffer_before`: integer
* `buffer_after`: integer
* `timezone`: text (Default: 'America/Sao_Paulo') - **[NOVO]** Fuso horário base para cálculos de agendamento e notificações.
* `is_active`: boolean
* `event_goal`: text (Default: 'Reunião')
* `event_location_type`: text ('online', 'presencial')
* `event_location_details`: text (Ex: "Google Meet", "Rua X...").
* `meeting_url`: text - **[NOVO]** Link padrão da reunião (ex: Google Meet fixo) usado como fallback.
* `cover_url`: text - Imagem de capa da página pública.
* `theme_config`: jsonb - Configurações visuais (cores, gradientes) da página pública.
* `notification_config`: jsonb (CRÍTICO) - Configurações de automação (Templates, Sessão de Envio).
  * Schema:
    ```json
    { 
      "sending_session_id": "uuid_ou_null",
      "admin_phone": "5511999999999", 
      "admin_notifications": [
        { "id": "uuid", "type": "on_booking", "active": true, "template": "Novo agendamento..." }
      ], 
      "lead_notifications": [
        { "id": "uuid", "type": "on_booking", "active": true, "template": "Confirmação..." }
      ] 
    }
    ```

### `automations` (Workflow)
Regras de automação (Gatilho -> Ação).
* `id`: uuid (PK)
* `trigger_type`: text (Ex: 'tag_added', 'pipeline_moved')
* `action_type`: text (Ex: 'send_message', 'create_task')
* `conditions`: jsonb
* `action_payload`: jsonb
* `is_active`: boolean

### `gamification_points` (Ranking)
Histórico de XP da equipe.
* `id`: uuid (PK)
* `user_id`: uuid (FK)
* `points`: integer
* `action_type`: text (Ex: 'closed_deal', 'added_lead')

### `scheduled_messages` (Agendamento de Envio)
Mensagens avulsas agendadas no chat.
* `id`: uuid (PK)
* `contact_jid`: text
* `content`: text
* `scheduled_at`: timestamptz
* `status`: text ('pending', 'sent', 'failed')

### `plans` & `subscriptions` (SaaS)
Gestão de planos do sistema.
* `id`: uuid
* `name`: text
* `price_monthly`: numeric
* `max_users`: integer
* `max_connections`: integer
* `features`: jsonb

### `webhook_logs` (Integrações) [NOVO]
Logs de disparos de eventos para sistemas externos (n8n, Typebot).
* `id`: uuid (PK)
* `instance_id`: uuid (FK -> instances)
* `event_type`: text (Ex: 'message.upsert')
* `status`: integer (HTTP Status Code)
* `payload`: jsonb
* `response_body`: text
* `created_at`: timestamptz

### `integrations_google` (Cloud Auth)
Armazena tokens OAuth2 para acesso ao Google Drive (Multi-Tenant).
* `company_id`: uuid (PK, FK -> companies) - Relação 1:1 estrita.
* `email`: text (Email da conta Google conectada).
* `access_token`: text
* `refresh_token`: text (Crítico para acesso offline/renovação).
* `token_type`: text
* `expiry_date`: bigint
* `updated_at`: timestamptz

### `drive_cache` (Sistema de Arquivos / Espelho)
Espelho local dos metadados do Drive para navegação instantânea (0ms latency).
* `id`: uuid (PK)
* `company_id`: uuid (FK -> companies)
* `google_id`: text (ID real do arquivo no Google Drive)
* `name`: text
* `mime_type`: text
* `web_view_link`: text (Link para visualização no navegador)
* `thumbnail_link`: text
* `size`: bigint
* `parent_id`: text (Suporte a estrutura de pastas, null = root)
* `is_folder`: boolean
* `updated_at`: timestamptz
* **Constraint:** `UNIQUE(company_id, google_id)`

### `system_config` (Global Settings) [NOVO]
Configurações globais do SaaS (Singleton).
* `id`: uuid (PK, Default Zero UUID `0000...`)
* `maintenance_mode`: boolean (Default: false) - Kill Switch global.
* `broadcast_active`: boolean (Default: false) - Banner de aviso.
* `broadcast_message`: text
* `broadcast_level`: text ('info', 'warning', 'error')
* `updated_at`: timestamptz

### `system_logs` (Telemetria & Erros) [ATUALIZADO v5.3]
A "Caixa Preta" do Wancora. Agora com suporte a Console Hijacking.
* `id`: uuid (PK)
* `level`: text ('info', 'warn', 'error', 'fatal')
* `source`: text ('frontend', 'backend', 'worker', 'baileys')
* `message`: text
* `metadata`: jsonb (Agora inclui `stack_trace`, `v8_heap_usage` e `uptime`)
* `company_id`: uuid (Nullable)
* `user_id`: uuid (Nullable)
* `created_at`: timestamptz

### `feedbacks` (Suporte & Bugs) [NOVO]
Canal direto do usuário para o Admin.
* `id`: uuid (PK)
* `user_id`: uuid (FK -> profiles)
* `company_id`: uuid (FK -> companies)
* `type`: text ('bug', 'suggestion', 'other')
* `content`: text
* `status`: text ('pending', 'viewed', 'resolved')
* `created_at`: timestamptz

### `referrals` (Growth) [NOVO]
Sistema de indicação.
* `id`: uuid (PK)
* `referrer_id`: uuid (FK -> profiles) - Quem indicou.
* `referred_user_id`: uuid (FK -> profiles) - Quem entrou.
* `status`: text ('pending', 'approved', 'paid')
* `created_at`: timestamptz

### `view_admin_clients` (Performance) [NOVO]
View otimizada para o painel administrativo listar clientes com dados agregados de perfil e empresa.

### `view_pending_reminders` (Worker de Lembretes) [VIEW]
View de performance utilizada exclusivamente pelo Worker de agendamentos (`appointmentWorker`).
Retorna todos os compromissos confirmados que precisam ter lembrete disparado nas próximas 24 horas,
filtrando apenas os que ainda não foram notificados (`reminder_sent = false`).

**Lógica do filtro:**
```sql
WHERE a.status = 'confirmed'
  AND a.reminder_sent = false
  AND a.start_time >= now()
  AND a.start_time <= (now() + INTERVAL '24 hours')

---

## 2. Funções RPC (Server-Side Logic)

Estas funções são vitais para a performance e lógica do sistema.

### `get_my_chat_list` (Inbox Core v5.0)
A query mais pesada do sistema. Retorna a lista de conversas com dados agregados de Leads, Mensagens, Contatos e Kanban.
*   **Parâmetro:** `p_company_id` (uuid)
*   **Retorno:** Tabela expandida contendo:
    *   Dados do Contato: `unread_count`, `profile_pic_url`, `name`, `push_name`, `is_muted`, `is_group`.
    *   **[NOVO]** Presença: `is_online`, `last_seen_at`.
    *   **[NOVO]** Dados do Lead: `lead_id`, `lead_status`, `lead_tags` (Array de etiquetas).
    *   **[NOVO]** Dados do Kanban: `pipeline_stage_id`, `stage_name` (Nome da Fase), `stage_color`.
    *   Mensagem: `last_message_content`, `last_message_type`, `last_message_at`.
*   **Regra de Ouro:** Apenas contatos **Com Mensagens** aparecem. Contatos ocultos (`is_ignored = true`) são filtrados.
*   **Hierarquia de Nome:** Agenda > Business > PushName > Telefone Formatado.

### `get_gamification_ranking`
Calcula o ranking de vendas e XP da equipe em um período.
*   **Parâmetros:** `p_company_id`, `p_start_date`, `p_end_date`
*   **Lógica:** XP = (Leads Ganhos * 1000) + (Valor Vendido / 10). Retorna `rank` calculado via window function.

### `get_sales_funnel_stats`
Retorna métricas do funil para gráficos.
*   **Parâmetros:** `p_company_id`, `p_owner_id` (Opcional)
*   **Retorno:** `stage_name`, `lead_count`, `total_value`, `color`.

### `get_recent_activity`
Feed unificado de atividades recentes (Novos leads + Vendas ganhas) para o Dashboard.
*   **Parâmetros:** `p_company_id`, `p_limit`

### `increment_campaign_count`
Incrementa contadores de campanha de forma atômica (sem concorrência de leitura/escrita).

### `link_identities`
Vincula um `LID` (ID oculto) ao `Phone JID` real na tabela `identity_map`.

### `search_drive_files` (IA + Drive) [FIXED v5.3]
Busca arquivos no cache do drive. Corrigido para retornar colunas explícitas e evitar erro de "return type change".
* **Parâmetros:** `p_company_id` (UUID), `p_query` (TEXT), `p_limit` (INT)
* **Retorno:** Tabela contendo:
    * `id` (UUID), `name` (TEXT), `drive_id` (TEXT), `mime_type` (TEXT), `web_view_link` (TEXT), `thumbnail_link` (TEXT), `size` (BIGINT), `created_at` (TIMESTAMPTZ).

### `move_lead_atomic` (Kanban — Atomicidade)
Move um Lead de estágio no Kanban de forma atômica, garantindo que a linha fique bloqueada na transação até a conclusão, evitando race conditions em arrastes simultâneos.
* **Parâmetros:** `p_lead_id` (uuid), `p_new_stage_id` (uuid), `p_new_position` (numeric)
* **Retorno:** `void`
* **Tabelas afetadas:** `leads` (UPDATE)
* **Segurança:** `SECURITY DEFINER`

---

### `reorder_pipeline_stages` (Kanban — Reordenação em Lote)
Recebe um array JSON com pares `{id, position}` e atualiza a posição de múltiplos estágios em uma única transação. Usado quando o usuário arrasta e reorganiza colunas do Kanban.
* **Parâmetro:** `p_updates` (jsonb) — Ex: `[{"id": "uuid", "position": 1}, ...]`
* **Retorno:** `void`
* **Tabelas afetadas:** `pipeline_stages` (UPDATE)

---

### `get_public_availability_by_slug` (Agendamento Público — Lookup)
Retorna os metadados públicos de uma agenda de agendamento pelo seu `slug`. Função chamada pela **página pública de agendamento** (tipo Calendly) sem autenticação.
* **Parâmetro:** `p_slug` (text)
* **Retorno:** Tabela com `rule_id`, `name`, `slug`, `days_of_week`, `start_hour`, `end_hour`, `slot_duration`, `event_goal`, `event_location_type`, `event_location_details`, `cover_url`, `theme_config`, `owner_name`, `owner_avatar`, `company_name`.
* **Tabelas envolvidas:** `availability_rules` ✕ `profiles` ✕ `companies`
* **Segurança:** `SECURITY DEFINER` (acesso público sem RLS)

---

### `get_busy_slots` (Agendamento Público — Conflitos)
Retorna os horários já ocupados (status `confirmed`) de um usuário em uma determinada data. Usado pela página pública para bloquear slots indisponíveis no calendário.
* **Parâmetros:** `p_rule_id` (uuid), `p_date` (date)
* **Retorno:** Tabela com `start_time` e `end_time` dos compromissos confirmados do dia.
* **Tabelas afetadas:** `appointments` (SELECT), `availability_rules` (SELECT)
* **Segurança:** `SECURITY DEFINER`

---

### `create_public_appointment` (Agendamento Público — Criação Atômica)
A função mais complexa do sistema de agendamento. Executada quando um visitante confirma um horário na página pública. Realiza em uma única transação atômica:
1. Valida se a agenda (`slug`) existe e está ativa.
2. Verifica conflito de horário em tempo real (evita double-booking).
3. **Lógica do 9º Dígito BR:** Busca o lead por até 2 variações do telefone (com/sem o nono dígito).
4. Faz **upsert do Lead**: cria se não existir, atualiza notas se já existir (sem sobrescrever o nome).
5. Cria o `appointment` com `origin = 'public_link'`.
6. Retorna JSON `{success: true, id: uuid}` ou `{error: "mensagem"}` — nunca quebra o frontend.
* **Parâmetros:** `p_slug`, `p_date`, `p_time`, `p_name`, `p_phone`, `p_email`, `p_notes` (todos text)
* **Retorno:** `json`
* **Tabelas afetadas:** `availability_rules`, `leads`, `appointments`, `pipeline_stages`
* **Segurança:** `SECURITY DEFINER`

---

### `get_contact_details` (Chat — Painel Lateral)
Retorna o perfil completo de um contato para o painel lateral do chat, incluindo dados agregados do Lead e do Kanban associado. Resolve automaticamente JIDs do tipo `@lid` para o JID canônico via `identity_map`.
* **Parâmetros:** `p_company_id` (uuid), `p_jid` (text)
* **Retorno:** Tabela com `jid`, `canonical_jid`, `name`, `push_name`, `phone`, `profile_pic_url`, `unread_count`, `last_message_at`, `is_group`, `is_community`, `is_online`, `lead_tags`, `stage_name`, `stage_color`.
* **Tabelas envolvidas:** `contacts` ✕ `identity_map` ✕ `leads` ✕ `pipeline_stages`

---

### `update_lead_name_safely` (Higiene — Atualização Segura de Nome)
Função utilitária chamada pelo backend para atualizar o nome de um Lead de forma segura. Só executa o UPDATE se o nome atual for `NULL`, `''` ou for um número puro. Nunca sobrescreve nomes humanos já cadastrados.
* **Parâmetros:** `p_company_id` (uuid), `p_phone` (text), `p_new_name` (text)
* **Retorno:** `void`
* **Tabelas afetadas:** `leads` (UPDATE)


---

## 3. Triggers & Automação

### `enforce_ignored_contact_rule` (Anti-Ghost)
Se um contato for marcado como ignorado (`is_ignored = true`), o Lead correspondente é deletado automaticamente.

### `sync_lid_to_phone_contact` (LID Sync)
Ao receber uma mensagem de um LID (`@lid`), verifica se já existe um Lead com o telefone correspondente e atualiza o contato principal, garantindo que a notificação apareça no chat correto.

### `auto_create_lead_on_message` (Smart Lead Guard)
Cria leads automaticamente ao receber mensagens, mas APENAS se o contato já tiver nome identificado (evita leads "fantasmas").

### `handle_updated_at`
Mantém a coluna `updated_at` sempre atualizada nas tabelas principais.

### `trigger_update_chat_stats` (Cérebro da Inbox)
*   **Alvo:** Tabela `messages` (AFTER INSERT).
*   **Função:** `handle_new_message_stats()`.
*   **Ação:** Sempre que uma nova mensagem entra:
    1. Atualiza `last_message_at` na tabela `contacts`.
    2. Se `from_me = false`, incrementa `unread_count` em +1.
    3. Garante que a conversa suba para o topo da lista instantaneamente.

### `on_profile_created_add_role` (Bootstrapping de Conta)
* **Alvo:** Tabela `profiles` (AFTER INSERT)
* **Função:** `handle_new_profile_role()`
* **Ação:** Ao criar um novo `profile`, insere automaticamente o role `'owner'` na tabela `user_roles` (com `ON CONFLICT DO NOTHING`). Garante que todo novo usuário registrado já tenha um papel atribuído imediatamente, sem intervenção manual.

---

### Sistema de Higiene de Contatos (Contact Name Guard)
Conjunto de funções trigger que garantem a qualidade dos nomes na tabela `contacts`. Operam em camadas:

#### `sanitize_contact_data` (Limpeza na Escrita)
* **Papel:** Usada como função de trigger em `BEFORE INSERT OR UPDATE` na tabela `contacts`.
* **Lógica:**
    1. Se `name` for um telefone (regex: apenas dígitos/espaços/`+-()`) ou contiver o JID bruto → seta `name = NULL`.
    2. **Fallback:** Se `name` ficou NULL e existe `push_name` válido → substitui `name` por `push_name`.

#### `auto_fix_contact_name` (Limpeza Reativa)
* Mesma lógica de `sanitize_contact_data`, mas implementada como função trigger separada. Atua como camada de segurança adicional para garantir que nomes numéricos ou JIDs brutos nunca persistam.

#### `fill_contact_name_fallback` (Preenchimento de Vácuo)
* Em `BEFORE INSERT OR UPDATE`: Se `name` for NULL, vazio ou igual ao `jid`, e existir um `push_name` válido → preenche `name` com `push_name`.

#### `sync_contact_name_to_lead` (Propagação Contato → Lead)
* **Função:** `SECURITY DEFINER`
* **Ação:** Após atualização de `name` ou `push_name` em `contacts`, propaga o melhor nome (Agenda > PushName) para o Lead correspondente via `phone`.
* **Regra de Segurança:** Só atualiza o Lead se o nome atual do Lead for `NULL`, numérico ou igual ao telefone. **Nunca sobrescreve nomes humanos já cadastrados.**

#### `auto_update_contact_name` (Placeholder / Legado)
* Função trigger presente no banco em estado de **stub** — corpo retorna `NEW` sem lógica. Mantida para compatibilidade de triggers existentes. **Não possui efeito prático atual.**

---

### Sistema de Integridade de Identidade LID/JID (Identity Guard)
Conjunto de triggers que operam em cascata para garantir que mensagens de IDs ocultos `@lid` sejam corretamente unificadas com o JID de telefone canônico.

#### `trg_auto_link_identity` → `auto_link_identity_on_message()`
* **Alvo:** `messages` (BEFORE INSERT)
* **Ação:** Ao inserir uma mensagem cujo `remote_jid` termina em `@lid`, busca em `contacts` se já existe um número de telefone correspondente e chama `link_identities()` para registrar o vínculo no `identity_map` proativamente.

#### `trg_message_phone_integrity` → `enforce_message_phone_integrity()`
* **Alvo:** `messages` (BEFORE INSERT OR UPDATE)
* **Ação:** Sanitiza a coluna `messages.phone`. Se o valor contiver `@lid` ou tiver mais de 14 caracteres (indicativo de JID inválido), seta `phone = NULL`, evitando dados corrompidos na base.

#### `trigger_update_messages_on_identity_link` → `update_messages_on_identity_link()`
* **Alvo:** `identity_map` (AFTER INSERT OR UPDATE)
* **Ação:** Quando um novo vínculo LID↔Phone é criado, retroativamente atualiza `messages.canonical_jid` e `messages.phone` para todas as mensagens já salvas com aquele `lid_jid` e cujo `canonical_jid` ainda estava nulo ou incorreto.

#### `trg_after_identity_link` → `handle_identity_link()`
* **Alvo:** `identity_map` (AFTER INSERT OR UPDATE)
* **Ação:** Versão mais agressiva da unificação retroativa. Além de atualizar `messages`, também migra o registro em `contacts` — alterando `contacts.jid` do LID para o `phone_jid` canônico e corrigindo `contacts.phone`.

#### `after_identity_map_upsert` → `trg_unify_messages_on_identity()`
* **Alvo:** `identity_map` (AFTER INSERT OR UPDATE)
* **Ação:** Variante de unificação de mensagens. Atualiza `messages.canonical_jid` e `messages.phone` para todas as mensagens onde `remote_jid = lid_jid`. Funciona em paralelo com `trigger_update_messages_on_identity_link` como camada de redundância.

> ⚠️ **Nota de Arquitetura:** Os três triggers em `identity_map` (`trigger_update_messages_on_identity_link`, `trg_after_identity_link`, `after_identity_map_upsert`) possuem sobreposição de responsabilidade. Foram criados em iterações diferentes da feature de LID. Monitorar se causam atualizações duplicadas redundantes em `messages`.


---

## 4. ⚡ Infraestrutura Realtime (Gaming Mode Support)
Para suportar a arquitetura de "Snapshot + Subscription" sem recarregar a página, as seguintes tabelas possuem **REPLICA IDENTITY FULL**. Isso obriga o Postgres a enviar o objeto `old` completo nos eventos de UPDATE/DELETE, permitindo que o Frontend sincronize listas sem refetch.

```sql
ALTER TABLE public.leads REPLICA IDENTITY FULL;
ALTER TABLE public.pipeline_stages REPLICA IDENTITY FULL;
ALTER TABLE public.contacts REPLICA IDENTITY FULL;
ALTER TABLE public.instances REPLICA IDENTITY FULL; -- Necessário para o Sync Indicator
ALTER TABLE public.messages REPLICA IDENTITY FULL; -- Necessário para o Chat
ALTER TABLE public.appointments REPLICA IDENTITY FULL; -- Necessário para o Calendário
ALTER TABLE public.lead_checklists REPLICA IDENTITY FULL; -- Para Tarefas
ALTER TABLE public.lead_links REPLICA IDENTITY FULL; -- Para Links
ALTER TABLE public.lead_activities REPLICA IDENTITY FULL;
```

## 5. Políticas de Segurança (RLS) & Performance

**RLS (Row Level Security):** A maioria das tabelas possui RLS ativado. O acesso é restrito via `company_id`. O Backend utiliza a `service_role key` para ignorar RLS durante processamentos em background (Workers).

**Funções Auxiliares de Segurança (RBAC):**
* `get_user_company_id()` → `STABLE SECURITY DEFINER`. Retorna o `company_id` do usuário autenticado via `profiles`. **É a âncora de todo isolamento multitenant.**
* `has_role(user_id, app_role)` → `STABLE SECURITY DEFINER`. Verifica se um usuário possui um determinado role via `user_roles`. Usado em políticas de escrita para `owners` e `admins`.
* `get_user_role(user_id)` → `SECURITY DEFINER`. Retorna o role do usuário como `text`.

**Cobertura de RLS por Tabela (Status Auditado em 2026-04-14):**

| Tabela | RLS | Política de Leitura | Política de Escrita |
|---|---|---|---|
| `companies` | ✅ | Própria empresa | Owner/Admin via service_role |
| `profiles` | ✅ | Próprio perfil | Próprio perfil |
| `user_roles` | ✅ | Próprio role | Owner da empresa |
| `instances` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `contacts` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `messages` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `leads` | ✅ | RBAC (Owner/Admin vê todos; Agent vê os seus) | RBAC por role |
| `lead_activities` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `lead_links` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `lead_checklists` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `pipelines` | ✅ | Isolamento por company_id | RBAC por role |
| `pipeline_stages` | ✅ | Isolamento por company_id | RBAC por role |
| `pipeline_assignments` | ✅ | Próprio usuário | Gerenciado por owner |
| `agents` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `campaigns` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `campaign_leads` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `campaign_logs` | ✅ | Isolamento por company_id | service_role apenas |
| `appointments` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `availability_rules` | ✅ | Isolamento + leitura pública por slug | Owner/Admin |
| `scheduled_messages` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `automations` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `products` | ✅ | Isolamento por company_id | service_role apenas |
| `integrations_google` | ✅ | Própria empresa | Própria empresa |
| `drive_cache` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `webhook_logs` | ✅ | Isolamento por company_id | service_role apenas |
| `system_logs` | ✅ | Super Admin apenas | Público (INSERT) |
| `system_config` | ✅ | Leitura pública | Admin apenas |
| `feedbacks` | ✅ | Próprio usuário + Admin | Autenticados (INSERT) |
| `referrals` | ✅ | Próprio usuário | service_role apenas |
| `identity_map` | ✅ | Isolamento por company_id | Isolamento por company_id |
| `gamification_points` | ✅ | Isolamento por company_id | **service_role apenas** |
| `custom_field_definitions` | ✅ | Isolamento por company_id | Owner/Admin apenas |
| `plans` | ✅ | **Leitura pública** | **service_role apenas** |
| `baileys_auth_state` | ✅ | **NEGADO para todos** | **service_role apenas** |
| `subscriptions` | ✅ | Isolamento por company_id | **service_role / Stripe webhook** |

**Índices de Alta Performance (Aplicados v5.1):**
*   `idx_messages_remote_jid_company`: Otimiza abertura de chat e scroll de histórico.
*   `idx_contacts_last_message`: Acelera a ordenação da Sidebar (Inbox) em 100x.
*   `idx_leads_company_phone`: Vital para o "Lead Guard" evitar duplicidade.
*   `idx_appointments_worker`: Índice parcial para o Worker de lembretes.

**Estratégia de Limpeza (Storage Garbage Collection):**
*   A View `view_orphan_storage_files` lista arquivos no bucket `chat-media` sem referência em `messages`. Monitorar mensalmente.


---

## 6. Storage (Arquivos & Mídia)
O sistema utiliza o Supabase Storage para armazenar arquivos pesados, mantendo o banco de dados leve.

### Bucket: `chat-media` (Público)
* **Função:** Armazenar imagens, áudios, vídeos e documentos recebidos ou enviados pelo WhatsApp.
* **Estrutura de Pastas:** `/{company_id}/{timestamp_nome_arquivo}.{ext}`
* **Política de Acesso:**
    * **Leitura (Select):** Pública (Qualquer pessoa com o link pode ver). Necessário para o Frontend renderizar imagens.
    * **Escrita (Insert/Update):** Restrita a usuários autenticados (`authenticated`) e backend (`service_role`).
* **Uso no Código:** O backend e frontend salvam o arquivo aqui e gravam apenas a URL pública na coluna `messages.media_url`.

---

### Regra de Unificação de Identidade (v6.0)
- O sistema utiliza a tabela `identity_map` para converter JIDs `@lid` em `@s.whatsapp.net`.
- O trigger `trg_merge_lid_conversations` automatiza a migração de mensagens órfãs de LIDs para o JID canônico do telefone.
- A coluna `messages.phone` deve sempre refletir o número de telefone real, resolvido via `identity_map` quando necessário.

---

## 7. Ferramentas de Diagnóstico
- **Stress Test Suite:** Endpoints em `/api/v1/management/stress/*` para validação de carga em BullMQ e consistência de contexto em LLM.

---

## NOTAS DE IMPLEMENTAÇÃO:

### Comunidades
Comunidades são tratadas como Contatos especiais (`is_community = true`). Grupos pertencentes a uma comunidade terão o campo `parent_jid` preenchido com o JID da comunidade.

### Canais
Canais são identificados pelo sufixo `@newsletter` no JID. Metadados específicos como número de seguidores ou função do usuário (admin/subscriber) são armazenados no campo JSONB `metadata`.

### Catálogo
A tabela `products` serve como um cache de leitura. Não editamos produtos pelo CRM para evitar violações de política do WhatsApp. A sincronização deve ser feita periodicamente ou sob demanda via botão no frontend.

---

