/* eslint-disable @typescript-eslint/no-explicit-any */

import { Interface } from "@ethersproject/abi";
import { Contract } from "@ethersproject/contracts";
import axios from "axios";
import slugify from "slugify";

import { baseProvider } from "@/common/provider";
import { config } from "@/config/index";
import { getNetworkName } from "@/config/network";
import { logger } from "@/common/logger";

export class MetadataApi {
  public static async getCollectionMetadata(
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
      let data: any = {
        slug: slugify(contract, { lower: true }),
        name: "Coming Soon",
        metadata: {
          imageUrl: "",
          discordUrl: "",
          description: "",
          externalUrl: "",
          bannerImageUrl: "",
          twitterUsername: "",
        },
        royalties: [],
      };

      try {
        const res = await axios.get(
          `https://raw.githubusercontent.com/create3labs/nft-metadata/main/metadata/100/${contract.toLowerCase()}/index.json`
        );
        data = res.data;
      } catch (e: any) {
        logger.error("error catching metadata", e);
      }

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
        id: contract.toLowerCase(),
        slug: slugify(data?.name, { lower: true }),
        name: data?.name,
        community: null,
        metadata: {
          imageUrl: data?.metadata?.imageUrl,
          discordUrl: "",
          description: data?.metadata?.description,
          externalUrl: "",
          bannerImageUrl: "",
          twitterUsername: "",
        },
        royalties: data?.royalties ?? [],
        contract: contract,
        tokenIdRange: null,
        tokenSetId: contract,
      };

      if (collection.isFallback && !options?.allowFallback) {
        throw new Error("Fallback collection data not acceptable");
      }

      return collection;
    }
  }

  public static async getTokenMetadata(
    tokens: { contract: string; tokenId: string }[],
    useAltUrl = false
  ) {
    const queryParams = new URLSearchParams();

    for (const token of tokens) {
      queryParams.append("token", `${token.contract}:${token.tokenId}`);
    }

    const url = `${
      useAltUrl ? config.metadataApiBaseUrlAlt : config.metadataApiBaseUrl
    }/v4/${getNetworkName()}/metadata/token?method=${
      config.metadataIndexingMethod
    }&${queryParams.toString()}`;

    const { data } = await axios.get(url);

    const tokenMetadata: {
      contract: string;
      tokenId: string;
      flagged: boolean;
      name?: string;
      description?: string;
      imageUrl?: string;
      mediaUrl?: string;
      attributes: {
        key: string;
        value: string;
        kind: "string" | "number" | "date" | "range";
        rank?: number;
      }[];
    }[] = (data as any).metadata;

    return tokenMetadata;
  }
}

export { MetadataApi as default };
