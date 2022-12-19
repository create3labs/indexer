import { Interface } from "@ethersproject/abi";

import { EventData } from "@/events-sync/data";

export const redeemed: EventData = {
  kind: "nftx-redeemed",
  topic: "0x63b13f6307f284441e029836b0c22eb91eb62a7ad555670061157930ce884f4e",
  numTopics: 1,
  abi: new Interface([
    `event Redeemed(
      uint256[] nftIds,
      uint256[] specificIds,
      address to
    )`,
  ]),
};

export const minted: EventData = {
  kind: "nftx-minted",
  topic: "0x1f72ad2a14447fa756b6f5aca53504645af79813493aca2d906b69e4aaeb9492",
  numTopics: 1,
  abi: new Interface([
    `event Minted(
      uint256[] nftIds,
      uint256[] amounts,
      address to
    )`,
  ]),
};
