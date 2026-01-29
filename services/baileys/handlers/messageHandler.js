
import { getContentType, normalizeJid, unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { upsertMessage, ensureLeadExists, updateInstanceStatus } from '../../crm/sync.js';
import { handleMediaUpload } from './mediaHandler.js';
import { dispatchWebhook } from '../../integrations/webhook.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- CORE MESSAGE PROCESSOR ---

export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime = true, forcedName = null, options = {}) => {
    try {
        const { downloadMedia = true } = options;

        // 1. Normalização e Unwrap
        if (!msg.message) return;
        
        // Ignora status (stories)
        if (msg.key.remoteJid === 'status@broadcast') return;

        // Desenrola ViewOnce, Ephemeral, Edited
        const unwrapped = unwrapMessage(msg);
        const jid = normalizeJid(unwrapped.key.remoteJid);
        const fromMe = unwrapped.key.fromMe;
        const pushName = forcedName || unwrapped.pushName; // Nome forçado pelo histórico ou pushName nativo
        
        const type = getContentType(unwrapped.message);
        const body = getBody(unwrapped.message);

        // 2. Verificação de Bloqueio (Anti-Ghost)
        // Se o contato estiver marcado como 'is_ignored', não processamos nada (nem webhook, nem lead)
        if (!fromMe) {
            const { data: contact } = await supabase
                .from('contacts')
                .select('is_ignored, is_newsletter')
                .eq('jid', jid)
                .eq('company_id', companyId)
                .maybeSingle();

            if (contact?.is_ignored) return; // Bloqueio silencioso
        }

        // 3. Garantia de Lead (Apenas se não for eu, e não for grupo/canal)
        // Se for grupo, o ensureLeadExists retorna null internamente
        let leadId = null;
        if (!fromMe && isRealtime) {
            const myJid = normalizeJid(sock.user?.id);
            leadId = await ensureLeadExists(jid, companyId, pushName, myJid);
        }

        // 4. Processamento de Mídia
        let mediaUrl = null;
        let fileName = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);

        // Se for histórico antigo, podemos pular download (opcional via flag downloadMedia)
        // Se for Realtime, SEMPRE baixamos.
        if (isMedia && (isRealtime || downloadMedia)) {
            // Tenta obter nome do arquivo se for documento
            if (type === 'documentMessage') {
                fileName = unwrapped.message.documentMessage.fileName;
            }
            // Upload para Supabase Storage
            mediaUrl = await handleMediaUpload(unwrapped, companyId);
        }

        // 5. Preparar Payload para o Banco (Normalizado)
        const messageData = {
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: unwrapped.key.id,
            from_me: fromMe,
            content: body,
            message_type: type?.replace('Message', '') || 'unknown', // imageMessage -> image
            media_url: mediaUrl,
            status: fromMe ? 'sent' : 'delivered', // Se eu enviei, assume sent. Se recebi, delivered.
            created_at: new Date( (unwrapped.messageTimestamp || Date.now() / 1000) * 1000 ),
            lead_id: leadId
        };

        // Tratamento especial para Enquetes e Localização para salvar JSON limpo no content
        if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') {
            const poll = unwrapped.message[type];
            messageData.message_type = 'poll';
            messageData.content = JSON.stringify({
                name: poll.name,
                options: poll.options.map(o => o.optionName),
                selectableOptionsCount: poll.selectableOptionsCount
            });
        }
        else if (type === 'locationMessage' || type === 'liveLocationMessage') {
            const loc = unwrapped.message[type];
            messageData.message_type = 'location';
            messageData.content = JSON.stringify({
                latitude: loc.degreesLatitude,
                longitude: loc.degreesLongitude
            });
        }
        else if (type === 'contactMessage') {
            const contact = unwrapped.message[type];
            messageData.message_type = 'contact';
            messageData.content = JSON.stringify({
                displayName: contact.displayName,
                vcard: contact.vcard
            });
        }

        // 6. Persistência (DB Upsert)
        await upsertMessage(messageData);

        // 7. Webhook (Apenas Realtime)
        if (isRealtime) {
            // Busca URL de webhook da instância
            const { data: instance } = await supabase
                .from('instances')
                .select('webhook_url, webhook_enabled, webhook_events, id')
                .eq('session_id', sessionId)
                .single();

            if (instance?.webhook_enabled && instance.webhook_url) {
                // Dispara sem await (Fire & Forget)
                dispatchWebhook(instance.webhook_url, 'message.upsert', {
                    ...messageData,
                    pushName
                }, instance.id);
            }
        }

    } catch (e) {
        console.error(`❌ [HANDLER] Erro ao processar mensagem ${msg.key?.id}:`, e.message);
    }
};

// --- HANDLERS DE ATUALIZAÇÃO ---

export const handleMessageUpdate = async (updates, companyId) => {
    for (const update of updates) {
        // Enquetes (Votos)
        if (update.pollUpdates) {
            for (const pollUpdate of update.pollUpdates) {
                const pollMsgId = pollUpdate.pollCreationMessageKey.id;
                const vote = pollUpdate.vote;
                const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey.participant || pollUpdate.pollUpdateMessageKey.remoteJid);
                
                // Busca mensagem original
                const { data: originalMsg } = await supabase
                    .from('messages')
                    .select('poll_votes, content')
                    .eq('whatsapp_id', pollMsgId)
                    .eq('company_id', companyId)
                    .maybeSingle();

                if (originalMsg) {
                    try {
                        // Decripta voto (No Baileys isso é complexo, aqui simplificamos a agregação)
                        // A lib Baileys fornece getAggregateVotesInPollMessage, mas exige a chave de criptografia.
                        // Assumimos que o frontend ou o webhook tratará a lógica fina, 
                        // aqui apenas salvamos o raw update ou um array simplificado se conseguirmos.
                        
                        let currentVotes = Array.isArray(originalMsg.poll_votes) ? originalMsg.poll_votes : [];
                        
                        // Remove voto anterior do mesmo usuário
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);
                        
                        // Adiciona novo voto
                        const selectedOptions = vote.selectedOptions.map(opt => {
                            // Tenta mapear o hash da opção para o texto (se possível)
                            // Na prática, precisaria do getAggregateVotesInPollMessage do Baileys
                            // Para MVP, salvamos o hash
                            return Buffer.isBuffer(opt) ? opt.toString('hex') : opt; 
                        });

                        currentVotes.push({
                            voterJid,
                            selectedOptions,
                            ts: Date.now()
                        });

                        await supabase
                            .from('messages')
                            .update({ poll_votes: currentVotes })
                            .eq('whatsapp_id', pollMsgId)
                            .eq('company_id', companyId);

                    } catch (e) {
                        console.error("[POLL] Erro ao processar voto:", e);
                    }
                }
            }
        }
    }
};

export const handleReceiptUpdate = async (events, companyId) => {
    for (const event of events) {
        const { key, receipt } = event;
        // status: 1=sent, 2=delivered, 3=read/played
        
        let statusStr = 'sent';
        if (receipt.userJid) {
            // Receipt de usuário específico (em grupo)
            // Em MVP ignoramos recibos individuais de grupo para não spammar updates
            continue; 
        }

        // Mapeamento Baileys -> Wancora
        // read | receipt-played
        const type = event.type; 
        
        if (type === 'read' || type === 'read-self') statusStr = 'read';
        else if (type === 'delivery') statusStr = 'delivered';
        else return; // Outros tipos ignorados

        await supabase
            .from('messages')
            .update({ status: statusStr, [statusStr === 'read' ? 'read_at' : 'delivered_at']: new Date() })
            .eq('whatsapp_id', key.id)
            .eq('company_id', companyId);
    }
};
