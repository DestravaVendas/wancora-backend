
import { createClient } from "@supabase/supabase-js";
import { Logger } from '../utils/logger.js';

// MODO ASYNC-FIRST:
// Este controller agora serve apenas para cumprir o contrato da API REST.
// Ele não envia mensagens diretamente. Apenas valida e retorna sucesso.
// O trabalho pesado de envio é feito pelo 'agendaWorker.js' que roda a cada minuto.

export const sendAppointmentConfirmation = async (req, res) => {
  const { appointmentId, companyId } = req.body;
  const TRACE_ID = `APP-${appointmentId?.slice(0,4)}`;

  try {
    // Loga a intenção para fins de debug, mas não bloqueia a thread
    // O Worker vai pegar esse registro no banco baseado em 'confirmation_sent = false'
    console.log(`[${TRACE_ID}] 📥 Solicitação de confirmação recebida. Delegando para Fila Assíncrona (Worker).`);

    if (!appointmentId || !companyId) {
        return res.status(400).json({ error: "Dados incompletos." });
    }

    // Retorna sucesso imediato para a UI não ficar travada esperando o WhatsApp
    return res.json({ 
        success: true, 
        mode: 'async',
        message: "Solicitação enfileirada. O envio será processado em instantes pelo sistema." 
    });

  } catch (error) {
    console.error(`[APP-ERROR] ❌`, error);
    // Mesmo com erro aqui, se o agendamento estiver no banco, o Worker vai processar.
    return res.status(500).json({ error: error.message });
  }
};
