// =============================================================================
// 🔄 RECOVERY WATCHDOG — Anti-Vácuo de Atendimento
// =============================================================================
// Roda a cada 5 minutos. Detecta mensagens que deveriam ter sido respondidas
// pela IA mas não foram (ai_processed = false e ai_error IS NOT NULL OU
// mensagem com mais de 3 min sem processamento).
//
// Ações:
//   - < 15 min: re-enfileira o job de IA no BullMQ (com jobId idempotente)
//   - >= 15 min: marca o lead com a tag 'FALHA_ATENDIMENTO' e loga em system_logs
//
// Hard Rules:
//   - Ignora grupos (@g.us)
//   - Ignora mensagens enviadas por nós (from_me = true)
//   - Ignora leads com bot_status = 'off'
//   - Usa jobId único para idempotência: nunca re-processa a mesma mensagem duas vezes
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { Logger } from '../utils/logger.js';
import { aiQueue } from '../services/scheduler/aiQueue.js';
import { internalProcessAI } from '../services/scheduler/sentinel.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- CONSTANTES DE TIMING ---
const WATCHDOG_INTERVAL_MS  = 5  * 60 * 1000; // Roda a cada 5 minutos
const REQUEUE_WINDOW_MIN_MS = 3  * 60 * 1000; // Mínimo: 3 min (respeita o debounce)
const REQUEUE_WINDOW_MAX_MS = 15 * 60 * 1000; // Máximo para re-enfileirar: 15 min
const FAILURE_LOOKBACK_MS   = 60 * 60 * 1000; // Janela de busca de falhas: 1 hora

const FAILURE_TAG = 'FALHA_ATENDIMENTO';

// --- LÓGICA INTERNA ---

/**
 * Re-enfileira uma mensagem no BullMQ (ou fallback direto se sem Redis).
 * O jobId é derivado do whatsapp_id para garantir idempotência absoluta.
 */
const requeueMessage = async (msg) => {
    const jobId = `recovery:${msg.company_id}:${msg.whatsapp_id}`;

    try {
        // 🛡️ [FIX BUG 2] Resolve @lid para phone JID antes de enfileirar.
        // Sem isso, o Sentinel recebe '215001885323481@lid' e falha na busca do lead.
        let resolvedJid = msg.remote_jid;
        if (resolvedJid.includes('@lid')) {
            const { data: mapping } = await supabase
                .from('identity_map')
                .select('phone_jid')
                .eq('lid_jid', resolvedJid)
                .eq('company_id', msg.company_id)
                .maybeSingle();

            if (mapping?.phone_jid) {
                resolvedJid = mapping.phone_jid;
                console.log(`🔗 [WATCHDOG] LID resolvido: ${msg.remote_jid} → ${resolvedJid}`);
            } else {
                // Tenta via contacts.phone
                const { data: contact } = await supabase
                    .from('contacts')
                    .select('phone')
                    .eq('jid', resolvedJid)
                    .eq('company_id', msg.company_id)
                    .not('phone', 'is', null)
                    .maybeSingle();
                if (contact?.phone) {
                    resolvedJid = `${contact.phone.replace(/\D/g, '')}@s.whatsapp.net`;
                }
            }
        }

        const payload = {
            whatsapp_id:  msg.whatsapp_id,
            content:      msg.content,
            remote_jid:   resolvedJid, // JID resolvido (nunca @lid)
            company_id:   msg.company_id,
            from_me:      false,
            message_type: msg.message_type,
            transcription: msg.transcription || null,
            created_at:   msg.created_at,
            session_id:   msg.session_id,
            is_recovery:  true  // 🛡️ [FIX BUG 1] Bypassa o guard de 180s no sentinel
        };

        if (aiQueue) {
            await aiQueue.add('process_ai', payload, {
                jobId,            // idempotente: BullMQ ignora se job com mesmo ID já existe
                attempts: 1,      // 1 tentativa — o sentinel tem sua própria lógica de retry
                removeOnComplete: true,
                removeOnFail: false
            });
            console.log(`🔄 [WATCHDOG] Re-enfileirado: ${msg.whatsapp_id} (${resolvedJid})`);
        } else {
            // Fallback: sem Redis, executa direto (raro em produção)
            console.warn(`⚠️ [WATCHDOG] Sem Redis. Executando recovery de ${msg.whatsapp_id} na RAM.`);
            await internalProcessAI(payload);
        }
    } catch (e) {
        Logger.error('watchdog', `Falha ao re-enfileirar msg ${msg.whatsapp_id}`, { error: e.message }, msg.company_id);
    }
};


/**
 * Marca o lead com a tag FALHA_ATENDIMENTO e registra em system_logs.
 * Usa array_append para não sobrescrever tags existentes.
 */
const markAsFailure = async (msg) => {
    try {
        const purePhone = msg.remote_jid.split('@')[0].replace(/\D/g, '');

        // Busca o lead pelo telefone (com fallback DDI)
        let { data: lead } = await supabase.from('leads')
            .select('id, tags, name')
            .eq('company_id', msg.company_id)
            .eq('phone', purePhone)
            .maybeSingle();

        if (!lead && purePhone.startsWith('55') && purePhone.length > 10) {
            const phoneWithoutDDI = purePhone.substring(2);
            const { data: fallback } = await supabase.from('leads')
                .select('id, tags, name')
                .eq('company_id', msg.company_id)
                .eq('phone', phoneWithoutDDI)
                .maybeSingle();
            lead = fallback;
        }

        if (!lead) {
            console.warn(`⚠️ [WATCHDOG] Lead não encontrado para ${purePhone}. Pulando tag de falha.`);
            return;
        }

        // Evita adicionar a tag duplicada
        const currentTags = Array.isArray(lead.tags) ? lead.tags : [];
        if (currentTags.includes(FAILURE_TAG)) return;

        const updatedTags = [...currentTags, FAILURE_TAG];
        await supabase.from('leads')
            .update({ tags: updatedTags })
            .eq('id', lead.id)
            .eq('company_id', msg.company_id);

        // Marca a mensagem como erro definitivo para não ser processada de novo
        await supabase.from('messages')
            .update({ ai_processed: true, ai_error: 'FALHA_ATENDIMENTO_DEFINITIVA' })
            .eq('whatsapp_id', msg.whatsapp_id)
            .eq('company_id', msg.company_id);

        Logger.warn('watchdog',
            `[FALHA_ATENDIMENTO] Lead "${lead.name}" (${purePhone}) sem resposta há >15min.`,
            { lead_id: lead.id, msg_id: msg.whatsapp_id, jid: msg.remote_jid },
            msg.company_id
        );

        console.warn(`🚨 [WATCHDOG] FALHA_ATENDIMENTO: Lead ${lead.name} (${purePhone}) marcado.`);

    } catch (e) {
        Logger.error('watchdog', `Erro ao marcar FALHA_ATENDIMENTO para ${msg.whatsapp_id}`, { error: e.message }, msg.company_id);
    }
};

/**
 * Varredura principal. Executada a cada WATCHDOG_INTERVAL_MS.
 */
const runRecoveryCheck = async () => {
    try {
        const now = new Date();

        // Janela de recovery: mensagens entre 3 e 15 minutos atrás
        const threeMinAgo    = new Date(now.getTime() - REQUEUE_WINDOW_MIN_MS).toISOString();
        const fifteenMinAgo  = new Date(now.getTime() - REQUEUE_WINDOW_MAX_MS).toISOString();
        const oneHourAgo     = new Date(now.getTime() - FAILURE_LOOKBACK_MS).toISOString();

        // --- QUERY 1: Mensagens para RE-ENFILEIRAR (3 a 15 min atrás, com erro explícito OU processadas = false) ---
        const { data: pendingMessages, error: pendingError } = await supabase
            .from('messages')
            .select('whatsapp_id, company_id, remote_jid, content, message_type, transcription, session_id, created_at, ai_error, leads!inner(bot_status)')
            .eq('from_me', false)
            .eq('ai_processed', false)
            .neq('leads.bot_status', 'off')             // 🛡️ [ANTI-LOOP] Ignora leads com bot desligado
            .not('remote_jid', 'like', '%@g.us')        // Ignora grupos
            .not('remote_jid', 'like', '%@newsletter')  // Ignora newsletters
            .lte('created_at', threeMinAgo)              // Mais de 3 min (fora do debounce)
            .gte('created_at', fifteenMinAgo)            // Menos de 15 min (ainda recuperável)
            .eq('is_deleted', false);

        if (pendingError) {
            Logger.error('watchdog', 'Erro na query de mensagens pendentes', { error: pendingError.message });
        } else if (pendingMessages && pendingMessages.length > 0) {
            console.log(`🔄 [WATCHDOG] ${pendingMessages.length} mensagem(ns) pendente(s) detectadas. Re-enfileirando...`);
            for (const msg of pendingMessages) {
                await requeueMessage(msg);
            }
        }

        // --- QUERY 2: Mensagens para FALHA_ATENDIMENTO (> 15 min, ainda com ai_processed = false) ---
        const { data: failedMessages, error: failedError } = await supabase
            .from('messages')
            .select('whatsapp_id, company_id, remote_jid, content, message_type, session_id, created_at, leads!inner(bot_status)')
            .eq('from_me', false)
            .eq('ai_processed', false)
            .neq('leads.bot_status', 'off')             // 🛡️ [ANTI-LOOP] Ignora leads com bot desligado
            .not('remote_jid', 'like', '%@g.us')
            .not('remote_jid', 'like', '%@newsletter')
            .lt('created_at', fifteenMinAgo)   // Mais de 15 min (passou da janela de recovery)
            .gte('created_at', oneHourAgo)     // Mas dentro da última hora (evita query enorme)
            .eq('is_deleted', false);

        if (failedError) {
            Logger.error('watchdog', 'Erro na query de mensagens com falha', { error: failedError.message });
        } else if (failedMessages && failedMessages.length > 0) {
            console.log(`🚨 [WATCHDOG] ${failedMessages.length} mensagem(ns) com falha de atendimento (>15min).`);
            for (const msg of failedMessages) {
                await markAsFailure(msg);
            }
        }

        if (!pendingMessages?.length && !failedMessages?.length) {
            console.log(`✅ [WATCHDOG] Varredura concluída. Nenhuma mensagem perdida detectada.`);
        }

    } catch (e) {
        Logger.error('watchdog', 'Erro geral no Recovery Watchdog', { error: e.message });
    }
};

/**
 * Inicializa o Recovery Watchdog.
 * Aguarda 2 minutos antes da primeira varredura para dar tempo ao boot das sessões.
 */
export const startRecoveryWatchdog = () => {
    console.log(`🛡️  [WATCHDOG] Recovery Watchdog iniciado. Primeira varredura em 2 minutos...`);

    // Primeira execução com 2 min de delay (aguarda sessões subirem)
    setTimeout(() => {
        runRecoveryCheck();
        // Loop periódico a cada 5 minutos
        setInterval(runRecoveryCheck, WATCHDOG_INTERVAL_MS);
    }, 2 * 60 * 1000);
};
