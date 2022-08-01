/* eslint-disable @typescript-eslint/no-explicit-any */

import { Interface } from "@ethersproject/abi";
import { Contract } from "@ethersproject/contracts";
import slugify from "slugify";

import { baseProvider } from "@/common/provider";
import { config } from "@/config/index";

export class MetadataApi {
  static async getCollectionMetadata(
    contract: string,
    tokenId: string,
    options?: { allowFallback?: boolean }
  ) {
    if (config.liquidityOnly) {
      // When running in liquidity-only mode:
      // - assume the collection id matches the contract address
      // - the collection name is retrieved from an on-chain `name()` call

      const name = await new Contract(
        contract,
        new Interface(["function name() view returns (string)"]),
        baseProvider
      )
        .name()
        .catch(() => "");

      return {
        id: contract,
        slug: slugify(name, { lower: true }),
        name,
        community: null,
        metadata: null,
        royalties: null,
        contract,
        tokenIdRange: null,
        tokenSetId: `contract:${contract}`,
      };
    } else {
      const collection: {
        id: string;
        slug: string;
        name: string;
        community: string | null;
        metadata: object | null;
        royalties: object | null;
        contract: string;
        tokenIdRange: [string, string] | null;
        tokenSetId: string;
        isFallback?: boolean;
      } = {
        id: contract,
        slug: slugify("Polychain Monsters", { lower: true }),
        name: "Polychain Monsters",
        community: null,
        metadata: {
          imageUrl: "",
          discordUrl: "https://discord.com/invite/polychainmonsters",
          description:
            "Polychain Monsters are beautifully animated digital collectibles with varying scarcities. Each Polymon is backed by a truly unique NFT and can be unpacked with $PMON tokens.",
          externalUrl: "https://polychainmonsters.com/",
          bannerImageUrl: "",
          twitterUsername: "polychainmon",
        },
        royalties: {
          bps: 0,
          recipient: null,
        },
        contract: "0x85F0e02cb992aa1F9F47112F815F519EF1A59E2D",
        tokenIdRange: null,
        tokenSetId: "0x85F0e02cb992aa1F9F47112F815F519EF1A59E2D",
      };

      if (collection.isFallback && !options?.allowFallback) {
        throw new Error("Fallback collection data not acceptable");
      }

      return collection;
    }
  }
}

export { MetadataApi as default };
