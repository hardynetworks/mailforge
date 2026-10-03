import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { config } from './config';

export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const sendQueue = new Queue('send', {
  connection,
  defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
});
export const webhookQueue = new Queue('webhooks', {
  connection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 1000,
    removeOnFail: 2000,
  },
});
export const campaignQueue = new Queue('campaigns', { connection, defaultJobOptions: { removeOnComplete: 100 } });

export async function enqueueSend(messageId: string, delayMs = 0) {
  await sendQueue.add('send', { messageId }, {
    jobId: messageId,
    delay: delayMs,
    attempts: config.maxAttempts,
    backoff: { type: 'exponential', delay: config.retryBaseDelayMs },
  });
}
