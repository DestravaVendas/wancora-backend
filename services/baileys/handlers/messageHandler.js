import { getContentType, normalizeJid, unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { upsertMessage, ensureLeadExists, upsertContact } from '../../crm/sync.js';
import { handleMediaUpload } from './mediaHandler.js';
import { refreshContactInfo } from './contactHandler.js'; 
import { dispatchWebhook } from '../../integrations/webhook.js';
import { transcribeAudio } from '../../ai/transcriber.js'; 
import { createClient } from '@supabase/supabase-js';
import { Logger } from '../../../utils/logger.js'; 
import axios from 'axios';
import { aiBus } from '../../scheduler/sentinel.js'; // 🛡️ NOVO: Importação do Event Bus Nativo

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

// --- 1. HANDLE NEW MESSAGE (UPSERT) ---
export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime = true, forcedName = null, options = {}) => {
    try {
        const { downloadMedia = true, fetchProfilePic = false, createLead = false } = options;

        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.includes('@newsletter')) return;

        const unwrapped = unwrapMessage(msg);
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

        // LID RESOLVER
        if (jid.includes('@lid')) {
            const { data: mapping } = await supabase.from('identity_map').select('phone_jid').eq('lid_jid', jid).eq('company_id', companyId).maybeSingle();
            if (mapping?.phone_jid) jid = mapping.phone_jid; 
        }

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

        let mediaUrl = null;
        if (isMedia && (isRealtime || downloadMedia)) {
            mediaUrl = await handleMediaUpload(unwrapped, companyId);
        }

        // Transcrição
        if (isRealtime && mediaUrl && type === 'audioMessage') {
             (async () => {
                 try {
                     const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                     const buffer = Buffer.from(response.data);
                     const text = await transcribeAudio(buffer, 'audio/ogg', companyId);
                     if (text) {
                         await supabase.from('messages').update({ transcription: text }).eq('whatsapp_id', unwrapped.key.id).eq('company_id', companyId);
                     }
                 } catch (err) {}
             })();
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
            lead_id: isGroup ? null : undefined 
        };
        
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

        // 🛡️ O GATILHO NATIVO: Dispara o aviso para o Sentinel instantaneamente, na RAM!
        if (isRealtime && !fromMe && !isGroup) {
            aiBus.emit('new_message_arrived', messageData);
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
                        let currentVotes = Array.isArray(originalMsg.poll_votes) ? originalMsg.poll_votes : [];
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);
                        
                        const selectedOptions = vote.selectedOptions.map(opt => Buffer.isBuffer(opt) ? opt.toString('hex') : opt);
                        
                        currentVotes.push({ voterJid, selectedOptions, ts: Date.now() });
                        
                        await supabase.from('messages')
                            .update({ poll_votes: currentVotes })
                            .eq('whatsapp_id', pollMsgId)
                            .eq('company_id', companyId);
                    } catch (e) {
                        console.error("Erro ao atualizar enquete:", e);
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
