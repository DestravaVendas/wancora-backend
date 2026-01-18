import { supabase } from '../../auth/supabaseAuth.js';
import { sendMessage } from '../baileys/sender.js';

// Configuração
const CHECK_INTERVAL = 60 * 1000; // Roda a cada 1 minuto
const REMINDER_WINDOW_HOURS = 24; // Avisar 24h antes

// Função para limpar JID (Garante apenas números antes do sufixo)
const formatJid = (phone) => {
  if (!phone) return null;
  const clean = phone.replace(/\D/g, ''); // Remove tudo que não é número
  return `${clean}@s.whatsapp.net`;
};

export const startSentinel = () => {
  console.log('🤖 [SENTINELA] Sistema de Monitoramento Iniciado.');

  setInterval(async () => {
    await runSentinelCycle();
  }, CHECK_INTERVAL);
};

async function runSentinelCycle() {
  try {
    const now = new Date();
    
    // Definindo a Janela de Tempo:
    // Queremos agendamentos que ocorrem entre AGORA e (AGORA + 24h)
    const windowEnd = new Date(now.getTime() + (REMINDER_WINDOW_HOURS * 60 * 60 * 1000));

    // Busca agendamentos pendentes de lembrete
    // CORREÇÃO: Removemos 'profiles:user_id (name)' pois não estava sendo usado e causava erro de relação
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(`
        id, start_time, company_id,
        leads (name, phone)
      `)
      .gte('start_time', now.toISOString()) // Apenas futuros
      .lte('start_time', windowEnd.toISOString()) // Dentro da janela
      .eq('reminder_sent', false)
      .eq('status', 'confirmed') // Apenas confirmados. Se quiser todos, remova esta linha ou mude para 'pending'
      .not('leads', 'is', null); // Garante que o lead existe para não quebrar o código

    if (error) throw error;

    if (!appointments || appointments.length === 0) return;

    console.log(`🤖 [SENTINELA] Processando ${appointments.length} lembretes pendentes...`);

    // Cache de sessões para não bater no banco repetidamente para a mesma empresa
    const sessionCache = {};

    for (const appt of appointments) {
      await processReminder(appt, sessionCache);
    }

  } catch (err) {
    console.error('🤖 [SENTINELA] Erro no ciclo:', err.message);
  }
}

async function processReminder(appt, sessionCache) {
  try {
    const { company_id, leads, start_time } = appt;

    // Validação de Segurança
    if (!leads || !leads.phone) {
      console.warn(`[SENTINELA] Agendamento ${appt.id} sem telefone vinculado. Ignorando.`);
      return;
    }

    // 1. Resolver Sessão (Com Cache Local)
    let sessionId = sessionCache[company_id];

    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', company_id)
        .eq('status', 'connected') // Apenas sessões ativas
        .limit(1)
        .maybeSingle();

      if (instance) {
        sessionId = instance.session_id;
        sessionCache[company_id] = sessionId;
      } else {
        // Log silencioso para evitar spam no console se a empresa desconectou
        return;
      }
    }

    // 2. Preparar Dados
    const clientName = leads.name ? leads.name.split(' ')[0] : 'Cliente';
    const dateObj = new Date(start_time);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);
    const remoteJid = formatJid(leads.phone);

    // 3. Texto do Lembrete
    const text = `🔔 *Lembrete Automático*\n\nOlá ${clientName}, passando para lembrar da nossa reunião amanhã às *${timeStr}*.\n\nEstá tudo certo para nosso encontro?`;

    // 4. Enviar Mensagem
    await sendMessage(sessionId, remoteJid, { text });

    // 5. Marcar como Enviado (Crítico para não spamar)
    const { error: updateError } = await supabase
      .from('appointments')
      .update({ reminder_sent: true })
      .eq('id', appt.id);

    if (updateError) throw updateError;

    console.log(`[SENTINELA] 📨 Lembrete enviado para ${clientName} (ID: ${appt.id})`);

  } catch (error) {
    console.error(`[SENTINELA] ❌ Falha no agendamento ${appt.id}:`, error.message);
  }
}
