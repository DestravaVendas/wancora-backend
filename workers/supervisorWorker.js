// =============================================================================
// 🤖 SUPERVISOR BOT — Relatórios de Status via WhatsApp
// =============================================================================
// Envia relatórios periódicos de saúde do sistema para o administrador via
// WhatsApp, usando uma sessão ativa configurada pelo usuário.
//
// Configuração (via companies.integrations_config.supervisor — JSONB existente):
// {
//   "supervisor": {
//     "enabled": true,
//     "admin_phone": "5511999999999",     // Destinatário do relatório
//     "session_id": "uuid_da_instancia",  // Sessão WhatsApp a usar para envio
//     "interval_minutes": 60             // Intervalo em minutos (padrão: 60)
//   }
// }
//
// O worker roda uma varredura global a cada 15 minutos. Para cada empresa
// com supervisor configurado, decide se já é hora de enviar o próximo relatório.
// Isso evita N setIntervals separados por empresa.
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import { Logger } from '../utils/logger.js';
import { sendMessage } from '../services/baileys/sender.js';
import { sessions } from '../services/baileys/connection.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- CONSTANTES ---
const SCAN_INTERVAL_MS    = 15 * 60 * 1000; // Varredura global a cada 15 min
const DEFAULT_INTERVAL_M  = 60;             // Intervalo padrão entre relatórios: 60 min

// Mapa de controle: ultima vez que cada empresa recebeu relatório
// { company_id: timestamp_ms }
const lastReportSent = new Map();

// --- COLETA DE MÉTRICAS ---

/**
 * Agrega as métricas de uma empresa para compor o relatório.
 * Usa janela de 24h para a maioria dos dados.
 */
const collectMetrics = async (companyId) => {
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since1h  = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const since15m = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const since3m  = new Date(now.getTime() - 3  * 60 * 1000).toISOString();

    try {
        const [
            activeChatsRes,
            unreadRes,
            aiErrorsRes,
            vacuumsRes,
            failureTagRes
        ] = await Promise.allSettled([

            // 1. Conversas ativas (receberam mensagem nas últimas 24h, excluindo grupos)
            supabase.from('messages')
                .select('remote_jid', { count: 'estimated', head: false })
                .eq('company_id', companyId)
                .eq('from_me', false)
                .not('remote_jid', 'like', '%@g.us')
                .not('remote_jid', 'like', '%@newsletter')
                .gte('created_at', since24h),

            // 2. Mensagens não lidas (from_me = false e sem resposta nossa nas últimas 1h)
            supabase.from('messages')
                .select('remote_jid', { count: 'estimated', head: false })
                .eq('company_id', companyId)
                .eq('from_me', false)
                .eq('ai_processed', false)
                .not('remote_jid', 'like', '%@g.us')
                .gte('created_at', since1h)
                .lte('created_at', since3m), // Excluindo as muito recentes (ainda no debounce)

            // 3. Erros de IA na última hora
            supabase.from('messages')
                .select('ai_error', { count: 'estimated', head: false })
                .eq('company_id', companyId)
                .not('ai_error', 'is', null)
                .gte('created_at', since1h),

            // 4. Potenciais vácuos (ai_processed = false, 15min a 1h atrás — o que o watchdog ainda não processou)
            supabase.from('messages')
                .select('remote_jid', { count: 'estimated', head: false })
                .eq('company_id', companyId)
                .eq('from_me', false)
                .eq('ai_processed', false)
                .not('remote_jid', 'like', '%@g.us')
                .gte('created_at', since24h)
                .lte('created_at', since15m),

            // 5. Leads marcados com FALHA_ATENDIMENTO (array contains)
            supabase.from('leads')
                .select('id', { count: 'estimated', head: false })
                .eq('company_id', companyId)
                .contains('tags', ['FALHA_ATENDIMENTO'])
        ]);

        // Extrai contagens de forma segura
        const safeCount = (res, field = 'count') => {
            if (res.status === 'rejected') return '?';
            const data = res.value?.data;
            const count = res.value?.count;
            if (typeof count === 'number') return count;
            if (Array.isArray(data)) return data.length;
            return 0;
        };

        // Para conversas ativas, queremos JIDs únicos
        const activeChatsData = activeChatsRes.status === 'fulfilled' ? activeChatsRes.value?.data : [];
        const uniqueChats = activeChatsData
            ? new Set(activeChatsData.map(m => m.remote_jid)).size
            : '?';

        return {
            activeChats:  uniqueChats,
            pendingMsgs:  safeCount(unreadRes),
            aiErrors:     safeCount(aiErrorsRes),
            vacuumRisk:   safeCount(vacuumsRes),
            failureLeads: safeCount(failureTagRes)
        };

    } catch (e) {
        Logger.error('supervisor', `Erro ao coletar métricas para ${companyId}`, { error: e.message }, companyId);
        return null;
    }
};

// --- FORMATAÇÃO DO RELATÓRIO ---

const buildReport = (metrics, companyName) => {
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // Status geral baseado nas métricas
    let statusEmoji = '✅';
    let statusText  = 'Sistema operando normalmente';

    if (metrics.failureLeads > 0 || metrics.vacuumRisk > 3) {
        statusEmoji = '🚨';
        statusText  = 'Atenção: leads sem atendimento detectados';
    } else if (metrics.aiErrors > 5 || metrics.pendingMsgs > 5) {
        statusEmoji = '⚠️';
        statusText  = 'Instabilidade detectada';
    }

    return [
        `*📊 Relatório Wancora — ${companyName}*`,
        `🕐 ${now}`,
        ``,
        `${statusEmoji} *Status:* ${statusText}`,
        ``,
        `📬 *Conversas ativas (24h):* ${metrics.activeChats}`,
        `📩 *Mensagens aguardando IA:* ${metrics.pendingMsgs}`,
        `🚨 *Erros de IA (última hora):* ${metrics.aiErrors}`,
        `⏱️ *Risco de vácuo (>15min):* ${metrics.vacuumRisk}`,
        `🏷️ *Leads com FALHA_ATENDIMENTO:* ${metrics.failureLeads}`,
        ``,
        `_Próximo relatório em aprox. ${DEFAULT_INTERVAL_M} minutos_`,
        `_Wancora CRM — Supervisor Bot_`
    ].join('\n');
};

// --- ENVIO DO RELATÓRIO ---

const sendReport = async (companyId, config, companyName) => {
    const { admin_phone, session_id } = config;

    // Valida se a sessão está ativa
    const session = sessions.get(session_id);
    if (!session || !session.sock || !session.sock.ws?.isOpen) {
        console.warn(`⚠️ [SUPERVISOR] Sessão ${session_id} indisponível. Relatório adiado.`);
        return;
    }

    // Coleta métricas
    const metrics = await collectMetrics(companyId);
    if (!metrics) return;

    const report = buildReport(metrics, companyName);

    try {
        await sendMessage({
            sessionId: session_id,
            to:        `${admin_phone}@s.whatsapp.net`,
            type:      'text',
            content:   report,
            companyId,
            timingConfig: {
                min_delay_seconds: 1,  // Relatório técnico: sem delay de anti-ban
                max_delay_seconds: 3
            }
        });

        lastReportSent.set(companyId, Date.now());
        console.log(`✅ [SUPERVISOR] Relatório enviado para ${admin_phone} (empresa: ${companyName})`);

    } catch (e) {
        Logger.error('supervisor', `Falha ao enviar relatório para ${admin_phone}`, { error: e.message }, companyId);
    }
};

// --- VARREDURA GLOBAL ---

/**
 * Roda a cada SCAN_INTERVAL_MS.
 * Busca todas as empresas com supervisor habilitado e verifica se é hora de enviar.
 */
const runSupervisorScan = async () => {
    try {
        // Busca empresas com supervisor configurado e ativo
        const { data: companies, error } = await supabase
            .from('companies')
            .select('id, name, integrations_config')
            .not('integrations_config->supervisor', 'is', null);

        if (error) {
            Logger.error('supervisor', 'Erro ao buscar empresas com supervisor', { error: error.message });
            return;
        }

        if (!companies || companies.length === 0) return;

        for (const company of companies) {
            try {
                const supervisorConfig = company.integrations_config?.supervisor;

                // Valida campos obrigatórios
                if (
                    !supervisorConfig?.enabled ||
                    !supervisorConfig?.admin_phone ||
                    !supervisorConfig?.session_id
                ) continue;

                // Verifica intervalo configurado
                const intervalMs = (supervisorConfig.interval_minutes || DEFAULT_INTERVAL_M) * 60 * 1000;
                const lastSent   = lastReportSent.get(company.id) || 0;

                if (Date.now() - lastSent < intervalMs) continue;

                // É hora de enviar!
                await sendReport(company.id, supervisorConfig, company.name);

            } catch (companyErr) {
                Logger.error('supervisor', `Erro ao processar supervisor da empresa ${company.id}`, { error: companyErr.message }, company.id);
            }
        }

    } catch (e) {
        Logger.error('supervisor', 'Erro geral no Supervisor Scan', { error: e.message });
    }
};

// --- INICIALIZAÇÃO ---

/**
 * Inicia o Supervisor Bot.
 * Aguarda 3 minutos antes do primeiro scan para dar tempo ao boot das sessões.
 */
export const startSupervisorWorker = () => {
    console.log(`🤖 [SUPERVISOR] Supervisor Bot iniciado. Primeiro scan em 3 minutos...`);

    // Boot delay: aguarda sessões Baileys reconectarem antes do primeiro relatório
    setTimeout(() => {
        runSupervisorScan();
        setInterval(runSupervisorScan, SCAN_INTERVAL_MS);
    }, 3 * 60 * 1000);
};
