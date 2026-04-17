import { getContentType, normalizeJid, unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import { upsertMessage, ensureLeadExists, upsertContact } from '../../crm/sync.js';
import { refreshContactInfo } from './contactHandler.js';
import { dispatchWebhook } from '../../integrations/webhook.js';
import { createClient } from '@supabase/supabase-js';
import { Logger } from '../../../utils/logger.js';
import { enqueueAIAfterDebounce } from '../../scheduler/aiQueue.js';
import getRedisClient from '../../redisClient.js';
import { identityResolver } from '../pipelines/identityPipeline.js';
import { mediaPipeline } from '../pipelines/mediaPipeline.js';


const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// 🛡️ DEDUPLICAÇÃO DE MENSAGENS (ANTI-DUPLO-PROCESSAMENTO)
const processedMessages = new Set();
const deduplicateMessage = async (msgId, companyId) => {
    const redis = getRedisClient();
    const key = `msg_proc:${companyId}:${msgId}`;
    
    if (redis && redis.status === 'ready') {
        const exists = await redis.get(key);
        if (exists) return true;
        await redis.set(key, '1', 'EX', 300); // 5 minutos de cache
        return false;
    } else {
        // Fallback em memória (LRU simples)
        if (processedMessages.has(key)) return true;
        processedMessages.add(key);
        setTimeout(() => processedMessages.delete(key), 300000);
        return false;
    }
};

// --- 1. HANDLE NEW MESSAGE (UPSERT) ---
export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime = true, forcedName = null, options = {}) => {
    try {
        const { downloadMedia = true, fetchProfilePic = false, createLead = false } = options;

        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.includes('@newsletter')) return;

        const unwrapped = unwrapMessage(msg);
        const msgId = unwrapped.key.id;

        // 🛡️ DEDUPLICAÇÃO: Evita que a mesma mensagem dispare IA ou Webhook duas vezes
        if (isRealtime && !unwrapped.key.fromMe) {
            const isDuplicate = await deduplicateMessage(msgId, companyId);
            if (isDuplicate) return;
        }

        let jid = normalizeJid(unwrapped.key.remoteJid);
        
        // [REFINE] Block Official WhatsApp Messages
        if (jid === '0@s.whatsapp.net') return;

        const type = getContentType(unwrapped.message);
        
        // Ignora tipos que são eventos e não mensagens visuais
        if (!type || 
            type === 'protocolMessage' || 
            type === 'senderKeyDistributionMessage' || 
            type === 'messageContextInfo' ||
            type === 'reactionMessage' ||  
            type === 'pollUpdateMessage'   
        ) {
            return;
        }

        const isGroup = jid.includes('@g.us');
        const participantJid = isGroup && unwrapped.key.participant ? normalizeJid(unwrapped.key.participant) : null;
        
        const fromMe = unwrapped.key.fromMe;
        const pushName = forcedName || unwrapped.pushName;
        
        const body = getBody(unwrapped.message);
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);
        
        // Permite sticker passar mesmo sem body
        if (!body && !isMedia && type !== 'stickerMessage') return;

        // =================================================================
        // LID RESOLVER — PIPELINE CACHEADA
        // =================================================================
        jid = await identityResolver.resolveIdentity(jid, companyId);



        // --- CORREÇÃO CRÍTICA: GARANTIA DE CONTATO ---
        if (!fromMe && !isGroup) {
            await upsertContact(jid, companyId, pushName, null, false, null, false, null, { 
                push_name: pushName,
                last_message_at: new Date()
            });
        }
        // ----------------------------------------------

        // --- GHOST CHAT PREVENTION (Groups) ---
        if (isGroup && participantJid && !fromMe) {
            if (pushName) {
                await upsertContact(participantJid, companyId, null, null, false, null, false, null, { push_name: pushName });
            }
            if (isRealtime && fetchProfilePic) {
                refreshContactInfo(sock, participantJid, companyId, pushName).catch(() => {});
            }
        }
        
        // --- LEAD GUARD ---
        if (!fromMe && !isGroup) {
            const { data: contact } = await supabase.from('contacts').select('is_ignored').eq('jid', jid).eq('company_id', companyId).maybeSingle();
            if (contact?.is_ignored) {
                 // Logger.info('baileys', `[IGNORE] Msg de ${jid} ignorada (Blacklist).`, {}, companyId);
                 return;
            }

            const myJid = normalizeJid(sock.user?.id);
            if (isRealtime || createLead) {
                await ensureLeadExists(jid, companyId, pushName, myJid);
                if (isRealtime || fetchProfilePic) {
                    refreshContactInfo(sock, jid, companyId, pushName).catch(() => {});
                }
            }
        }

        // ─────────────────────────────────────────────────────────────────────
        // PIPELINE DE MÍDIA (Isolada, Sem Bloquear o Event Loop)
        // ─────────────────────────────────────────────────────────────────────
        let mediaUrl = null;
        if (isMedia) {
            mediaUrl = await mediaPipeline.processMedia(msgId, unwrapped, type, companyId, isRealtime, downloadMedia);
        }


        const messageData = {
            company_id: companyId,
            session_id: sessionId,
            remote_jid: jid,
            whatsapp_id: unwrapped.key.id,
            from_me: fromMe,
            content: body,
            message_type: type?.replace('Message', '') || 'unknown',
            media_url: mediaUrl,
            status: fromMe ? 'sent' : 'delivered',
            created_at: new Date( (unwrapped.messageTimestamp || Date.now() / 1000) * 1000 ),
            participant: participantJid, 
            lead_id: null // 🛡️ CORREÇÃO: Usar null em vez de undefined. Undefined destrói o fetch do Supabase.
        };

        // [TRANSCRIÇÃO REMOVIDA DAQUI — agora é fire-and-forget no bloco acima]
        
        if (!isGroup && !fromMe) {
             const purePhone = jid.split('@')[0].replace(/\D/g, '');
             const { data: lead } = await supabase.from('leads').select('id').eq('phone', purePhone).eq('company_id', companyId).maybeSingle();
             if (lead) messageData.lead_id = lead.id;
        }

        // Tratamento de Tipos Especiais
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
            messageData.content = JSON.stringify({ latitude: loc.degreesLatitude, longitude: loc.degreesLongitude });
        }
        else if (type === 'contactMessage') {
            const contact = unwrapped.message[type];
            messageData.message_type = 'contact';
            messageData.content = JSON.stringify({ displayName: contact.displayName, vcard: contact.vcard });
        }

        await upsertMessage(messageData);

        // 🛡️ O GATILHO DA I.A: Entrega a mensagem processada direto para a fila de Debounce do BullMQ!
        if (isRealtime && !fromMe && !isGroup) {
            enqueueAIAfterDebounce(messageData);
        }

        if (isRealtime) {
            const { data: instance } = await supabase.from('instances').select('webhook_url, webhook_enabled, id').eq('session_id', sessionId).single();
            if (instance?.webhook_enabled && instance.webhook_url) {
                const webhookPayload = { ...messageData, pushName, participant: participantJid };
                dispatchWebhook(instance.webhook_url, 'message.upsert', webhookPayload, instance.id);
            }
        }

    } catch (e) {
        Logger.error('baileys', `[HANDLER] Erro ao processar msg ${msg.key?.id}`, { error: e.message }, companyId);
    }
};

export const handleMessageUpdate = async (updates, companyId) => {
    for (const update of updates) {
        if (update.pollUpdates) {
            for (const pollUpdate of update.pollUpdates) {
                const pollMsgId = pollUpdate.pollCreationMessageKey.id;
                const vote = pollUpdate.vote;
                const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey.participant || pollUpdate.pollUpdateMessageKey.remoteJid);
                
                const { data: originalMsg } = await supabase.from('messages')
                    .select('poll_votes, content')
                    .eq('whatsapp_id', pollMsgId)
                    .eq('company_id', companyId)
                    .maybeSingle();

                if (originalMsg) {
                    try {
                        // [NATIVO] Usa a função oficial do Baileys para agregar votos de forma segura e compatível
                        const pollCreation = typeof originalMsg.content === 'string' ? JSON.parse(originalMsg.content) : originalMsg.content;
                        
                        // Reconstrói a mensagem de criação para a função de agregação
                        const pollCreationMessage = {
                            pollCreationMessage: {
                                name: pollCreation.name,
                                options: pollCreation.options.map(o => ({ optionName: o })),
                                selectableOptionsCount: pollCreation.selectableOptionsCount
                            }
                        };

                        const aggregatedVotes = getAggregateVotesInPollMessage({
                            message: pollCreationMessage,
                            pollUpdates: update.pollUpdates,
                        });

                        await supabase.from('messages')
                            .update({ poll_votes: aggregatedVotes })
                            .eq('whatsapp_id', pollMsgId)
                            .eq('company_id', companyId);
                    } catch (e) {
                        console.error("Erro ao atualizar enquete (Nativo):", e);
                    }
                }
            }
        }
    }
};

export const handleReceiptUpdate = async (events, companyId) => {
    for (const event of events) {
        const { key, receipt } = event;
        if (receipt.userJid) continue; 
        
        let statusStr = 'sent';
        const type = event.type; 
        
        if (type === 'read' || type === 'read-self') statusStr = 'read';
        else if (type === 'delivery') statusStr = 'delivered';
        else continue;

        const updateData = { status: statusStr };
        if (statusStr === 'read') updateData.read_at = new Date();
        else if (statusStr === 'delivered') updateData.delivered_at = new Date();

        await supabase.from('messages')
            .update(updateData)
            .eq('whatsapp_id', key.id)
            .eq('company_id', companyId);
    }
};

export const handleReaction = async (reactions, sock, companyId) => {
    for (const reaction of reactions) {
        const { key, reaction: r } = reaction;
        const msgId = key.id;
        const participant = key.participant || key.remoteJid;
        const actor = normalizeJid(participant);
        const emoji = r.text; 

        if (!msgId || !companyId) continue;

        try {
            const { data: msg } = await supabase.from('messages')
                .select('id, reactions')
                .eq('whatsapp_id', msgId)
                .eq('company_id', companyId)
                .maybeSingle();

            if (msg) {
                let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
                
                currentReactions = currentReactions.filter(rx => rx.actor !== actor);
                
                if (emoji && emoji !== "") {
                    currentReactions.push({ text: emoji, actor: actor, ts: Date.now() });
                }
                
                await supabase.from('messages')
                    .update({ reactions: currentReactions })
                    .eq('id', msg.id);
            }
        } catch (e) {
            console.error("Erro reaction:", e);
        }
    }
};
