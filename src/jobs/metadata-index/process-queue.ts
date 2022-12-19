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
import { ethers } from "ethers";

const QUEUE_NAME = "metadata-index-process-queue";

const JSON_BASE64_PREFIX = "data:application/json;base64,";

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

const mapMetadata = (metadata: any) => {
  return {
    name: metadata.name,
    description: metadata.description,
    imageUrl: metadata.image,
    mediaUrl: metadata.animation_url,
    attributes: (metadata?.attributes || []).map((el: any) => {
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
  };
};

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

      const count = method == "soundxyz" ? 10 : 20;

      // Get the tokens from the list
      const pendingRefreshTokens = new PendingRefreshTokens(method);
      const refreshTokens = await pendingRefreshTokens.get(count);

      // If no more tokens
      if (_.isEmpty(refreshTokens)) {
        return;
      }

      // Build the query string and store the collection for each token
      const metadatas: TokenMetadata[] = [];

      for (const refreshToken of refreshTokens) {
        // Get the tokenUri from the contract
        const abi = [
          {
            inputs: [
              {
                internalType: "string",
                name: "name",
                type: "string",
              },
              {
                internalType: "string",
                name: "symbol",
                type: "string",
              },
              {
                internalType: "string",
                name: "baseURI",
                type: "string",
              },
            ],
            stateMutability: "nonpayable",
            type: "constructor",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "address",
                name: "owner",
                type: "address",
              },
              {
                indexed: true,
                internalType: "address",
                name: "approved",
                type: "address",
              },
              {
                indexed: true,
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "Approval",
            type: "event",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "address",
                name: "owner",
                type: "address",
              },
              {
                indexed: true,
                internalType: "address",
                name: "operator",
                type: "address",
              },
              {
                indexed: false,
                internalType: "bool",
                name: "approved",
                type: "bool",
              },
            ],
            name: "ApprovalForAll",
            type: "event",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                indexed: true,
                internalType: "bytes32",
                name: "previousAdminRole",
                type: "bytes32",
              },
              {
                indexed: true,
                internalType: "bytes32",
                name: "newAdminRole",
                type: "bytes32",
              },
            ],
            name: "RoleAdminChanged",
            type: "event",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                indexed: true,
                internalType: "address",
                name: "account",
                type: "address",
              },
              {
                indexed: true,
                internalType: "address",
                name: "sender",
                type: "address",
              },
            ],
            name: "RoleGranted",
            type: "event",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                indexed: true,
                internalType: "address",
                name: "account",
                type: "address",
              },
              {
                indexed: true,
                internalType: "address",
                name: "sender",
                type: "address",
              },
            ],
            name: "RoleRevoked",
            type: "event",
          },
          {
            anonymous: false,
            inputs: [
              {
                indexed: true,
                internalType: "address",
                name: "from",
                type: "address",
              },
              {
                indexed: true,
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                indexed: true,
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "Transfer",
            type: "event",
          },
          {
            inputs: [],
            name: "DEFAULT_ADMIN_ROLE",
            outputs: [
              {
                internalType: "bytes32",
                name: "",
                type: "bytes32",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [],
            name: "MINTER_ROLE",
            outputs: [
              {
                internalType: "bytes32",
                name: "",
                type: "bytes32",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "approve",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "owner",
                type: "address",
              },
            ],
            name: "balanceOf",
            outputs: [
              {
                internalType: "uint256",
                name: "",
                type: "uint256",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "burn",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "getApproved",
            outputs: [
              {
                internalType: "address",
                name: "",
                type: "address",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
            ],
            name: "getRoleAdmin",
            outputs: [
              {
                internalType: "bytes32",
                name: "",
                type: "bytes32",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                internalType: "uint256",
                name: "index",
                type: "uint256",
              },
            ],
            name: "getRoleMember",
            outputs: [
              {
                internalType: "address",
                name: "",
                type: "address",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
            ],
            name: "getRoleMemberCount",
            outputs: [
              {
                internalType: "uint256",
                name: "",
                type: "uint256",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                internalType: "address",
                name: "account",
                type: "address",
              },
            ],
            name: "grantRole",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                internalType: "address",
                name: "account",
                type: "address",
              },
            ],
            name: "hasRole",
            outputs: [
              {
                internalType: "bool",
                name: "",
                type: "bool",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "owner",
                type: "address",
              },
              {
                internalType: "address",
                name: "operator",
                type: "address",
              },
            ],
            name: "isApprovedForAll",
            outputs: [
              {
                internalType: "bool",
                name: "",
                type: "bool",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "mint",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [],
            name: "name",
            outputs: [
              {
                internalType: "string",
                name: "",
                type: "string",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "ownerOf",
            outputs: [
              {
                internalType: "address",
                name: "",
                type: "address",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                internalType: "address",
                name: "account",
                type: "address",
              },
            ],
            name: "renounceRole",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes32",
                name: "role",
                type: "bytes32",
              },
              {
                internalType: "address",
                name: "account",
                type: "address",
              },
            ],
            name: "revokeRole",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "from",
                type: "address",
              },
              {
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "safeTransferFrom",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "from",
                type: "address",
              },
              {
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
              {
                internalType: "bytes",
                name: "_data",
                type: "bytes",
              },
            ],
            name: "safeTransferFrom",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "operator",
                type: "address",
              },
              {
                internalType: "bool",
                name: "approved",
                type: "bool",
              },
            ],
            name: "setApprovalForAll",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "string",
                name: "newBaseUri",
                type: "string",
              },
            ],
            name: "setBaseURI",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
              {
                internalType: "string",
                name: "_tokenURI",
                type: "string",
              },
            ],
            name: "setTokenURI",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "bytes4",
                name: "interfaceId",
                type: "bytes4",
              },
            ],
            name: "supportsInterface",
            outputs: [
              {
                internalType: "bool",
                name: "",
                type: "bool",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [],
            name: "symbol",
            outputs: [
              {
                internalType: "string",
                name: "",
                type: "string",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "index",
                type: "uint256",
              },
            ],
            name: "tokenByIndex",
            outputs: [
              {
                internalType: "uint256",
                name: "",
                type: "uint256",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "owner",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "index",
                type: "uint256",
              },
            ],
            name: "tokenOfOwnerByIndex",
            outputs: [
              {
                internalType: "uint256",
                name: "",
                type: "uint256",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "tokenURI",
            outputs: [
              {
                internalType: "string",
                name: "",
                type: "string",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [],
            name: "totalSupply",
            outputs: [
              {
                internalType: "uint256",
                name: "",
                type: "uint256",
              },
            ],
            stateMutability: "view",
            type: "function",
          },
          {
            inputs: [
              {
                internalType: "address",
                name: "from",
                type: "address",
              },
              {
                internalType: "address",
                name: "to",
                type: "address",
              },
              {
                internalType: "uint256",
                name: "tokenId",
                type: "uint256",
              },
            ],
            name: "transferFrom",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
        ];
        const provider = new ethers.providers.JsonRpcProvider(process.env.BASE_NETWORK_HTTP_URL);
        const erc721 = new ethers.Contract(refreshToken.contract, abi, provider);
        const tokenUri = await erc721.callStatic.tokenURI(refreshToken.tokenId);

        // Get the metadata for the tokens
        const url = tokenUri;

        if (url?.startsWith(JSON_BASE64_PREFIX)) {
          const base64Data = url.replace(JSON_BASE64_PREFIX, "");
          const decoded = JSON.parse(new Buffer(base64Data, "base64").toString("utf-8"));

          metadatas.push({
            ...mapMetadata(decoded),
            ...refreshToken,
          });
        } else {
          await promiseRetry(async (retry) => {
            try {
              const metadata: any = await axios
                .get(url, { timeout: 60 * 1000 })
                .then(({ data }) => data);

              metadatas.push({
                ...mapMetadata(metadata),
                ...refreshToken,
              });
            } catch (e) {
              return retry(e);
            }
          });
        }
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
