
import { getContentType, normalizeJid, unwrapMessage, getBody } from '../../../utils/wppParsers.js';
import { upsertMessage, ensureLeadExists } from '../../crm/sync.js';
import { handleMediaUpload } from './mediaHandler.js';
import { refreshContactInfo } from './contactHandler.js'; 
import { dispatchWebhook } from '../../integrations/webhook.js';
import { transcribeAudio } from '../../ai/transcriber.js'; 
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false }
});

export const handleMessage = async (msg, sock, companyId, sessionId, isRealtime = true, forcedName = null, options = {}) => {
    try {
        const { downloadMedia = true, fetchProfilePic = false, createLead = false } = options;

        if (!msg.message) return;
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.includes('@newsletter')) return;

        const unwrapped = unwrapMessage(msg);
        let jid = normalizeJid(unwrapped.key.remoteJid);
        const fromMe = unwrapped.key.fromMe;
        // Usa o nome forçado (do histórico) ou o pushName da mensagem
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

        // Lead Guard & Info Refresh
        let leadId = null;
        if (!fromMe) {
            const myJid = normalizeJid(sock.user?.id);
            if (isRealtime || createLead) {
                // Cria Lead se não existir
                leadId = await ensureLeadExists(jid, companyId, pushName, myJid);
                
                // ATUALIZAÇÃO DE INFORMAÇÕES (NOME/FOTO)
                // Se for realtime ou se pedimos fetchProfilePic (no histórico)
                if (isRealtime || fetchProfilePic) {
                    refreshContactInfo(sock, jid, companyId, pushName).catch(err => console.error("Refresh Error", err));
                }
            }
        }

        // Mídia
        let mediaUrl = null;
        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type);

        if (isMedia && (isRealtime || downloadMedia)) {
            mediaUrl = await handleMediaUpload(unwrapped, companyId);
        }

        // Transcrição
        if (isRealtime && mediaUrl && type === 'audioMessage') {
             try {
                 const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                 const buffer = Buffer.from(response.data);
                 transcribeAudio(buffer, 'audio/ogg', companyId).then(async (text) => {
                     if (text) {
                         await supabase.from('messages').update({ transcription: text }).eq('whatsapp_id', unwrapped.key.id).eq('company_id', companyId);
                     }
                 });
             } catch (err) {}
        }

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
