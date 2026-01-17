import { supabase } from '../../auth/supabaseAuth.js';
import { sendMessage } from '../baileys/sender.js';

// Configuração
const CHECK_INTERVAL = 60 * 1000; // Roda a cada 1 minuto
const REMINDER_WINDOW_HOURS = 24; // Avisar 24h antes

// Função para limpar JID
const formatJid = (phone) => {
  const clean = phone.replace(/\D/g, '');
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
    // E que ainda não enviamos lembrete.
    const windowEnd = new Date(now.getTime() + (REMINDER_WINDOW_HOURS * 60 * 60 * 1000));

    // Busca agendamentos pendentes de lembrete
    // NOTA: Trazemos apenas o necessário.
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(`
        id, start_time, company_id,
        leads (name, phone),
        profiles:user_id (name)
      `)
      .gte('start_time', now.toISOString()) // Apenas futuros
      .lte('start_time', windowEnd.toISOString()) // Dentro da janela
      .eq('reminder_sent', false)
      .eq('status', 'confirmed'); // Apenas confirmados (opcional: ou 'pending')

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

    // 1. Resolver Sessão (Com Cache Local)
    let sessionId = sessionCache[company_id];

    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', company_id)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();

      if (instance) {
        sessionId = instance.session_id;
        sessionCache[company_id] = sessionId;
      } else {
        console.warn(`[SENTINELA] ⚠️ Sem conexão ativa para empresa ${company_id}. Lembrete pulado.`);
        return;
      }
    }

    // 2. Preparar Dados
    const clientName = leads.name.split(' ')[0];
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
