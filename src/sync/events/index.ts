import { Log } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";
import { getReferrer } from "@reservoir0x/sdk/dist/utils";
import _ from "lodash";
import pLimit from "p-limit";

import { logger } from "@/common/logger";
import { pgp, redb } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { bn, fromBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { EventDataKind, getEventData } from "@/events-sync/data";
import * as es from "@/events-sync/storage";
import { parseEvent } from "@/events-sync/parser";
import * as blockCheck from "@/jobs/events-sync/block-check-queue";
import * as fillUpdates from "@/jobs/fill-updates/queue";
import * as orderUpdatesById from "@/jobs/order-updates/by-id-queue";
import * as orderUpdatesByMaker from "@/jobs/order-updates/by-maker-queue";
import * as orderbookOrders from "@/jobs/orderbook/orders-queue";
import * as tokenUpdatesMint from "@/jobs/token-updates/mint-queue";
import * as processActivityEvent from "@/jobs/activities/process-activity-event";
import * as removeUnsyncedEventsActivities from "@/jobs/activities/remove-unsynced-events-activities";
import * as blocksModel from "@/models/blocks";
import { Sources } from "@/models/sources";
import * as Foundation from "@/orderbook/orders/foundation";
import * as syncEventsUtils from "@/events-sync/utils";

// TODO: Split into multiple files (by exchange)
// TODO: For simplicity, don't use bulk inserts/upserts for realtime
// processing (this will make things so much more flexible). However
// for backfill procesing, we should still use bulk operations so as
// to be performant enough. This might imply separate code to handle
// backfill vs realtime events.

export const syncEvents = async (
  fromBlock: number,
  toBlock: number,
  options?: {
    backfill?: boolean;
    eventDataKinds?: EventDataKind[];
  }
) => {
  // --- Handle: known router contract fills ---

  // Fills going through router contracts are to be handled in a
  // custom way so as to properly associate the maker and taker
  let routers: { [address: string]: string } = {};
  if (Sdk.Common.Addresses.Routers[config.chainId]) {
    routers = Sdk.Common.Addresses.Routers[config.chainId];
  }

  // --- Handle: fetch and process events ---

  // Cache blocks for efficiency
  const blocksCache = new Map<number, blocksModel.Block>();
  // Keep track of all handled `${block}-${blockHash}` pairs
  const blocksSet = new Set<string>();

  // Keep track of data needed by other processes that will get triggered
  const fillInfos: fillUpdates.FillInfo[] = [];
  const orderInfos: orderUpdatesById.OrderInfo[] = [];
  const makerInfos: orderUpdatesByMaker.MakerInfo[] = [];
  const mintInfos: tokenUpdatesMint.MintInfo[] = [];

  // Before proceeding, fetch all individual blocks within the current range
  const limit = pLimit(5);
  await Promise.all(
    _.range(fromBlock, toBlock + 1).map((block) =>
      limit(() => baseProvider.getBlockWithTransactions(block))
    )
  );

  // Initialize a sources instance
  const sources = await Sources.getInstance();

  // When backfilling, certain processes are disabled
  const backfill = Boolean(options?.backfill);
  const eventDatas = getEventData(options?.eventDataKinds);
  await baseProvider
    .getLogs({
      // Only keep unique topics (eg. an example of duplicated topics are
      // erc721 and erc20 transfers which have the exact same signature)
      topics: [[...new Set(eventDatas.map(({ topic }) => topic))]],
      fromBlock,
      toBlock,
      ...(process.env.WL_COLLECTION && {
        address: process.env.WL_COLLECTION,
      }),
    })
    .then(async (logs) => {
      const ftTransferEvents: es.ftTransfers.Event[] = [];
      const nftApprovalEvents: es.nftApprovals.Event[] = [];
      const nftTransferEvents: es.nftTransfers.Event[] = [];
      const bulkCancelEvents: es.bulkCancels.Event[] = [];
      const nonceCancelEvents: es.nonceCancels.Event[] = [];
      const cancelEvents: es.cancels.Event[] = [];
      const cancelEventsFoundation: es.cancels.Event[] = [];
      const fillEvents: es.fills.Event[] = [];
      const fillEventsPartial: es.fills.Event[] = [];
      const fillEventsFoundation: es.fills.Event[] = [];
      const foundationOrders: Foundation.OrderInfo[] = [];

      // Keep track of all events within the currently processing transaction
      let currentTx: string | undefined;
      let currentTxEvents: {
        log: Log;
        address: string;
        logIndex: number;
      }[] = [];

      for (const log of logs) {
        try {
          const baseEventParams = await parseEvent(log, blocksCache);
          blocksSet.add(`${log.blockNumber}-${log.blockHash}`);

          // It's quite important from a performance perspective to have
          // the block data available before proceeding with the events
          if (!blocksCache.has(baseEventParams.block)) {
            blocksCache.set(
              baseEventParams.block,
              await blocksModel.saveBlock({
                number: baseEventParams.block,
                hash: baseEventParams.blockHash,
                timestamp: baseEventParams.timestamp,
              })
            );
          }

          // Save the event in the currently processing transaction data
          if (currentTx !== baseEventParams.txHash) {
            currentTx = baseEventParams.txHash;
            currentTxEvents = [];
          }
          currentTxEvents.push({
            log,
            address: baseEventParams.address,
            logIndex: baseEventParams.logIndex,
          });

          // Find first matching event:
          // - matching topic
          // - matching number of topics (eg. indexed fields)
          // - matching addresses
          const eventData = eventDatas.find(
            ({ addresses, topic, numTopics }) =>
              log.topics[0] === topic &&
              log.topics.length === numTopics &&
              (addresses ? addresses[log.address.toLowerCase()] : true)
          );

          switch (eventData?.kind) {
            // Erc721

            case "erc721-transfer": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();

              nftTransferEvents.push({
                kind: "erc721",
                from,
                to,
                tokenId,
                amount: "1",
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenId}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-sell-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-sell-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });

              if (from === AddressZero) {
                mintInfos.push({
                  contract: baseEventParams.address,
                  tokenId,
                  mintedTimestamp: baseEventParams.timestamp,
                });
              }

              break;
            }

            // Erc1155

            case "erc1155-transfer-single": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenId = parsedLog.args["tokenId"].toString();
              const amount = parsedLog.args["amount"].toString();

              nftTransferEvents.push({
                kind: "erc1155",
                from,
                to,
                tokenId,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenId}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-sell-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-sell-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-balance",
                  contract: baseEventParams.address,
                  tokenId,
                },
              });

              if (from === AddressZero) {
                mintInfos.push({
                  contract: baseEventParams.address,
                  tokenId,
                  mintedTimestamp: baseEventParams.timestamp,
                });
              }

              break;
            }

            case "erc1155-transfer-batch": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const tokenIds = parsedLog.args["tokenIds"].map(String);
              const amounts = parsedLog.args["amounts"].map(String);

              const count = Math.min(tokenIds.length, amounts.length);
              for (let i = 0; i < count; i++) {
                nftTransferEvents.push({
                  kind: "erc1155",
                  from,
                  to,
                  tokenId: tokenIds[i],
                  amount: amounts[i],
                  baseEventParams: {
                    ...baseEventParams,
                    batchIndex: i + 1,
                  },
                });

                // Make sure to only handle the same data once per transaction
                const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${tokenIds[i]}`;

                makerInfos.push({
                  context: `${contextPrefix}-${from}-sell-balance`,
                  maker: from,
                  trigger: {
                    kind: "balance-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "sell-balance",
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                  },
                });
                makerInfos.push({
                  context: `${contextPrefix}-${to}-sell-balance`,
                  maker: to,
                  trigger: {
                    kind: "balance-change",
                    txHash: baseEventParams.txHash,
                    txTimestamp: baseEventParams.timestamp,
                  },
                  data: {
                    kind: "sell-balance",
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                  },
                });

                if (from === AddressZero) {
                  mintInfos.push({
                    contract: baseEventParams.address,
                    tokenId: tokenIds[i],
                    mintedTimestamp: baseEventParams.timestamp,
                  });
                }
              }

              break;
            }

            // Erc721/Erc1155 common

            case "erc721/1155-approval-for-all": {
              const parsedLog = eventData.abi.parseLog(log);
              const owner = parsedLog.args["owner"].toLowerCase();
              const operator = parsedLog.args["operator"].toLowerCase();
              const approved = parsedLog.args["approved"];

              nftApprovalEvents.push({
                owner,
                operator,
                approved,
                baseEventParams,
              });

              // Make sure to only handle the same data once per on-chain event
              // (instead of once per transaction as we do with balance updates
              // since we're handling nft approvals differently - checking them
              // individually).
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}-${baseEventParams.logIndex}`;

              makerInfos.push({
                context: `${contextPrefix}-${owner}-sell-approval`,
                maker: owner,
                trigger: {
                  kind: "approval-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "sell-approval",
                  contract: baseEventParams.address,
                  operator,
                  approved,
                },
              });

              break;
            }

            // Erc20

            case "erc20-transfer": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const to = parsedLog.args["to"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from,
                to,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-buy-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });
              makerInfos.push({
                context: `${contextPrefix}-${to}-buy-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            case "erc20-approval": {
              const parsedLog = eventData.abi.parseLog(log);
              const owner = parsedLog.args["owner"].toLowerCase();
              const spender = parsedLog.args["spender"].toLowerCase();

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${owner}-${spender}-buy-approval`,
                maker: owner,
                trigger: {
                  kind: "approval-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-approval",
                  contract: Sdk.Common.Addresses.Weth[config.chainId],
                  operator: spender,
                },
              });

              break;
            }

            // Weth

            case "weth-deposit": {
              const parsedLog = eventData.abi.parseLog(log);
              const to = parsedLog.args["to"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from: AddressZero,
                to,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${to}-buy-balance`,
                maker: to,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            case "weth-withdrawal": {
              const parsedLog = eventData.abi.parseLog(log);
              const from = parsedLog.args["from"].toLowerCase();
              const amount = parsedLog.args["amount"].toString();

              ftTransferEvents.push({
                from,
                to: AddressZero,
                amount,
                baseEventParams,
              });

              // Make sure to only handle the same data once per transaction
              const contextPrefix = `${baseEventParams.txHash}-${baseEventParams.address}`;

              makerInfos.push({
                context: `${contextPrefix}-${from}-buy-balance`,
                maker: from,
                trigger: {
                  kind: "balance-change",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
                data: {
                  kind: "buy-balance",
                  contract: baseEventParams.address,
                },
              });

              break;
            }

            case "seaport-order-cancelled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();

              cancelEvents.push({
                orderKind: "seaport",
                orderId,
                baseEventParams,
              });

              orderInfos.push({
                context: `cancelled-${orderId}`,
                id: orderId,
                trigger: {
                  kind: "cancel",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                  logIndex: baseEventParams.logIndex,
                  batchIndex: baseEventParams.batchIndex,
                  blockHash: baseEventParams.blockHash,
                },
              });

              break;
            }

            case "seaport-counter-incremented": {
              const parsedLog = eventData.abi.parseLog(log);
              const maker = parsedLog.args["offerer"].toLowerCase();
              const newCounter = parsedLog.args["newCounter"].toString();

              bulkCancelEvents.push({
                orderKind: "seaport",
                maker,
                minNonce: newCounter,
                baseEventParams,
              });

              break;
            }

            case "seaport-order-filled": {
              const parsedLog = eventData.abi.parseLog(log);
              const orderId = parsedLog.args["orderHash"].toLowerCase();
              const maker = parsedLog.args["offerer"].toLowerCase();
              let taker = parsedLog.args["recipient"].toLowerCase();
              const offer = parsedLog.args["offer"];
              const consideration = parsedLog.args["consideration"];

              const saleInfo = new Sdk.Seaport.Exchange(config.chainId).deriveBasicSale(
                offer,
                consideration
              );
              if (saleInfo) {
                let side: "sell" | "buy";
                if (saleInfo.paymentToken === Sdk.Common.Addresses.Eth[config.chainId]) {
                  side = "sell";
                } else if (saleInfo.paymentToken === Sdk.Common.Addresses.Weth[config.chainId]) {
                  side = "buy";
                } else {
                  break;
                }

                if (saleInfo.recipientOverride) {
                  taker = saleInfo.recipientOverride;
                }

                // Handle aggregator source
                let aggregatorSource: { id: number; domain: string } | undefined;
                const tx = await syncEventsUtils.fetchTransaction(baseEventParams.txHash);
                if (routers[tx.to]) {
                  taker = tx.from;
                  aggregatorSource = await sources.getOrInsert(routers[tx.to]);
                }

                // Handle fill source
                let fillSource: { id: number } | undefined;
                const referrer = getReferrer(tx.data);
                if (referrer) {
                  fillSource = await sources.getOrInsert(referrer);
                } else if (aggregatorSource?.domain !== "reservoir.market") {
                  fillSource = aggregatorSource;
                }

                const price = bn(saleInfo.price).div(saleInfo.amount).toString();

                const orderKind = "seaport";
                const orderSourceIdInt = await syncEventsUtils.getOrderSourceByOrderKind(orderKind);

                // Custom handling to support partial filling
                fillEventsPartial.push({
                  orderKind,
                  orderId,
                  orderSide: side,
                  orderSourceIdInt,
                  maker,
                  taker,
                  price,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  aggregatorSourceId: aggregatorSource?.id,
                  fillSourceId: fillSource?.id,
                  baseEventParams,
                });

                fillInfos.push({
                  context: `${orderId}-${baseEventParams.txHash}`,
                  orderId: orderId,
                  orderSide: side,
                  contract: saleInfo.contract,
                  tokenId: saleInfo.tokenId,
                  amount: saleInfo.amount,
                  price,
                  timestamp: baseEventParams.timestamp,
                });
              }

              orderInfos.push({
                context: `filled-${orderId}-${baseEventParams.txHash}`,
                id: orderId,
                trigger: {
                  kind: "sale",
                  txHash: baseEventParams.txHash,
                  txTimestamp: baseEventParams.timestamp,
                },
              });

              break;
            }
          }
        } catch (error) {
          logger.info("sync-events", `Failed to handle events: ${error}`);
          throw error;
        }
      }

      if (!backfill) {
        // Assign source based on order for each fill.
        await Promise.all([
          assignOrderSourceToFillEvents(fillEvents),
          assignOrderSourceToFillEvents(fillEventsPartial),
          assignOrderSourceToFillEvents(fillEventsFoundation),
        ]);

        await Promise.all([
          assignWashTradingScoreToFillEvents(fillEvents),
          assignWashTradingScoreToFillEvents(fillEventsPartial),
          assignWashTradingScoreToFillEvents(fillEventsFoundation),
        ]);
      } else {
        logger.warn("sync-events", `Skipping assigning orders source assigned to fill events`);
      }

      // WARNING! Ordering matters (fills should come in front of cancels).
      await Promise.all([
        es.fills.addEvents(fillEvents),
        es.fills.addEventsPartial(fillEventsPartial),
        es.fills.addEventsFoundation(fillEventsFoundation),
      ]);

      await Promise.all([
        es.nonceCancels.addEvents(nonceCancelEvents, backfill),
        es.bulkCancels.addEvents(bulkCancelEvents, backfill),
        es.cancels.addEvents(cancelEvents),
        es.cancels.addEventsFoundation(cancelEventsFoundation),
        es.ftTransfers.addEvents(ftTransferEvents, backfill),
        es.nftApprovals.addEvents(nftApprovalEvents),
        es.nftTransfers.addEvents(nftTransferEvents, backfill),
      ]);

      if (!backfill) {
        // WARNING! It's very important to guarantee that the previous
        // events are persisted to the database before any of the jobs
        // below are executed. Otherwise, the jobs can potentially use
        // stale data which will cause inconsistencies (eg. orders can
        // have wrong statuses).
        await Promise.all([
          fillUpdates.addToQueue(fillInfos),
          orderUpdatesById.addToQueue(orderInfos),
          orderUpdatesByMaker.addToQueue(makerInfos),
          orderbookOrders.addToQueue(
            foundationOrders.map((info) => ({ kind: "foundation", info }))
          ),
        ]);
      }

      // --- Handle: orphan blocks ---
      if (!backfill) {
        for (const blockData of blocksSet.values()) {
          const block = Number(blockData.split("-")[0]);
          const blockHash = blockData.split("-")[1];

          // Act right away if the current block is a duplicate
          if ((await blocksModel.getBlocks(block)).length > 1) {
            blockCheck.addToQueue(block, blockHash, 10);
            blockCheck.addToQueue(block, blockHash, 30);
          }
        }

        // Put all fetched blocks on a queue for handling block reorgs
        // (recheck each block in 1m, 5m, 10m and 60m).
        // TODO: The check frequency should be a per-chain setting
        await Promise.all(
          [...blocksSet.values()].map(async (blockData) => {
            const block = Number(blockData.split("-")[0]);
            const blockHash = blockData.split("-")[1];

            return Promise.all([
              blockCheck.addToQueue(block, blockHash, 60),
              blockCheck.addToQueue(block, blockHash, 5 * 60),
              blockCheck.addToQueue(block, blockHash, 10 * 60),
              blockCheck.addToQueue(block, blockHash, 30 * 60),
              blockCheck.addToQueue(block, blockHash, 60 * 60),
            ]);
          })
        );
      }

      // --- Handle: activities ---

      // Add all the fill events to the activity queue
      const fillActivitiesInfo: processActivityEvent.EventInfo[] = _.map(
        _.concat(fillEvents, fillEventsPartial, fillEventsFoundation),
        (event) => {
          let fromAddress = event.maker;
          let toAddress = event.taker;

          if (event.orderSide === "buy") {
            fromAddress = event.taker;
            toAddress = event.maker;
          }

          return {
            kind: processActivityEvent.EventKind.fillEvent,
            data: {
              contract: event.contract,
              tokenId: event.tokenId,
              fromAddress,
              toAddress,
              price: Number(event.price),
              amount: Number(event.amount),
              transactionHash: event.baseEventParams.txHash,
              logIndex: event.baseEventParams.logIndex,
              batchIndex: event.baseEventParams.batchIndex,
              blockHash: event.baseEventParams.blockHash,
              timestamp: event.baseEventParams.timestamp,
              orderId: event.orderId || "",
            },
          };
        }
      );

      if (!_.isEmpty(fillActivitiesInfo)) {
        await processActivityEvent.addToQueue(fillActivitiesInfo);
      }

      // Add all the transfer/mint events to the activity queue
      const transferActivitiesInfo: processActivityEvent.EventInfo[] = _.map(
        nftTransferEvents,
        (event) => ({
          context: [
            processActivityEvent.EventKind.nftTransferEvent,
            event.baseEventParams.txHash,
            event.baseEventParams.logIndex,
            event.baseEventParams.batchIndex,
          ].join(":"),
          kind: processActivityEvent.EventKind.nftTransferEvent,
          data: {
            contract: event.baseEventParams.address,
            tokenId: event.tokenId,
            fromAddress: event.from,
            toAddress: event.to,
            amount: Number(event.amount),
            transactionHash: event.baseEventParams.txHash,
            logIndex: event.baseEventParams.logIndex,
            batchIndex: event.baseEventParams.batchIndex,
            blockHash: event.baseEventParams.blockHash,
            timestamp: event.baseEventParams.timestamp,
          },
        })
      );

      if (!_.isEmpty(transferActivitiesInfo)) {
        await processActivityEvent.addToQueue(transferActivitiesInfo);
      }

      // --- Handle: mints ---

      // We want to get metadata when backfilling as well
      await tokenUpdatesMint.addToQueue(mintInfos);
    });
};

export const unsyncEvents = async (block: number, blockHash: string) => {
  await Promise.all([
    es.fills.removeEvents(block, blockHash),
    es.bulkCancels.removeEvents(block, blockHash),
    es.nonceCancels.removeEvents(block, blockHash),
    es.cancels.removeEvents(block, blockHash),
    es.ftTransfers.removeEvents(block, blockHash),
    es.nftApprovals.removeEvents(block, blockHash),
    es.nftTransfers.removeEvents(block, blockHash),
    removeUnsyncedEventsActivities.addToQueue(blockHash),
  ]);
};

const assignOrderSourceToFillEvents = async (fillEvents: es.fills.Event[]) => {
  try {
    const orderIds = fillEvents.filter((e) => e.orderId !== undefined).map((e) => e.orderId);
    if (orderIds.length) {
      const orders = [];
      const orderIdChunks = _.chunk(orderIds, 100);

      for (const chunk of orderIdChunks) {
        const ordersChunk = await redb.manyOrNone(
          `
            SELECT
              orders.id,
              orders.source_id_int
            FROM orders
            WHERE id IN ($/orderIds:list/)
              AND source_id_int IS NOT NULL
          `,
          { orderIds: chunk }
        );
        orders.push(...ordersChunk);
      }

      if (orders.length) {
        const orderSourceIdByOrderId = new Map<string, number>();
        for (const order of orders) {
          orderSourceIdByOrderId.set(order.id, order.source_id_int);
        }

        fillEvents.forEach((event) => {
          if (event.orderId == undefined) {
            return;
          }

          const orderSourceId = orderSourceIdByOrderId.get(event.orderId!);

          // If the source id exists on the order, use it as the default in the fill event
          if (orderSourceId) {
            logger.info(
              "sync-events",
              `Default source '${orderSourceId}' assigned to fill event: ${JSON.stringify(event)}`
            );

            event.orderSourceIdInt = orderSourceId;
            if (!event.aggregatorSourceId && !event.fillSourceId) {
              event.fillSourceId = orderSourceId;
            }
          }
        });
      }
    }
  } catch (error) {
    logger.error("sync-events", `Failed to assign default sources to fill events: ${error}`);
  }
};

const assignWashTradingScoreToFillEvents = async (fillEvents: es.fills.Event[]) => {
  try {
    const inverseFillEvents: { contract: Buffer; maker: Buffer; taker: Buffer }[] = [];

    const fillEventsChunks = _.chunk(fillEvents, 100);

    for (const fillEventsChunk of fillEventsChunks) {
      const inverseFillEventsFilter = fillEventsChunk.map(
        (fillEvent) =>
          `('${_.replace(fillEvent.taker, "0x", "\\x")}', '${_.replace(
            fillEvent.maker,
            "0x",
            "\\x"
          )}', '${_.replace(fillEvent.contract, "0x", "\\x")}')`
      );

      const inverseFillEventsChunkQuery = pgp.as.format(
        `
            SELECT DISTINCT contract, maker, taker from fill_events_2
            WHERE (maker, taker, contract) IN ($/inverseFillEventsFilter:raw/)
          `,
        {
          inverseFillEventsFilter: inverseFillEventsFilter.join(","),
        }
      );

      const inverseFillEventsChunk = await redb.manyOrNone(inverseFillEventsChunkQuery);

      inverseFillEvents.push(...inverseFillEventsChunk);
    }

    fillEvents.forEach((event, index) => {
      const washTradingDetected = inverseFillEvents.some((inverseFillEvent) => {
        return (
          event.maker == fromBuffer(inverseFillEvent.taker) &&
          event.taker == fromBuffer(inverseFillEvent.maker) &&
          event.contract == fromBuffer(inverseFillEvent.contract)
        );
      });

      fillEvents[index].washTradingScore = Number(washTradingDetected);
    });
  } catch (e) {
    logger.error("sync-events", `Failed to assign wash trading score to fill events: ${e}`);
  }
};
