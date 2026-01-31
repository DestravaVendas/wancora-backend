
import { getContentType, normalizeJid, unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { upsertMessage, ensureLeadExists, updateInstanceStatus } from '../../crm/sync.js';
import { handleMediaUpload } from './mediaHandler.js';
import { refreshContactInfo } from './contactHandler.js'; 
import { dispatchWebhook } from '../../integrations/webhook.js';
import { transcribeAudio } from '../../ai/transcriber.js'; // NOVO IMPORT
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime = true, forcedName = null, options = {}) => {
    try {
        const { downloadMedia = true, fetchProfilePic = false, createLead = false } = options;

        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast') return;

        const unwrapped = unwrapMessage(msg);
        let jid = normalizeJid(unwrapped.key.remoteJid);
        const fromMe = unwrapped.key.fromMe;
        const pushName = forcedName || unwrapped.pushName;
        
        const type = getContentType(unwrapped.message);
        const body = getBody(unwrapped.message);

        // LID RESOLVER
        if (jid.includes('@lid')) {
            const { data: mapping } = await supabase.from('identity_map').select('phone_jid').eq('lid_jid', jid).eq('company_id', companyId).maybeSingle();
            if (mapping?.phone_jid) jid = mapping.phone_jid; 
        }

        // Anti-Ghost
        if (!fromMe) {
            const { data: contact } = await supabase.from('contacts').select('is_ignored').eq('jid', jid).eq('company_id', companyId).maybeSingle();
            if (contact?.is_ignored) return;
        }

        // Lead Guard
        let leadId = null;
        if (!fromMe) {
            const myJid = normalizeJid(sock.user?.id);
            if (isRealtime || createLead) {
                leadId = await ensureLeadExists(jid, companyId, pushName, myJid);
                if (isRealtime) refreshContactInfo(sock, jid, companyId, pushName).catch(err => console.error("Refresh Error", err));
            }
        }

        // Mídia
        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);

        if (isMedia && (isRealtime || downloadMedia)) {
            mediaUrl = await handleMediaUpload(unwrapped, companyId);
        }

        // ----------------------------------------------------
        // LOGICA DE TRANSCRIÇÃO (AUDIO RECEBIDO)
        // ----------------------------------------------------
        let transcription = null;
        if (isRealtime && mediaUrl && type === 'audioMessage') {
             // Baixa o áudio para transcrever (Buffer)
             try {
                 const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                 const buffer = Buffer.from(response.data);
                 // Fire and Forget (Promise)
                 transcribeAudio(buffer, 'audio/ogg', companyId).then(async (text) => {
                     if (text) {
                         // Atualiza mensagem no banco com a transcrição
                         await supabase.from('messages')
                             .update({ transcription: text })
                             .eq('whatsapp_id', unwrapped.key.id)
                             .eq('company_id', companyId);
                     }
                 });
             } catch (err) {
                 console.error("[HANDLER] Erro ao baixar audio para transcrição:", err.message);
             }
        }
        // ----------------------------------------------------

        // Payload
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
            lead_id: leadId
            // transcription: será atualizado via update acima
        };

        // Parsers Especiais
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

        // Webhook
        if (isRealtime) {
            const { data: instance } = await supabase.from('instances').select('webhook_url, webhook_enabled, id').eq('session_id', sessionId).single();
            if (instance?.webhook_enabled && instance.webhook_url) {
                dispatchWebhook(instance.webhook_url, 'message.upsert', { ...messageData, pushName }, instance.id);
            }
        }

    } catch (e) {
        console.error(`❌ [HANDLER] Erro msg ${msg.key?.id}:`, e.message);
    }
};

export const handleMessageUpdate = async (updates, companyId) => {
    // ... mantido igual (Poll Logic)
    for (const update of updates) {
        if (update.pollUpdates) {
            for (const pollUpdate of update.pollUpdates) {
                const pollMsgId = pollUpdate.pollCreationMessageKey.id;
                const vote = pollUpdate.vote;
                const voterJid = normalizeJid(pollUpdate.pollUpdateMessageKey.participant || pollUpdate.pollUpdateMessageKey.remoteJid);
                
                const { data: originalMsg } = await supabase.from('messages').select('poll_votes, content').eq('whatsapp_id', pollMsgId).eq('company_id', companyId).maybeSingle();

                if (originalMsg) {
                    try {
                        let currentVotes = Array.isArray(originalMsg.poll_votes) ? originalMsg.poll_votes : [];
                        currentVotes = currentVotes.filter(v => v.voterJid !== voterJid);
                        const selectedOptions = vote.selectedOptions.map(opt => Buffer.isBuffer(opt) ? opt.toString('hex') : opt);
                        currentVotes.push({ voterJid, selectedOptions, ts: Date.now() });
                        await supabase.from('messages').update({ poll_votes: currentVotes }).eq('whatsapp_id', pollMsgId).eq('company_id', companyId);
                    } catch (e) {}
                }
            }
        }
    }
};

export const handleReceiptUpdate = async (events, companyId) => {
    for (const event of events) {
        const { key, receipt } = event;
        let statusStr = 'sent';
        if (receipt.userJid) continue; 
        const type = event.type; 
        if (type === 'read' || type === 'read-self') statusStr = 'read';
        else if (type === 'delivery') statusStr = 'delivered';
        else return;

        await supabase.from('messages').update({ status: statusStr, [statusStr === 'read' ? 'read_at' : 'delivered_at']: new Date() }).eq('whatsapp_id', key.id).eq('company_id', companyId);
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
            const { data: msg } = await supabase.from('messages').select('id, reactions').eq('whatsapp_id', msgId).eq('company_id', companyId).maybeSingle();

            if (msg) {
                let currentReactions = Array.isArray(msg.reactions) ? msg.reactions : [];
                currentReactions = currentReactions.filter(rx => rx.actor !== actor);
                if (emoji) currentReactions.push({ text: emoji, actor: actor, ts: Date.now() });
                await supabase.from('messages').update({ reactions: currentReactions }).eq('id', msg.id);
            }
        } catch (e) {}
    }
};
