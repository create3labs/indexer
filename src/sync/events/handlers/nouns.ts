import * as Sdk from "@0xlol/sdk";

import { config } from "@/config/index";
import { getEventData } from "@/events-sync/data";
import { EnhancedEvent, OnChainData } from "@/events-sync/handlers/utils";
import * as es from "@/events-sync/storage";
import * as utils from "@/events-sync/utils";
import { getUSDAndNativePrices } from "@/utils/prices";

import * as fillUpdates from "@/jobs/fill-updates/queue";

export const handleEvents = async (events: EnhancedEvent[]): Promise<OnChainData> => {
  const fillEvents: es.fills.Event[] = [];

  const fillInfos: fillUpdates.FillInfo[] = [];

  // Handle the events
  for (const { kind, baseEventParams, log } of events) {
    const eventData = getEventData([kind])[0];
    switch (kind) {
      case "nouns-auction-settled": {
        const { args } = eventData.abi.parseLog(log);
        const tokenId = args["nounId"].toString();
        const winner = args["winner"].toLowerCase();
        const amount = args["amount"].toString();

        // Handle: attribution

        const orderKind = "nouns";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind
        );

        // Handle: prices

        const currency = Sdk.Common.Addresses.Eth[config.chainId];
        const priceData = await getUSDAndNativePrices(currency, amount, baseEventParams.timestamp);
        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        const maker = Sdk.Nouns.Addresses.AuctionHouse[config.chainId]?.toLowerCase();
        const contract = Sdk.Nouns.Addresses.TokenContract[config.chainId]?.toLowerCase();
        if (maker && contract) {
          fillEvents.push({
            orderKind,
            orderSide: "sell",
            maker,
            taker: winner,
            amount: "1",
            currency,
            price: priceData.nativePrice,
            currencyPrice: amount,
            usdPrice: priceData.usdPrice,
            contract,
            tokenId,
            // Mints have matching order and fill sources but no aggregator source
            orderSourceId: attributionData.orderSource?.id,
            fillSourceId: attributionData.orderSource?.id,
            isPrimary: true,
            baseEventParams,
          });

          fillInfos.push({
            context: `nouns-${tokenId}-${baseEventParams.txHash}`,
            orderSide: "sell",
            contract: Sdk.Nouns.Addresses.TokenContract[config.chainId]?.toLowerCase(),
            tokenId,
            amount: "1",
            price: priceData.nativePrice,
            timestamp: baseEventParams.timestamp,
          });
        }

        break;
      }
    }
  }

  return {
    fillEvents,

    fillInfos,
  };
};
