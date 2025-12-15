/**
 * ElizaOS Farcaster Plugin - Local Hub Version
 *
 * A fully self-hosted Farcaster plugin that uses a local Snapchain/Hubble node
 * instead of external APIs like Neynar.
 *
 * Key features:
 * - Direct hub communication via gRPC (writes) and HTTP (reads)
 * - No external API dependencies
 * - Automatic mention detection and response
 * - Channel scanning for relevant content
 * - Rate limiting and daily quotas
 *
 * IMPORTANT TIMESTAMP FIX:
 * Farcaster uses its own epoch (Jan 1, 2021), NOT Unix epoch.
 * Timestamps from the hub are seconds since Farcaster epoch.
 * Use farcasterToUnix() to convert before comparing with Date.now().
 */

import { IAgentRuntime } from "@elizaos/core";
import { DirectHubClient, createHubClient } from "./hub-client";
import {
  HubApiClient,
  createHubApiClient,
  CastWithAuthor,
} from "./hub-api-client";

// ============================================================================
// FARCASTER TIMESTAMP HANDLING
// ============================================================================

/**
 * Farcaster epoch: January 1, 2021 00:00:00 UTC
 *
 * All Farcaster timestamps are seconds since this date, NOT Unix epoch.
 * This is a common source of bugs when calculating cast age.
 */
export const FARCASTER_EPOCH = 1609459200;

/**
 * Convert Farcaster timestamp to Unix timestamp (seconds since 1970)
 *
 * CRITICAL: Always use this when comparing Farcaster timestamps with Date.now()
 * Without this conversion, age calculations will be off by ~51 years!
 */
export function farcasterToUnix(farcasterTimestamp: number): number {
  return farcasterTimestamp + FARCASTER_EPOCH;
}

/**
 * Convert Unix timestamp to Farcaster timestamp
 */
export function unixToFarcaster(unixTimestamp: number): number {
  return unixTimestamp - FARCASTER_EPOCH;
}

// ============================================================================
// LOGGING
// ============================================================================

const logger = {
  info: (...args: unknown[]) =>
    console.log("[LocalHubFarcaster]", ...args),
  error: (...args: unknown[]) =>
    console.error("[LocalHubFarcaster]", ...args),
  warn: (...args: unknown[]) =>
    console.warn("[LocalHubFarcaster]", ...args),
};

// ============================================================================
// CONFIGURATION
// ============================================================================

interface LocalHubConfig {
  hubHttpUrl: string;
  hubGrpcUrl: string;
  hubSsl: boolean;
  fid: number;
  privateKey: string;
  dryRun: boolean;
  enableInteractions: boolean;
  enableDirectPosting: boolean;
  interactionIntervalMin: number;
  interactionIntervalMax: number;
  postIntervalMin: number;
  postIntervalMax: number;
  maxDailyReplies: number;
  maxDailyLikes: number;
  maxDailyPosts: number;
  scanKeywords: string[];
  scanChannels: string[];
  maxCastAge: number; // seconds
  // Runtime state
  repliedToHashes: Set<string>;
  likedHashes: Set<string>;
  dailyReplies: number;
  dailyLikes: number;
  dailyPosts: number;
  lastResetDate: string;
}

// ============================================================================
// MODULE STATE
// ============================================================================

let hubClient: DirectHubClient | null = null;
let hubApiClient: HubApiClient | null = null;
let localConfig: LocalHubConfig | null = null;
let agentRuntime: IAgentRuntime | null = null;
let interactionTimer: NodeJS.Timeout | null = null;
let postTimer: NodeJS.Timeout | null = null;

// ============================================================================
// HELPERS
// ============================================================================

function getSetting(
  runtime: IAgentRuntime,
  key: string,
  defaultVal: string = ""
): string {
  const val = runtime.getSetting(key) || process.env[key] || defaultVal;
  return String(val);
}

function resetDailyCountersIfNeeded(): void {
  const today = new Date().toDateString();
  if (localConfig && localConfig.lastResetDate !== today) {
    localConfig.dailyReplies = 0;
    localConfig.dailyLikes = 0;
    localConfig.dailyPosts = 0;
    localConfig.lastResetDate = today;
    localConfig.repliedToHashes.clear();
    localConfig.likedHashes.clear();
    logger.info("Daily counters reset");
  }
}

/**
 * Evaluate cast relevance based on keywords
 */
function evaluateRelevance(text: string): "high" | "medium" | "low" {
  const lowerText = text.toLowerCase();

  const highKeywords = [
    "ethereum",
    "defi",
    "web3",
    "nft",
    "crypto",
    "blockchain",
    "dapp",
    "smart contract",
  ];
  const mediumKeywords = [
    "airdrop",
    "treasury",
    "proposal",
    "vote",
    "community",
    "decentralized",
    "web3",
  ];

  let highMatches = 0;
  let mediumMatches = 0;

  for (const kw of highKeywords) {
    if (lowerText.includes(kw)) highMatches++;
  }
  for (const kw of mediumKeywords) {
    if (lowerText.includes(kw)) mediumMatches++;
  }

  if (highMatches >= 1) return "high";
  if (mediumMatches >= 2) return "medium";
  return "low";
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeFarcaster(runtime: IAgentRuntime): Promise<void> {
  agentRuntime = runtime;

  const hubHttpUrl = getSetting(
    runtime,
    "FARCASTER_HUB_HTTP_URL",
    "http://localhost:3381"
  );
  const hubGrpcUrl = getSetting(
    runtime,
    "FARCASTER_HUB_URL",
    "localhost:3383"
  );
  const hubSsl =
    getSetting(runtime, "FARCASTER_HUB_SSL", "false") === "true";
  const fid = parseInt(getSetting(runtime, "FARCASTER_FID", "0"));
  const privateKey = getSetting(runtime, "FARCASTER_PRIVATE_KEY", "");
  const dryRun =
    getSetting(runtime, "FARCASTER_DRY_RUN", "false") === "true";

  const enableInteractions =
    getSetting(runtime, "ENABLE_INTERACTIONS", "true") !== "false";
  const enableDirectPosting =
    getSetting(runtime, "ENABLE_DIRECT_POSTING", "false") === "true";

  // Intervals in milliseconds (config is in minutes)
  const interactionIntervalMin =
    parseInt(getSetting(runtime, "INTERACTION_INTERVAL_MIN", "10")) *
    60 *
    1000;
  const interactionIntervalMax =
    parseInt(getSetting(runtime, "INTERACTION_INTERVAL_MAX", "30")) *
    60 *
    1000;
  const postIntervalMin =
    parseInt(getSetting(runtime, "CAST_INTERVAL_MIN", "240")) * 60 * 1000;
  const postIntervalMax =
    parseInt(getSetting(runtime, "CAST_INTERVAL_MAX", "480")) * 60 * 1000;

  // Daily limits
  const maxDailyReplies = parseInt(
    getSetting(runtime, "MAX_DAILY_REPLIES", "15")
  );
  const maxDailyLikes = parseInt(getSetting(runtime, "MAX_DAILY_LIKES", "30"));
  const maxDailyPosts = parseInt(getSetting(runtime, "MAX_DAILY_POSTS", "3"));

  // Max cast age in seconds (default 14 days)
  const maxCastAge = parseInt(
    getSetting(runtime, "MAX_CAST_AGE_DAYS", "14")
  ) * 86400;

  // Keywords and channels to scan
  const scanKeywords = getSetting(
    runtime,
    "SCAN_KEYWORDS",
    "ethereum,defi,web3,nft,crypto,blockchain"
  )
    .split(",")
    .map((k) => k.trim());
  const scanChannels = getSetting(
    runtime,
    "SCAN_CHANNELS",
    "ethereum,base,farcaster,dev"
  )
    .split(",")
    .map((c) => c.trim());

  if (!fid) {
    logger.error("Missing required config: FARCASTER_FID");
    return;
  }

  if (!privateKey) {
    logger.error("Missing required config: FARCASTER_PRIVATE_KEY");
    return;
  }

  localConfig = {
    hubHttpUrl,
    hubGrpcUrl,
    hubSsl,
    fid,
    privateKey,
    dryRun,
    enableInteractions,
    enableDirectPosting,
    interactionIntervalMin,
    interactionIntervalMax,
    postIntervalMin,
    postIntervalMax,
    maxDailyReplies,
    maxDailyLikes,
    maxDailyPosts,
    maxCastAge,
    scanKeywords,
    scanChannels,
    repliedToHashes: new Set(),
    likedHashes: new Set(),
    dailyReplies: 0,
    dailyLikes: 0,
    dailyPosts: 0,
    lastResetDate: new Date().toDateString(),
  };

  logger.info(`Initializing with local hub - FID: ${fid}`);
  logger.info(`Hub HTTP: ${hubHttpUrl}`);
  logger.info(`Hub gRPC: ${hubGrpcUrl}`);
  logger.info(`Keywords: ${scanKeywords.join(", ")}`);
  logger.info(`Channels: ${scanChannels.join(", ")}`);
  logger.info(`Max cast age: ${maxCastAge / 86400} days`);
  logger.info(`Dry run: ${dryRun}`);

  // Initialize clients
  hubApiClient = createHubApiClient(hubHttpUrl);
  hubClient = createHubClient({
    hubUrl: hubGrpcUrl,
    fid,
    privateKey,
    ssl: hubSsl,
  });

  // Test hub connection
  const hubInfo = await hubApiClient.getInfo();
  if (hubInfo) {
    const numMessages =
      (hubInfo.numMessages as number) ||
      ((hubInfo.dbStats as Record<string, unknown>)?.numMessages as number) ||
      "unknown";
    logger.info(`Hub connected - ${numMessages} messages`);
  } else {
    logger.warn("Could not connect to hub - check FARCASTER_HUB_HTTP_URL");
  }

  // Start interaction loop
  if (enableInteractions && !dryRun) {
    startInteractionLoop();
  }

  // Start posting loop
  if (enableDirectPosting && !dryRun) {
    startPostLoop();
  }

  logger.info("Service initialized successfully (NO NEYNAR)");
}

// ============================================================================
// INTERACTION LOOPS
// ============================================================================

function startInteractionLoop(): void {
  if (!localConfig) return;

  const scheduleNext = () => {
    const interval =
      Math.random() *
        (localConfig!.interactionIntervalMax -
          localConfig!.interactionIntervalMin) +
      localConfig!.interactionIntervalMin;
    logger.info(
      `Next interaction scan in ${Math.round(interval / 60000)} minutes`
    );

    interactionTimer = setTimeout(async () => {
      await runInteractionCycle();
      scheduleNext();
    }, interval);
  };

  // Initial scan after 30 seconds
  setTimeout(() => {
    runInteractionCycle();
    scheduleNext();
  }, 30000);
}

function startPostLoop(): void {
  if (!localConfig) return;

  const scheduleNext = () => {
    const interval =
      Math.random() *
        (localConfig!.postIntervalMax - localConfig!.postIntervalMin) +
      localConfig!.postIntervalMin;
    logger.info(
      `Next direct post in ${Math.round(interval / 3600000)} hours`
    );

    postTimer = setTimeout(async () => {
      await generateAndPost();
      scheduleNext();
    }, interval);
  };

  scheduleNext();
}

// ============================================================================
// INTERACTION HANDLERS
// ============================================================================

async function runInteractionCycle(): Promise<void> {
  if (!hubApiClient || !localConfig || !agentRuntime) return;

  resetDailyCountersIfNeeded();

  try {
    logger.info("Starting interaction cycle...");
    await respondToMentions();
    await scanChannelsForCasts();
    logger.info(
      `Cycle complete. Daily stats: ${localConfig.dailyReplies} replies, ${localConfig.dailyLikes} likes`
    );
  } catch (error) {
    logger.error("Error in interaction cycle:", String(error));
  }
}

async function respondToMentions(): Promise<void> {
  if (!hubApiClient || !localConfig || !agentRuntime) return;

  try {
    const mentions = await hubApiClient.getMentions(localConfig.fid, 10);
    logger.info(`Checking ${mentions.length} mentions...`);

    for (const cast of mentions) {
      if (localConfig.repliedToHashes.has(cast.hash)) {
        continue;
      }
      if (localConfig.dailyReplies >= localConfig.maxDailyReplies) break;
      if (cast.fid === localConfig.fid) continue;

      // CRITICAL: Convert Farcaster timestamp to Unix for comparison
      const castAge = Date.now() / 1000 - farcasterToUnix(cast.timestamp);
      if (castAge > localConfig.maxCastAge) {
        logger.info(
          `Skipping old cast (${Math.floor(castAge / 86400)}d): ${cast.hash.slice(0, 10)}`
        );
        continue;
      }

      logger.info(
        `Found mention from @${cast.author.username}: ${cast.text.slice(0, 50)}...`
      );

      await likeCast(cast.fid, cast.hash);
      localConfig.repliedToHashes.add(cast.hash);
      localConfig.dailyReplies++;
    }
  } catch (error) {
    logger.error("Error responding to mentions:", String(error));
  }
}

async function scanChannelsForCasts(): Promise<void> {
  if (!hubApiClient || !localConfig || !agentRuntime) return;

  const channel =
    localConfig.scanChannels[
      Math.floor(Math.random() * localConfig.scanChannels.length)
    ];
  const channelUrl = hubApiClient.getChannelUrl(channel);

  try {
    logger.info(`Scanning channel: ${channel}`);
    const casts = await hubApiClient.getChannelCasts(channelUrl, 10);

    for (const cast of casts) {
      if (localConfig.dailyLikes >= localConfig.maxDailyLikes) break;
      if (cast.fid === localConfig.fid) continue;
      if (localConfig.likedHashes.has(cast.hash)) continue;

      // CRITICAL: Convert Farcaster timestamp to Unix for comparison
      const castAge = Date.now() / 1000 - farcasterToUnix(cast.timestamp);
      if (castAge > localConfig.maxCastAge) continue;

      const relevance = evaluateRelevance(cast.text);

      if (relevance === "high" || relevance === "medium") {
        await likeCast(cast.fid, cast.hash);
        localConfig.likedHashes.add(cast.hash);
        localConfig.dailyLikes++;
      }
    }
  } catch (error) {
    logger.error(`Error scanning channel "${channel}":`, String(error));
  }
}

async function likeCast(targetFid: number, targetHash: string): Promise<void> {
  if (!localConfig || !hubClient) return;

  logger.info(`Liking cast ${targetHash.slice(0, 10)}...`);

  if (localConfig.dryRun) {
    logger.info(`DRY RUN - Would like cast: ${targetHash}`);
    return;
  }

  try {
    await hubClient.likeCast(targetFid, targetHash);
    logger.info("Like added via local hub");
  } catch (error) {
    logger.error("Error liking cast:", String(error));
  }
}

async function generateAndPost(): Promise<void> {
  if (!agentRuntime || !localConfig || !hubClient) return;

  resetDailyCountersIfNeeded();

  if (localConfig.dailyPosts >= localConfig.maxDailyPosts) {
    logger.info("Daily post limit reached");
    return;
  }

  // Direct posting requires AI integration - placeholder
  logger.info("Direct posting requires AI integration");
}

// ============================================================================
// CLEANUP
// ============================================================================

async function stopFarcaster(): Promise<void> {
  if (interactionTimer) {
    clearTimeout(interactionTimer);
    interactionTimer = null;
  }
  if (postTimer) {
    clearTimeout(postTimer);
    postTimer = null;
  }
  logger.info("Service stopped");
}

// ============================================================================
// PLUGIN EXPORT
// ============================================================================

export const localHubFarcasterPlugin = {
  name: "local-hub-farcaster",
  description:
    "Farcaster plugin using local hub only - no Neynar dependency",

  /**
   * Plugin init function - called when plugin is loaded
   */
  init: async (
    _config: Record<string, string>,
    runtime: IAgentRuntime
  ) => {
    logger.info("Plugin init called - initializing Farcaster...");
    if (!runtime) {
      logger.error("Runtime not provided to init function");
      return;
    }
    await initializeFarcaster(runtime);
    logger.info("Plugin init complete");
  },

  /**
   * Provider for querying status
   */
  providers: [
    {
      name: "local-farcaster-provider",
      description: "Provides local hub Farcaster status",
      get: async (_runtime: IAgentRuntime) => {
        return {
          fid: localConfig?.fid,
          hubConnected: !!hubApiClient,
          stats: {
            dailyReplies: localConfig?.dailyReplies || 0,
            dailyLikes: localConfig?.dailyLikes || 0,
            dailyPosts: localConfig?.dailyPosts || 0,
          },
        };
      },
    },
  ],

  actions: [],
  evaluators: [],
  services: [],
};

// Re-export utilities
export { DirectHubClient, createHubClient } from "./hub-client";
export {
  HubApiClient,
  createHubApiClient,
  type HubCast,
  type HubUser,
  type CastWithAuthor,
} from "./hub-api-client";

export default localHubFarcasterPlugin;
