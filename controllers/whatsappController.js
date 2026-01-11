import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, delay } from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import { useSupabaseAuthState } from "../auth/supabaseAuth.js";
import dotenv from "dotenv";

dotenv.config();

// Admin Client para escrever no banco ignorando RLS (o backend é o sistema)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: {
    persistSession: false
  }
});

// Armazena as sessões ativas em memória: { sessionId: { socket, companyId } }
const sessions = new Map();

// Helper para extrair conteúdo de texto de mensagens variadas
const getMessageContent = (msg) => {
    if (!msg) return "";
    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        (msg.listResponseMessage?.singleSelectReply?.selectedRowId) ||
        (msg.buttonsResponseMessage?.selectedButtonId) ||
        (msg.templateButtonReplyMessage?.selectedId) ||
        ""
    );
};

// Helper para determinar o tipo da mensagem
const getMessageType = (msg) => {
    if (msg.imageMessage) return 'image';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.locationMessage) return 'location';
    return 'text';
};

export const startSession = async (req, res) => {
  const { sessionId, companyId } = req.body;

  if (!sessionId || !companyId) {
    return res.status(400).json({ error: "SessionID e CompanyID são obrigatórios." });
  }

  // Se já existe, retorna ok (mas monitora status)
  if (sessions.has(sessionId)) {
      return res.status(200).json({ message: "Sessão já inicializada." });
  }

  try {
    // Usa o adaptador de Auth do Supabase que você já configurou
    const { state, saveCreds } = await useSupabaseAuthState(sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, console),
      },
      printQRInTerminal: false, // Desativado pois salvamos no banco
      mobile: false,
      browser: ["Wancora CRM", "Chrome", "10.0"],
      syncFullHistory: true, // Importante para puxar histórico antigo
      generateHighQualityLinkPreview: true,
    });

    // Salva referência em memória
    sessions.set(sessionId, { socket: sock, companyId });

    // 1. EVENTO: ATUALIZAÇÃO DE CONEXÃO (QR CODE & STATUS)
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Salva QR Code no Banco para o Frontend exibir
      if (qr) {
        console.log(`[QR CODE] Gerado para sessão ${sessionId}`);
        await supabase
          .from("instances")
          .update({ 
              qrcode_url: qr, // Salva a string bruta do QR
              status: "qr_ready",
              updated_at: new Date()
          })
          .eq("session_id", sessionId)
          .eq("company_id", companyId);
      }

      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`[CONEXÃO] Fechada (${sessionId}). Reconectar: ${shouldReconnect}`);

        await supabase
            .from("instances")
            .update({ status: "disconnected" })
            .eq("session_id", sessionId);

        sessions.delete(sessionId);
        
        if (shouldReconnect) {
            // Pequeno delay e tenta reconectar internamente simulando o request
            setTimeout(() => {
                startSession({ body: { sessionId, companyId } }, { status: () => ({ json: () => {} }) });
            }, 3000);
        }
      } 
      
      else if (connection === "open") {
        console.log(`[CONEXÃO] Aberta (${sessionId})`);
        
        // Pega info do usuário (foto e nome)
        const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        let profilePic = null;
        try {
            profilePic = await sock.profilePictureUrl(userJid, 'image').catch(() => null);
        } catch(e) {}

        await supabase
          .from("instances")
          .update({ 
              status: "connected", 
              qrcode_url: null, // Limpa QR
              profile_pic_url: profilePic,
              name: sock.user.name || sessionId, // Tenta pegar nome do WP ou usa sessão
              updated_at: new Date()
          })
          .eq("session_id", sessionId);
      }
    });

    // 2. EVENTO: SALVAR CREDENCIAIS
    sock.ev.on("creds.update", saveCreds);

    // 3. EVENTO: RECEBIMENTO DE MENSAGENS (AQUI ESTÁ A MÁGICA QUE FALTAVA)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type === "notify" || type === "append") {
                for (const msg of messages) {
                    if (!msg.message) continue;

                    // Ignora mensagens de status/protocolo
                    if (msg.key.remoteJid === "status@broadcast") continue;

                    const body = getMessageContent(msg.message);
                    const messageType = getMessageType(msg.message);
                    const remoteJid = msg.key.remoteJid;
                    const fromMe = msg.key.fromMe;
                    const pushName = msg.pushName;

                    // 3.1 Salva/Atualiza Contato (Upsert)
                    // Só tenta atualizar contatos se não for grupo (termina com g.us) ou se quiser tratar grupos diferente
                    if(!remoteJid.includes('@g.us')) {
                        const { error: contactError } = await supabase
                        .from('contacts')
                        .upsert({
                            company_id: companyId,
                            jid: remoteJid,
                            name: pushName || null,
                            push_name: pushName || null,
                            updated_at: new Date()
                        }, { onConflict: 'jid' });
                        
                        if(contactError) console.error("Erro ao salvar contato:", contactError);
                    }

                    // 3.2 Salva Mensagem
                    const { error: msgError } = await supabase.from('messages').insert({
                        company_id: companyId,
                        session_id: sessionId,
                        remote_jid: remoteJid,
                        from_me: fromMe,
                        content: body, // Texto
                        message_type: messageType,
                        status: 'delivered', // Assumimos entregue ao receber
                        created_at: new Date(msg.messageTimestamp * 1000)
                    });

                    if(msgError) console.error("Erro ao salvar mensagem:", msgError);

                    // 3.3 (Opcional) Trigger para Agente IA se não for fromMe
                    if (!fromMe) {
                         // Aqui você chamaria o worker/queue para a IA responder
                         // await campaignQueue.add({ type: 'ai_reply', ... })
                    }
                }
            }
        } catch (error) {
            console.error("Erro ao processar mensagens:", error);
        }
    });

    // 4. EVENTO: ATUALIZAÇÃO DE CONTATOS (Foto e Nome)
    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
             // Tenta buscar foto
             let profileUrl = null;
             /* 
                Nota: Fetch de foto é pesado e pode dar rate limit. 
                Idealmente deve ser feito em fila background ou sob demanda.
                Deixaremos comentado para performance inicial.
             */
             // try { profileUrl = await sock.profilePictureUrl(contact.id, 'image'); } catch {}

             await supabase.from('contacts').upsert({
                 company_id: companyId,
                 jid: contact.id,
                 name: contact.name || contact.notify || null,
                 profile_pic_url: profileUrl
             }, { onConflict: 'jid' });
        }
    });

    res.status(200).json({ message: "Sessão iniciada", status: "connecting" });

  } catch (error) {
    console.error("Erro fatal ao iniciar sessão:", error);
    res.status(500).json({ error: "Falha interna ao iniciar Wancora Engine" });
  }
};

export const logoutSession = async (req, res) => {
    const { sessionId, companyId } = req.body;
    const session = sessions.get(sessionId);

    if (session) {
        try {
            await session.socket.logout();
            session.socket.end(undefined);
            sessions.delete(sessionId);
        } catch (e) {}
    }

    // Limpa no banco
    await supabase
        .from("instances")
        .update({ status: "disconnected", qrcode_url: null })
        .eq("session_id", sessionId)
        .eq("company_id", companyId);
        
    // Opcional: Limpar tabela de auth se quiser "Esquecer" totalmente
    // await supabase.from("baileys_auth_state").delete().eq("session_id", sessionId);

    res.status(200).json({ message: "Sessão desconectada." });
};

export const sendMessage = async (req, res) => {
    const { sessionId, to, text, companyId } = req.body;
    
    // Recupera sessão da memória
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: "Sessão não encontrada ou desconectada." });
    }

    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        
        // Envia via Baileys
        const sentMsg = await session.socket.sendMessage(jid, { text: text });

        // Salva no banco (O listener 'messages.upsert' com fromMe=true TAMBÉM dispara, 
        // mas para garantir latência zero na UI, podemos salvar aqui ou confiar no listener. 
        // O listener é mais seguro pois confirma que o WP aceitou).
        // Vamos confiar no listener acima para evitar duplicidade.
        
        res.status(200).json({ message: "Enviado", id: sentMsg.key.id });
    } catch (error) {
        console.error("Erro envio:", error);
        res.status(500).json({ error: "Falha no envio da mensagem." });
    }
};
