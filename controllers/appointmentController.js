import { supabase } from '../auth/supabaseAuth.js';
import { sendMessage } from '../services/baileys/sender.js';

// Helper simples para limpar telefone
const cleanPhone = (phone) => {
  return phone.replace(/\D/g, '');
};

export const sendAppointmentConfirmation = async (req, res) => {
  // Recebe dados. Se sessionId não vier (chamada via webhook), tentamos descobrir.
  const { appointmentId, companyId } = req.body;
  let { sessionId } = req.body;

  if (!appointmentId) {
    return res.status(400).json({ error: 'appointmentId é obrigatório.' });
  }

  try {
    console.log(`[AGENDA] 📅 Processando confirmação ID: ${appointmentId}`);

    // 1. Buscar dados do agendamento com Leads e Profile
    const { data: appointment, error } = await supabase
      .from('appointments')
      .select(`
        *,
        leads (name, phone),
        profiles:user_id (name) 
      `)
      .eq('id', appointmentId)
      .single();

    if (error || !appointment) {
      console.error('[AGENDA] Agendamento não encontrado no banco.');
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    // 2. Resolução de Sessão (Se não foi passada explicitamente)
    if (!sessionId) {
      const { data: instance } = await supabase
        .from('instances')
        .select('session_id')
        .eq('company_id', appointment.company_id)
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();
      
      if (!instance) {
        return res.status(503).json({ error: 'Nenhuma conexão de WhatsApp ativa para esta empresa.' });
      }
      sessionId = instance.session_id;
    }

    const clientPhone = cleanPhone(appointment.leads.phone);
    const clientName = appointment.leads.name.split(' ')[0]; // Primeiro nome
    const agentName = appointment.profiles?.name || 'Consultor';
    
    // Formatar data/hora (Intl é mais seguro que toLocaleString dependendo do Node locale)
    const dateObj = new Date(appointment.start_time);
    const dateStr = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(dateObj);
    const timeStr = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(dateObj);

    // 3. Montar Mensagem
    const messageText = `✅ *Confirmação de Agendamento*\n\nOlá ${clientName}, sua reunião com *${agentName}* está agendada!\n\n📅 Data: ${dateStr}\n⏰ Horário: ${timeStr}\n🔗 Link: ${appointment.meet_link || 'A ser enviado'}\n\nResponda esta mensagem se precisar reagendar.`;

    // 4. Enviar via WhatsApp
    const remoteJid = `${clientPhone}@s.whatsapp.net`;
    
    await sendMessage(sessionId, remoteJid, { text: messageText });

    // 5. Atualizar flag no banco para evitar reenvio
    await supabase
      .from('appointments')
      .update({ confirmation_sent: true })
      .eq('id', appointmentId);

    console.log(`[AGENDA] ✅ Confirmação enviada para ${clientName} (${clientPhone})`);
    return res.status(200).json({ success: true, message: 'Confirmação enviada com sucesso' });

  } catch (error) {
    console.error('[AGENDA] ❌ Erro crítico:', error);
    return res.status(500).json({ error: error.message });
  }
};
