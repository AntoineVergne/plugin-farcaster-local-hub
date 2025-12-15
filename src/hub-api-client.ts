/**
 * Hub HTTP API Client
 *
 * Reads data directly from a Farcaster hub's HTTP API.
 * Handles mentions, channel casts, user data, and reactions.
 *
 * IMPORTANT: Uses `reverse=true` parameter to get recent data first.
 * Without this, the hub returns oldest data first which is usually not useful.
 *
 * No external API dependencies - fully self-hosted.
 */

const logger = {
  info: (...args: unknown[]) => console.log("[HubApiClient]", ...args),
  error: (...args: unknown[]) => console.error("[HubApiClient]", ...args),
  warn: (...args: unknown[]) => console.warn("[HubApiClient]", ...args),
};

export interface HubCast {
  hash: string;
  fid: number;
  text: string;
  timestamp: number;
  parentHash: string | null;
  parentFid: number | null;
  parentUrl: string | null;
  mentions: number[];
  mentionsPositions: number[];
  embeds: string[];
}

export interface HubUser {
  fid: number;
  username: string;
  displayName: string;
  pfpUrl: string;
  bio: string;
}

export interface CastWithAuthor extends HubCast {
  author: HubUser;
}

export class HubApiClient {
  private httpUrl: string;
  private userCache: Map<number, HubUser> = new Map();

  constructor(hubHttpUrl: string) {
    this.httpUrl = hubHttpUrl.replace(/\/$/, "");
  }

  /**
   * Get casts that mention a specific FID
   *
   * NOTE: Uses reverse=true to get recent mentions first.
   * The hub's default behavior returns oldest data first.
   */
  async getMentions(fid: number, limit: number = 20): Promise<CastWithAuthor[]> {
    try {
      // CRITICAL: reverse=true gets recent data first
      const url = `${this.httpUrl}/v1/castsByMention?fid=${fid}&pageSize=${limit}&reverse=true`;
      const response = await fetch(url);

      if (!response.ok) {
        logger.error("getMentions failed:", response.status);
        return [];
      }

      const data = await response.json();
      const messages = data.messages || [];

      const casts: CastWithAuthor[] = [];

      for (const msg of messages) {
        if (msg.data?.type !== "MESSAGE_TYPE_CAST_ADD") continue;

        const cast = this.parseCastMessage(msg);
        const author = await this.getUser(cast.fid);

        casts.push({
          ...cast,
          author,
        });
      }

      // Sort by timestamp descending (most recent first)
      casts.sort((a, b) => b.timestamp - a.timestamp);

      return casts.slice(0, limit);
    } catch (error) {
      logger.error("Error getting mentions:", String(error));
      return [];
    }
  }

  /**
   * Get casts from a channel (by parent URL)
   *
   * NOTE: Uses reverse=true to get recent casts first.
   */
  async getChannelCasts(
    channelUrl: string,
    limit: number = 20
  ): Promise<CastWithAuthor[]> {
    try {
      // CRITICAL: reverse=true gets recent data first
      const url = `${this.httpUrl}/v1/castsByParent?url=${encodeURIComponent(channelUrl)}&pageSize=${limit}&reverse=true`;
      const response = await fetch(url);

      if (!response.ok) {
        logger.error("getChannelCasts failed:", response.status);
        return [];
      }

      const data = await response.json();
      const messages = data.messages || [];

      const casts: CastWithAuthor[] = [];

      for (const msg of messages) {
        if (msg.data?.type !== "MESSAGE_TYPE_CAST_ADD") continue;

        const cast = this.parseCastMessage(msg);
        const author = await this.getUser(cast.fid);

        casts.push({
          ...cast,
          author,
        });
      }

      return casts;
    } catch (error) {
      logger.error("Error getting channel casts:", String(error));
      return [];
    }
  }

  /**
   * Get casts by a specific FID
   */
  async getCastsByFid(
    fid: number,
    limit: number = 20
  ): Promise<CastWithAuthor[]> {
    try {
      const url = `${this.httpUrl}/v1/castsByFid?fid=${fid}&pageSize=${limit}&reverse=true`;
      const response = await fetch(url);

      if (!response.ok) {
        logger.error("getCastsByFid failed:", response.status);
        return [];
      }

      const data = await response.json();
      const messages = data.messages || [];

      const author = await this.getUser(fid);
      const casts: CastWithAuthor[] = [];

      for (const msg of messages) {
        if (msg.data?.type !== "MESSAGE_TYPE_CAST_ADD") continue;

        const cast = this.parseCastMessage(msg);
        casts.push({
          ...cast,
          author,
        });
      }

      return casts;
    } catch (error) {
      logger.error("Error getting casts by FID:", String(error));
      return [];
    }
  }

  /**
   * Get a specific cast by hash
   */
  async getCast(fid: number, hash: string): Promise<CastWithAuthor | null> {
    try {
      const hashParam = hash.startsWith("0x") ? hash : `0x${hash}`;
      const url = `${this.httpUrl}/v1/castById?fid=${fid}&hash=${hashParam}`;
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      const msg = await response.json();
      if (msg.data?.type !== "MESSAGE_TYPE_CAST_ADD") return null;

      const cast = this.parseCastMessage(msg);
      const author = await this.getUser(cast.fid);

      return {
        ...cast,
        author,
      };
    } catch (error) {
      logger.error("Error getting cast:", String(error));
      return null;
    }
  }

  /**
   * Get user data by FID
   */
  async getUser(fid: number): Promise<HubUser> {
    // Check cache first
    const cached = this.userCache.get(fid);
    if (cached) return cached;

    const user: HubUser = {
      fid,
      username: `fid:${fid}`,
      displayName: `User ${fid}`,
      pfpUrl: "",
      bio: "",
    };

    try {
      const url = `${this.httpUrl}/v1/userDataByFid?fid=${fid}`;
      const response = await fetch(url);

      if (!response.ok) {
        return user;
      }

      const data = await response.json();
      const messages = data.messages || [];

      for (const msg of messages) {
        const userData = msg.data?.userDataBody;
        if (!userData) continue;

        switch (userData.type) {
          case "USER_DATA_TYPE_USERNAME":
            user.username = userData.value;
            break;
          case "USER_DATA_TYPE_DISPLAY":
            user.displayName = userData.value;
            break;
          case "USER_DATA_TYPE_PFP":
            user.pfpUrl = userData.value;
            break;
          case "USER_DATA_TYPE_BIO":
            user.bio = userData.value;
            break;
        }
      }

      // Cache the user
      this.userCache.set(fid, user);

      return user;
    } catch {
      return user;
    }
  }

  /**
   * Get reactions (likes or recasts) for a cast
   */
  async getReactions(
    targetFid: number,
    targetHash: string,
    type: "likes" | "recasts" = "likes"
  ): Promise<number[]> {
    try {
      const reactionType = type === "likes" ? 1 : 2;
      const hashParam = targetHash.startsWith("0x")
        ? targetHash
        : `0x${targetHash}`;
      const url = `${this.httpUrl}/v1/reactionsByCast?targetFid=${targetFid}&targetHash=${hashParam}&reactionType=${reactionType}`;
      const response = await fetch(url);

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const messages = data.messages || [];

      return messages
        .map((msg: Record<string, unknown>) => {
          const msgData = msg.data as Record<string, unknown> | undefined;
          return msgData?.fid;
        })
        .filter(Boolean);
    } catch (error) {
      logger.error("Error getting reactions:", String(error));
      return [];
    }
  }

  /**
   * Check hub health and get info
   */
  async getInfo(): Promise<Record<string, unknown> | null> {
    try {
      const url = `${this.httpUrl}/v1/info`;
      const response = await fetch(url);

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      logger.error("Error getting hub info:", String(error));
      return null;
    }
  }

  /**
   * Parse a hub message into our cast format
   *
   * Note: Timestamps returned are Farcaster timestamps (seconds since Jan 1, 2021),
   * NOT Unix timestamps. Use farcasterToUnix() to convert.
   */
  private parseCastMessage(msg: Record<string, unknown>): HubCast {
    const msgData = msg.data as Record<string, unknown> | undefined;
    const castData =
      (msgData?.castAddBody as Record<string, unknown>) || {};
    const parentCastId = castData.parentCastId as
      | Record<string, unknown>
      | undefined;
    const embeds = (castData.embeds as Array<Record<string, unknown>>) || [];

    return {
      hash: msg.hash as string,
      fid: (msgData?.fid as number) || 0,
      text: (castData.text as string) || "",
      timestamp: (msgData?.timestamp as number) || 0,
      parentHash: (parentCastId?.hash as string) || null,
      parentFid: (parentCastId?.fid as number) || null,
      parentUrl: (castData.parentUrl as string) || null,
      mentions: (castData.mentions as number[]) || [],
      mentionsPositions: (castData.mentionsPositions as number[]) || [],
      embeds: embeds
        .map((e) => e.url as string)
        .filter(Boolean),
    };
  }

  /**
   * Convert channel name to Farcaster channel URL
   */
  getChannelUrl(channel: string): string {
    const channelUrls: Record<string, string> = {
      governance: "https://warpcast.com/~/channel/governance",
      daos: "https://warpcast.com/~/channel/daos",
      ethereum: "https://warpcast.com/~/channel/ethereum",
      farcaster: "https://warpcast.com/~/channel/farcaster",
      optimism: "https://warpcast.com/~/channel/optimism",
      base: "https://warpcast.com/~/channel/base",
      arbitrum: "https://warpcast.com/~/channel/arbitrum",
      defi: "https://warpcast.com/~/channel/defi",
      politics: "https://warpcast.com/~/channel/politics",
      dev: "https://warpcast.com/~/channel/dev",
    };

    return (
      channelUrls[channel.toLowerCase()] ||
      `https://warpcast.com/~/channel/${channel}`
    );
  }

  /**
   * Clear user cache
   */
  clearCache(): void {
    this.userCache.clear();
  }
}

export function createHubApiClient(hubHttpUrl: string): HubApiClient {
  return new HubApiClient(hubHttpUrl);
}
