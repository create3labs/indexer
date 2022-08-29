/* eslint-disable @typescript-eslint/no-explicit-any */

import axios from "axios";
import promiseRetry from "promise-retry";
import _ from "lodash";
import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis, extendLock, releaseLock, getLockExpiration } from "@/common/redis";
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
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    timeout: 60 * 1000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  type TokenMetadata = {
    contract: string;
    tokenId: string;
    name: string;
    description: string;
    imageUrl: string;
    mediaUrl?: string;
    collection: string;
    attributes: {
      key: string;
      value: string;
      kind: "string" | "number" | "date" | "range";
      rank?: number;
    }[];
  };

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { method } = job.data;

      const rateLimitExpiresIn = await getLockExpiration(getRateLimitLockName(method));

      if (rateLimitExpiresIn > 0) {
        logger.info(QUEUE_NAME, `Rate Limited. rateLimitExpiresIn: ${rateLimitExpiresIn}`);
      }

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
      // Build the query string and store the collection for each token
      const metadatas: TokenMetadata[] = [];

      for (const refreshToken of refreshTokens) {
        // Get the metadata for the tokens
        const url = `https://meta.polkamon.com/meta?id=${refreshToken.tokenId}`;

        await promiseRetry(async (retry) => {
          try {
            const metadata: any = await axios
              .get(url, { timeout: 60 * 1000 })
              .then(({ data }) => data);
            metadatas.push({
              name: metadata.name,
              description: metadata.description,
              imageUrl: metadata.image,
              mediaUrl: metadata.animation_url,
              attributes: metadata?.attributes.map((el: any) => {
                let kind: string;
                if (el.display_type === "number") {
                  kind = "number";
                } else if (el.display_type === "date") {
                  kind = "number";
                } else {
                  kind = "string";
                }
                return {
                  key: el.trait_type,
                  value: el.value,
                  kind,
                };
              }),
              ...refreshToken,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.log(e);
            return retry(e);
          }
        });
      }

      await metadataIndexWrite.addToQueue(
        metadatas.map((m: TokenMetadata) => ({
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

export const getRateLimitLockName = (method: string) => {
  return `${QUEUE_NAME}:rate-limit:${method}`;
};

export const addToQueue = async (method: string, delay = 0) => {
  await queue.add(randomUUID(), { method }, { delay });
};
