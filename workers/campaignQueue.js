
import { Queue } from 'bullmq';
import getRedisClient from '../services/redisClient.js';
import pino from 'pino';

const logger = pino({ level: 'info' });
const connection = getRedisClient();

export const campaignQueue = new Queue('campaigns', {
    connection,
    defaultJobOptions: {
        attempts: 3, 
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
    }
});

export const dispatchCampaign = async (companyId, campaignId, leads, messageTemplate) => {
    logger.info({ companyId, campaignId, count: leads.length }, 'Enfileirando campanha...');

    const jobs = leads.map(lead => ({
        name: 'send-message',
        data: {
            companyId,
            campaignId,
            lead, 
            messageTemplate
        }
    }));

    await campaignQueue.addBulk(jobs);
    logger.info('✅ Jobs enfileirados com sucesso.');
};
