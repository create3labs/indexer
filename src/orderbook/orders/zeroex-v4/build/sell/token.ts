import * as Sdk from "@0xlol/sdk";
import { BaseBuilder } from "@0xlol/sdk/dist/zeroex-v4/builders/base";

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as utils from "@/orderbook/orders/zeroex-v4/build/utils";

interface BuildOrderOptions extends utils.BaseOrderBuildOptions {
  tokenId: string;
}

export const build = async (options: BuildOrderOptions) => {
  try {
    const collectionResult = await redb.oneOrNone(
      `
        SELECT
          tokens.collection_id
        FROM tokens
        WHERE tokens.contract = $/contract/
          AND tokens.token_id = $/tokenId/
      `,
      {
        contract: toBuffer(options.contract),
        tokenId: options.tokenId,
      }
    );

    if (!collectionResult) {
      // Skip if we cannot retrieve the token's collection
      return undefined;
    }

    const buildInfo = await utils.getBuildInfo(options, collectionResult.collection_id, "sell");
    if (!buildInfo) {
      // Skip if we cannot generate the build information.
      return undefined;
    }

    const builder: BaseBuilder = new Sdk.ZeroExV4.Builders.SingleToken(config.chainId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (buildInfo.params as any).tokenId = options.tokenId;

    return builder?.build(buildInfo.params);
  } catch (error) {
    logger.error("zeroex-v4-build-sell-token-order", `Failed to build order: ${error}`);
    return undefined;
  }
};
