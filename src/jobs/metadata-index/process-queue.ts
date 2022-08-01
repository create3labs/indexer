/* eslint-disable @typescript-eslint/no-explicit-any */

import axios from "axios";
import _ from "lodash";
import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis, extendLock, releaseLock } from "@/common/redis";
import { config } from "@/config/index";
import { PendingRefreshTokens } from "@/models/pending-refresh-tokens";
import * as metadataIndexWrite from "@/jobs/metadata-index/write-queue";

const QUEUE_NAME = "metadata-index-process-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "fixed",
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    timeout: 60 * 1000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { method } = job.data;

      const count = 20;

      const queryParams = new URLSearchParams();
      queryParams.append("method", method);

      // Get the tokens from the list
      const pendingRefreshTokens = new PendingRefreshTokens(method);
      const refreshTokens = await pendingRefreshTokens.get(count);

      // If no more tokens
      if (_.isEmpty(refreshTokens)) {
        return;
      }

      // Build the query string and store the collection for each token
      const metadatas = [];
      for (const refreshToken of refreshTokens) {
        // Get the metadata for the tokens
        const url = `https://meta.polkamon.com/meta?id=${refreshToken.tokenId}`;
        const metadata: any = await axios.get(url, { timeout: 60 * 1000 }).then(({ data }) => data);
        metadatas.push({
          ...metadata,
          ...refreshToken,
          imageUrl: metadata?.image,
          mediaUrl: metadata?.animation_url,
          attributes: metadata?.attributes.map((el: any) => ({
            key: el.trait_type,
            value: el.value,
            kind: "string",
          })),
        });
      }

      await metadataIndexWrite.addToQueue(
        metadatas.map((m) => ({
          ...m,
        }))
      );

      // If there are potentially more tokens to process trigger another job
      if (_.size(refreshTokens) == count) {
        if (await extendLock(getLockName(method), 60 * 5)) {
          await addToQueue(method);
        }
      } else {
        await releaseLock(getLockName(method));
      }
    },
    { connection: redis.duplicate(), concurrency: 2 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const getLockName = (method: string) => {
  return `${QUEUE_NAME}:${method}`;
};

export const addToQueue = async (method: string) => {
  await queue.add(randomUUID(), { method });
};
