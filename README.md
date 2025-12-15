# @elizaos/plugin-farcaster-local-hub

A fully self-hosted Farcaster plugin for ElizaOS that communicates directly with a local Snapchain/Hubble node. **No Neynar or external API dependencies.**

## Why This Plugin?

The official `@elizaos/plugin-farcaster` requires a Neynar API key, which:
- Costs money at scale
- Adds external dependency and latency
- Centralizes what should be a decentralized protocol
- Creates a single point of failure

This plugin connects directly to your local Farcaster hub, giving you:
- **Full sovereignty** - No external API calls
- **Zero API costs** - Run your own infrastructure
- **Lower latency** - Direct hub communication
- **True decentralization** - How Farcaster was meant to work

## Key Fixes Included

This plugin includes critical fixes that may affect other Farcaster implementations:

### 1. Farcaster Timestamp Epoch

**Problem:** Farcaster uses its own epoch (Jan 1, 2021), not Unix epoch. Code that compares `Date.now()` with hub timestamps without conversion will calculate ages ~51 years wrong, causing all casts to be filtered out.

**Fix:** Always convert Farcaster timestamps before comparison:

```typescript
// Farcaster epoch: January 1, 2021 00:00:00 UTC
const FARCASTER_EPOCH = 1609459200;

function farcasterToUnix(farcasterTimestamp: number): number {
  return farcasterTimestamp + FARCASTER_EPOCH;
}

// Usage
const castAge = Date.now() / 1000 - farcasterToUnix(cast.timestamp);
```

### 2. Hub API Returns Old Data First

**Problem:** The hub's HTTP API returns oldest data first by default, which is usually not useful for finding recent mentions or channel activity.

**Fix:** Add `reverse=true` to API calls:

```typescript
// Get recent mentions first
const url = `${hubUrl}/v1/castsByMention?fid=${fid}&pageSize=${limit}&reverse=true`;

// Get recent channel casts first
const url = `${hubUrl}/v1/castsByParent?url=${channelUrl}&pageSize=${limit}&reverse=true`;
```

## Installation

```bash
npm install @elizaos/plugin-farcaster-local-hub
# or
pnpm add @elizaos/plugin-farcaster-local-hub
```

## Prerequisites

You need a running Farcaster hub. Options:

1. **Snapchain** (recommended for full nodes):
   ```bash
   docker run -d -p 3381:3381 -p 3383:3383 farcasterxyz/snapchain:latest
   ```

2. **Hubble** (lighter alternative):
   ```bash
   docker run -d -p 2281:2281 -p 2283:2283 farcasterxyz/hubble:latest
   ```

## Configuration

Set these environment variables:

```bash
# Required
FARCASTER_FID=123456                           # Your Farcaster ID
FARCASTER_PRIVATE_KEY=0x...                    # Ed25519 signer key

# Hub connection
FARCASTER_HUB_HTTP_URL=http://localhost:3381   # HTTP API for reads
FARCASTER_HUB_URL=localhost:3383               # gRPC for writes
FARCASTER_HUB_SSL=false                        # SSL for gRPC

# Behavior
FARCASTER_DRY_RUN=false                        # Test mode
ENABLE_INTERACTIONS=true                        # Auto-respond to mentions
ENABLE_DIRECT_POSTING=false                     # Requires AI integration

# Rate limits
MAX_DAILY_REPLIES=15
MAX_DAILY_LIKES=30
MAX_CAST_AGE_DAYS=14

# Content scanning
SCAN_KEYWORDS=ethereum,defi,web3
SCAN_CHANNELS=ethereum,base,farcaster
```

See `.env.example` for full configuration options.

## Usage with ElizaOS

```typescript
import { localHubFarcasterPlugin } from "@elizaos/plugin-farcaster-local-hub";

const agent = new Agent({
  plugins: [localHubFarcasterPlugin],
  // ... other config
});
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ElizaOS Agent                          │
├─────────────────────────────────────────────────────────────┤
│  plugin-farcaster-local-hub                                 │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  hub-client.ts  │  │ hub-api-client  │                  │
│  │     (gRPC)      │  │     (HTTP)      │                  │
│  │    - casts      │  │   - mentions    │                  │
│  │    - likes      │  │   - channels    │                  │
│  │    - recasts    │  │   - user data   │                  │
│  └────────┬────────┘  └────────┬────────┘                  │
└───────────┼────────────────────┼────────────────────────────┘
            │                    │
            │    Port 3383       │    Port 3381
            │    (gRPC)          │    (HTTP)
            ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│              Local Farcaster Hub (Snapchain/Hubble)         │
│                    - Full protocol node                     │
│                    - Syncs with network                     │
│                    - Stores all messages                    │
└─────────────────────────────────────────────────────────────┘
```

## API Reference

### Exported Functions

```typescript
// Timestamp conversion utilities
export function farcasterToUnix(farcasterTimestamp: number): number;
export function unixToFarcaster(unixTimestamp: number): number;
export const FARCASTER_EPOCH: number; // 1609459200

// Client factories
export function createHubClient(config: HubClientConfig): DirectHubClient;
export function createHubApiClient(hubHttpUrl: string): HubApiClient;
```

### DirectHubClient (gRPC - Write Operations)

```typescript
const client = createHubClient({
  hubUrl: "localhost:3383",
  fid: 123456,
  privateKey: "0x...",
});

// Publish a cast
await client.publishCast({ text: "Hello Farcaster!" });

// Reply to a cast
await client.publishReply("Great point!", parentFid, parentHash);

// Like a cast
await client.likeCast(targetFid, targetHash);

// Recast
await client.recastCast(targetFid, targetHash);
```

### HubApiClient (HTTP - Read Operations)

```typescript
const apiClient = createHubApiClient("http://localhost:3381");

// Get mentions of your FID (recent first)
const mentions = await apiClient.getMentions(myFid, 20);

// Get channel casts (recent first)
const casts = await apiClient.getChannelCasts(channelUrl, 20);

// Get user info
const user = await apiClient.getUser(fid);

// Check hub health
const info = await apiClient.getInfo();
```

## Getting a Signer Key

To post on Farcaster, you need an Ed25519 signer key registered to your FID:

1. Go to [Warpcast Developer Portal](https://warpcast.com/~/developers/signer-requests)
2. Create a new signer request
3. Approve it in your Warpcast app
4. Copy the private key to `FARCASTER_PRIVATE_KEY`

## Running Your Own Hub

### Snapchain (Full Node)

```yaml
# docker-compose.yml
version: "3.8"
services:
  snapchain:
    image: farcasterxyz/snapchain:latest
    ports:
      - "3381:3381"  # HTTP API
      - "3383:3383"  # gRPC
    volumes:
      - snapchain_data:/data
    environment:
      - NETWORK=mainnet

volumes:
  snapchain_data:
```

### Hubble (Lighter)

```yaml
version: "3.8"
services:
  hubble:
    image: farcasterxyz/hubble:latest
    ports:
      - "2281:2281"  # HTTP API
      - "2283:2283"  # gRPC
    volumes:
      - hubble_data:/data
    command: start --network 1 --eth-mainnet-rpc-url ${ETH_RPC_URL}

volumes:
  hubble_data:
```

## Contributing

PRs welcome! Key areas:

- [ ] Add full reply generation with AI integration
- [ ] Implement cast search/indexing
- [ ] Add follower graph analysis
- [ ] Support for embeds (images, links)
- [ ] WebSocket subscriptions for real-time mentions

## License

MIT

## Credits

- [Farcaster Protocol](https://github.com/farcasterxyz/protocol)
- [@farcaster/hub-nodejs](https://github.com/farcasterxyz/hub-monorepo)
- [ElizaOS](https://github.com/elizaos/eliza)
