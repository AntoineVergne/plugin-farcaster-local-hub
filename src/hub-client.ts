/**
 * Direct Farcaster Hub gRPC Client
 *
 * Handles write operations to a local Farcaster hub (Snapchain/Hubble):
 * - Publishing casts
 * - Adding reactions (likes, recasts)
 * - Replying to casts
 *
 * Uses @farcaster/hub-nodejs for gRPC communication.
 * No external API dependencies - fully self-hosted.
 */

import {
  getSSLHubRpcClient,
  getInsecureHubRpcClient,
  makeCastAdd,
  makeReactionAdd,
  NobleEd25519Signer,
  FarcasterNetwork,
  CastAddBody,
  Message,
  ReactionType,
} from "@farcaster/hub-nodejs";
import { hexToBytes } from "@noble/hashes/utils";

export interface HubClientConfig {
  hubUrl: string;
  fid: number;
  privateKey: string;
  network?: FarcasterNetwork;
  ssl?: boolean;
}

export interface CastOptions {
  text: string;
  parentCastId?: {
    fid: number;
    hash: Uint8Array;
  };
  parentUrl?: string;
  embeds?: Array<{ url: string }>;
  embedsCastIds?: Array<{ fid: number; hash: Uint8Array }>;
  mentions?: number[];
  mentionsPositions?: number[];
}

export interface ReactionOptions {
  targetFid: number;
  targetHash: Uint8Array;
  type: "like" | "recast";
}

/**
 * Direct Hub Client for Farcaster operations
 *
 * Communicates directly with a Farcaster hub via gRPC.
 * Requires a valid FID and corresponding Ed25519 signer private key.
 */
export class DirectHubClient {
  private hubUrl: string;
  private fid: number;
  private signer: NobleEd25519Signer;
  private network: FarcasterNetwork;
  private ssl: boolean;

  constructor(config: HubClientConfig) {
    this.hubUrl = config.hubUrl;
    this.fid = config.fid;
    this.network = config.network ?? FarcasterNetwork.MAINNET;
    this.ssl = config.ssl ?? config.hubUrl.startsWith("https");

    const keyHex = config.privateKey.startsWith("0x")
      ? config.privateKey.slice(2)
      : config.privateKey;
    const keyBytes = hexToBytes(keyHex);

    this.signer = new NobleEd25519Signer(keyBytes);
  }

  private getClient() {
    const url = new URL(
      this.hubUrl.includes("://") ? this.hubUrl : `https://${this.hubUrl}`
    );
    const host = url.hostname;
    const port = parseInt(url.port) || 2283;
    const address = `${host}:${port}`;

    if (this.ssl) {
      return getSSLHubRpcClient(address);
    } else {
      return getInsecureHubRpcClient(address);
    }
  }

  /**
   * Publish a new cast to the Farcaster network
   */
  async publishCast(options: CastOptions): Promise<Message> {
    const client = this.getClient();

    try {
      const castBody: CastAddBody = {
        text: options.text,
        embeds: options.embeds ?? [],
        embedsDeprecated: [],
        mentions: options.mentions ?? [],
        mentionsPositions: options.mentionsPositions ?? [],
        type: 0,
      };

      if (options.parentCastId) {
        castBody.parentCastId = options.parentCastId;
      } else if (options.parentUrl) {
        castBody.parentUrl = options.parentUrl;
      }

      const castResult = await makeCastAdd(
        castBody,
        { fid: this.fid, network: this.network },
        this.signer
      );

      if (castResult.isErr()) {
        throw new Error(`Failed to create cast: ${castResult.error.message}`);
      }

      const submitResult = await client.submitMessage(castResult.value);

      if (submitResult.isErr()) {
        throw new Error(`Failed to submit cast: ${submitResult.error.message}`);
      }

      return submitResult.value;
    } finally {
      client.close();
    }
  }

  /**
   * Reply to an existing cast
   */
  async publishReply(
    text: string,
    parentFid: number,
    parentHash: string
  ): Promise<Message> {
    const hashBytes = hexToBytes(
      parentHash.startsWith("0x") ? parentHash.slice(2) : parentHash
    );

    return this.publishCast({
      text,
      parentCastId: {
        fid: parentFid,
        hash: hashBytes,
      },
    });
  }

  /**
   * Add a reaction (like or recast) to a cast
   */
  async publishReaction(options: ReactionOptions): Promise<Message> {
    const client = this.getClient();

    try {
      const reactionType =
        options.type === "like" ? ReactionType.LIKE : ReactionType.RECAST;

      const reactionResult = await makeReactionAdd(
        {
          type: reactionType,
          targetCastId: {
            fid: options.targetFid,
            hash: options.targetHash,
          },
        },
        { fid: this.fid, network: this.network },
        this.signer
      );

      if (reactionResult.isErr()) {
        throw new Error(
          `Failed to create reaction: ${reactionResult.error.message}`
        );
      }

      const submitResult = await client.submitMessage(reactionResult.value);

      if (submitResult.isErr()) {
        throw new Error(
          `Failed to submit reaction: ${submitResult.error.message}`
        );
      }

      return submitResult.value;
    } finally {
      client.close();
    }
  }

  /**
   * Like a cast
   */
  async likeCast(targetFid: number, targetHash: string): Promise<Message> {
    const hashBytes = hexToBytes(
      targetHash.startsWith("0x") ? targetHash.slice(2) : targetHash
    );
    return this.publishReaction({
      targetFid,
      targetHash: hashBytes,
      type: "like",
    });
  }

  /**
   * Recast a cast
   */
  async recastCast(targetFid: number, targetHash: string): Promise<Message> {
    const hashBytes = hexToBytes(
      targetHash.startsWith("0x") ? targetHash.slice(2) : targetHash
    );
    return this.publishReaction({
      targetFid,
      targetHash: hashBytes,
      type: "recast",
    });
  }

  /**
   * Get casts by a specific FID
   */
  async getCastsByFid(fid: number, pageSize: number = 25): Promise<Message[]> {
    const client = this.getClient();

    try {
      const result = await client.getCastsByFid({ fid, pageSize });

      if (result.isErr()) {
        throw new Error(`Failed to get casts: ${result.error.message}`);
      }

      return result.value.messages;
    } finally {
      client.close();
    }
  }

  /**
   * Get user data by FID
   */
  async getUserData(fid: number): Promise<Message[]> {
    const client = this.getClient();

    try {
      const result = await client.getUserDataByFid({ fid });

      if (result.isErr()) {
        throw new Error(`Failed to get user data: ${result.error.message}`);
      }

      return result.value.messages;
    } finally {
      client.close();
    }
  }

  /**
   * Get hub information and stats
   */
  async getHubInfo(): Promise<unknown> {
    const client = this.getClient();

    try {
      const result = await client.getInfo({ dbStats: true });

      if (result.isErr()) {
        throw new Error(`Failed to get hub info: ${result.error.message}`);
      }

      return result.value;
    } finally {
      client.close();
    }
  }
}

export function createHubClient(config: HubClientConfig): DirectHubClient {
  return new DirectHubClient(config);
}
