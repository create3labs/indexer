import * as Sdk from "@0xlol/sdk";
import { BaseBuilder } from "@0xlol/sdk/dist/seaport/builders/base";

import { redb } from "@/common/db";
import { fromBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as utils from "@/orderbook/orders/seaport/build/utils";

interface BuildOrderOptions extends utils.BaseOrderBuildOptions {
  collection: string;
}

export const build = async (options: BuildOrderOptions) => {
  const collectionResult = await redb.oneOrNone(
    `
      SELECT
        collections.token_set_id,
        collections.token_count,
        collections.contract
      FROM collections
      WHERE collections.id = $/collection/
    `,
    { collection: options.collection }
  );
  if (!collectionResult) {
    throw new Error("Could not retrieve collection");
  }
  if (Number(collectionResult.token_count) > config.maxItemsPerBid) {
    throw new Error("Collection has too many items");
  }

  const buildInfo = await utils.getBuildInfo(
    {
      ...options,
      contract: fromBuffer(collectionResult.contract),
    },
    options.collection,
    "buy"
  );

  if (!options.excludeFlaggedTokens) {
    // Use contract-wide/token-range order

    if (!collectionResult.token_set_id.startsWith("contract:")) {
      throw new Error("Token range collections are not supported");
    }

    const builder: BaseBuilder = new Sdk.Seaport.Builders.ContractWide(config.chainId);
    return builder?.build(buildInfo.params);
  } else {
    // Use token-list order
    const excludeFlaggedTokens = options.excludeFlaggedTokens ? "AND tokens.is_flagged = 0" : "";

    // Fetch all non-flagged tokens from the collection
    const tokens = await redb.manyOrNone(
      `
        SELECT
          tokens.token_id
        FROM tokens
        WHERE tokens.collection_id = $/collection/
        ${excludeFlaggedTokens}
      `,
      {
        collection: options.collection,
      }
    );

    const builder: BaseBuilder = new Sdk.Seaport.Builders.TokenList(config.chainId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (buildInfo.params as any).tokenIds = tokens.map(({ token_id }) => token_id);

    return builder?.build(buildInfo.params);
  }
};
