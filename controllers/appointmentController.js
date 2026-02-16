
import { createClient } from "@supabase/supabase-js";
import { Logger } from '../utils/logger.js';

// Controller agora é apenas um "Dummy" para não quebrar chamadas do Frontend.
// A lógica real foi movida 100% para o agendaWorker.js para simplificação.

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  const TRACE_ID = `APP-${appointmentId?.slice(0,4)}`;

  try {
    // Apenas loga que a solicitação chegou. O Worker vai pegar isso no banco em < 1 min.
    console.log(`[${TRACE_ID}] 📥 Agendamento recebido. Delegando envio para AgendaWorker.`);

    if (!appointmentId || !companyId) {
        return res.status(400).json({ error: "Dados incompletos." });
    }

    // Retorna sucesso imediato para liberar a UI do cliente
    return res.json({ 
        success: true, 
        queued: true, 
        message: "Agendamento registrado. A notificação será enviada pelo Worker em instantes." 
    });

  } catch (error) {
    console.error(`[APP-ERROR] ❌`, error);
    // Mesmo com erro aqui, se o agendamento estiver no banco, o Worker vai processar.
    return res.status(500).json({ error: error.message });
  }
};
