/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@0xlol/sdk";
import { TxData } from "@0xlol/sdk/dist/utils";
import Joi from "joi";
import _ from "lodash";

import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { regex } from "@/common/utils";
import { config } from "@/config/index";
import * as commonHelpers from "@/orderbook/orders/common/helpers";

// LooksRare
import * as looksRareSellToken from "@/orderbook/orders/looks-rare/build/sell/token";
import * as looksRareCheck from "@/orderbook/orders/looks-rare/check";

// OpenDao
import * as openDaoSellToken from "@/orderbook/orders/opendao/build/sell/token";
import * as openDaoCheck from "@/orderbook/orders/opendao/check";

// Seaport
import * as seaportSellToken from "@/orderbook/orders/seaport/build/sell/token";
import * as seaportCheck from "@/orderbook/orders/seaport/check";

// X2Y2
import * as x2y2SellToken from "@/orderbook/orders/x2y2/build/sell/token";
import * as x2y2Check from "@/orderbook/orders/x2y2/check";

// ZeroExV4
import * as zeroExV4SellToken from "@/orderbook/orders/zeroex-v4/build/sell/token";
import * as zeroExV4Check from "@/orderbook/orders/zeroex-v4/check";

const version = "v4";

export const getExecuteListV4Options: RouteOptions = {
  description: "Create ask (listing)",
  notes: "Generate a listing and submit it to multiple marketplaces",
  tags: ["api", "Orderbook"],
  plugins: {
    "hapi-swagger": {
      order: 11,
    },
  },
  validate: {
    payload: Joi.object({
      maker: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .required()
        .description(
          "Address of wallet making the order. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
      source: Joi.string()
        .lowercase()
        .pattern(regex.domain)
        .required()
        .description("Domain of the platform that created the order. Example: `chimpers.xyz`"),
      params: Joi.array().items(
        Joi.object({
          token: Joi.string()
            .lowercase()
            .pattern(regex.token)
            .required()
            .description(
              "Filter to a particular token. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
            ),
          quantity: Joi.number().description(
            "Quanity of tokens user is listing. Only compatible with ERC1155 tokens. Example: `5`"
          ),
          weiPrice: Joi.string()
            .pattern(regex.number)
            .required()
            .description(
              "Amount seller is willing to sell for in wei. Example: `1000000000000000000`"
            ),
          orderKind: Joi.string()
            .valid("721ex", "looks-rare", "zeroex-v4", "seaport", "x2y2")
            .default("seaport")
            .description("Exchange protocol used to create order. Example: `seaport`"),
          orderbook: Joi.string()
            .valid("opensea", "looks-rare", "reservoir", "x2y2")
            .default("reservoir")
            .description("Orderbook where order is placed. Example: `Reservoir`"),
          automatedRoyalties: Joi.boolean()
            .default(true)
            .description("If true, royalties will be automatically included."),
          fees: Joi.array()
            .items(Joi.string().pattern(regex.fee))
            .description(
              "List of fees (formatted as `feeRecipient:feeBps`) to be bundled within the order. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00:100`"
            ),
          listingTime: Joi.string()
            .pattern(regex.unixTimestamp)
            .description(
              "Unix timestamp (seconds) indicating when listing will be listed. Example: `1656080318`"
            ),
          expirationTime: Joi.string()
            .pattern(regex.unixTimestamp)
            .description(
              "Unix timestamp (seconds) indicating when listing will expire. Example: `1656080318`"
            ),
          salt: Joi.string()
            .pattern(regex.number)
            .description("Optional. Random string to make the order unique"),
          nonce: Joi.string().pattern(regex.number).description("Optional. Set a custom nonce"),
          currency: Joi.string()
            .pattern(regex.address)
            .default(Sdk.Common.Addresses.Eth[config.chainId]),
        })
      ),
    }),
  },
  response: {
    schema: Joi.object({
      steps: Joi.array().items(
        Joi.object({
          kind: Joi.string().valid("request", "signature", "transaction").required(),
          action: Joi.string().required(),
          description: Joi.string().required(),
          items: Joi.array()
            .items(
              Joi.object({
                status: Joi.string().valid("complete", "incomplete").required(),
                data: Joi.object(),
                orderIndex: Joi.number(),
              })
            )
            .required(),
        })
      ),
    }).label(`getExecuteList${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-execute-list-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;

    try {
      const maker = payload.maker;
      const source = payload.source;

      // Set up generic listing steps
      const steps: {
        action: string;
        description: string;
        kind: string;
        items: {
          status: string;
          data?: any;
          orderIndex?: number;
        }[];
      }[] = [
        {
          action: "Initialize wallet",
          description:
            "A one-time setup transaction to enable trading with the Wyvern Protocol (used by Open Sea)",
          kind: "transaction",
          items: [],
        },
        {
          action: "Approve NFT contract",
          description:
            "Each NFT collection you want to trade requires a one-time approval transaction",
          kind: "transaction",
          items: [],
        },
        {
          action: "Authorize listing",
          description: "A free off-chain signature to create the listing",
          kind: "signature",
          items: [],
        },
      ];

      for (let i = 0; i < payload.params.length; i++) {
        const params = payload.params[i];
        const [contract, tokenId] = params.token.split(":");

        // On Rinkeby, proxy ZeroEx V4 to 721ex
        if (params.orderKind === "zeroex-v4" && config.chainId === 4) {
          params.orderKind = "721ex";
        }

        // For now, ERC20 listings are only supported on Seaport
        if (
          params.orderKind !== "seaport" &&
          params.currency !== Sdk.Common.Addresses.Eth[config.chainId]
        ) {
          throw new Error("ERC20 listings are only supported on Seaport");
        }

        // Handle fees
        // TODO: Refactor the builders to get rid of the separate fee/feeRecipient arrays
        // TODO: Refactor the builders to get rid of the API params naming dependency
        params.fee = [];
        params.feeRecipient = [];
        for (const feeData of params.fees ?? []) {
          const [feeRecipient, fee] = feeData.split(":");
          params.fee.push(fee);
          params.feeRecipient.push(feeRecipient);
        }

        switch (params.orderKind) {
          case "721ex": {
            if (!["reservoir"].includes(params.orderbook)) {
              throw Boom.badRequest("Only `reservoir` is supported as orderbook");
            }

            const order = await openDaoSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await openDaoCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction
                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(baseProvider, order.params.nft)
                      : new Sdk.Common.Helpers.Erc1155(baseProvider, order.params.nft)
                  ).approveTransaction(maker, Sdk.OpenDao.Addresses.Exchange[config.chainId]);

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v3",
                  method: "POST",
                  body: {
                    order: {
                      kind: "721ex",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "zeroex-v4": {
            if (!["reservoir"].includes(params.orderbook)) {
              throw Boom.badRequest("Only `reservoir` is supported as orderbook");
            }

            const order = await zeroExV4SellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability.
            try {
              await zeroExV4Check.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction
                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(baseProvider, order.params.nft)
                      : new Sdk.Common.Helpers.Erc1155(baseProvider, order.params.nft)
                  ).approveTransaction(maker, Sdk.ZeroExV4.Addresses.Exchange[config.chainId]);

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v3",
                  method: "POST",
                  body: {
                    order: {
                      kind: "zeroex-v4",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "seaport": {
            if (!["reservoir", "opensea"].includes(params.orderbook)) {
              throw Boom.badRequest("Only `reservoir` and `opensea` are supported as orderbooks");
            }

            const order = await seaportSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await seaportCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction

                  const exchange = new Sdk.Seaport.Exchange(config.chainId);
                  const info = order.getInfo()!;

                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(baseProvider, info.contract)
                      : new Sdk.Common.Helpers.Erc1155(baseProvider, info.contract)
                  ).approveTransaction(maker, exchange.deriveConduit(order.params.conduitKey));

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v3",
                  method: "POST",
                  body: {
                    order: {
                      kind: "seaport",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "looks-rare": {
            if (!["reservoir", "looks-rare"].includes(params.orderbook)) {
              throw Boom.badRequest(
                "Only `reservoir` and `looks-rare` are supported as orderbooks"
              );
            }
            if (params.fees?.length) {
              throw Boom.badRequest("LooksRare does not supported custom fees");
            }

            const order = await looksRareSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await looksRareCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  const contractKind = await commonHelpers.getContractKind(contract);
                  if (!contractKind) {
                    throw Boom.internal("Missing contract kind");
                  }

                  // Generate an approval transaction
                  approvalTx = (
                    contractKind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(baseProvider, order.params.collection)
                      : new Sdk.Common.Helpers.Erc1155(baseProvider, order.params.collection)
                  ).approveTransaction(
                    maker,
                    contractKind === "erc721"
                      ? Sdk.LooksRare.Addresses.TransferManagerErc721[config.chainId]
                      : Sdk.LooksRare.Addresses.TransferManagerErc1155[config.chainId]
                  );

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v3",
                  method: "POST",
                  body: {
                    order: {
                      kind: "looks-rare",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "x2y2": {
            if (!["x2y2"].includes(params.orderbook)) {
              throw Boom.badRequest("Only `x2y2` is supported as orderbook");
            }
            if (params.fees?.length) {
              throw Boom.badRequest("X2Y2 does not supported custom fees");
            }

            const order = await x2y2SellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            const upstreamOrder = Sdk.X2Y2.Order.fromLocalOrder(config.chainId, order);
            try {
              await x2y2Check.offChainCheck(upstreamOrder, {
                onChainApprovalRecheck: true,
              });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  const contractKind = await commonHelpers.getContractKind(contract);
                  if (!contractKind) {
                    throw Boom.internal("Missing contract kind");
                  }

                  // Generate an approval transaction
                  approvalTx = new Sdk.Common.Helpers.Erc721(
                    baseProvider,
                    upstreamOrder.params.nft.token
                  ).approveTransaction(maker, Sdk.X2Y2.Addresses.Erc721Delegate[config.chainId]);

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: new Sdk.X2Y2.Exchange(
                  config.chainId,
                  config.x2y2ApiKey
                ).getOrderSignatureData(order),
                post: {
                  endpoint: "/order/v3",
                  method: "POST",
                  body: {
                    order: {
                      kind: "x2y2",
                      data: {
                        ...order,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });
          }
        }
      }

      // De-duplicate step items
      for (const step of steps) {
        // Assume `JSON.stringify` is deterministic
        const uniqueItems = _.uniqBy(step.items, ({ data }) => JSON.stringify(data));
        if (step.items.length > uniqueItems.length) {
          step.items = uniqueItems.map((item) => ({
            status: item.status,
            data: item.data,
            orderIndex: item.orderIndex,
          }));
        }
      }

      return { steps };
    } catch (error) {
      logger.error(`get-execute-list-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
