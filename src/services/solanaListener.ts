import { 
  PublicKey, 
  Connection, 
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  ParsedInstruction
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  TokenInstruction
} from '@solana/spl-token';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot';
import { fetchTokenMetadata } from './tokenMetadataService';
import { getUserSettings } from './userSettingsService';
import Bottleneck from 'bottleneck';

// Import your caching library here
// Example using node-cache
import NodeCache from 'node-cache';
const cached = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes

// Configuration
const HELIUS_API_KEY = '04beb6c3-21a5-4a66-9b3f-3547bceca91d';
const HELIUS_HTTP_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Initialize connection with optimized configuration
const connection = new Connection(HELIUS_HTTP_URL, {
  commitment: 'confirmed',
  wsEndpoint: HELIUS_WSS_URL,
  disableRetryOnRateLimit: false, // Enable built-in rate limit handling
  confirmTransactionInitialTimeout: 60000 // Increase timeout
});

// Track active users and their configurations
interface UserConfig {
  startSlot: number;
  filters: string[];
}

const activeUsers = new Map<number, UserConfig>();
const processedSignatures = new Set<string>();
let websocketSubscriptionId: number | null = null;

// Enhanced rate limiting configuration
const MAX_RETRIES = 5; // Increased retries for better resilience
const BASE_DELAY = 1000; // Base delay in ms
const JITTER = 500; // Jitter range in ms

// Separate Bottleneck instances for different types of requests
const limiterTransaction = new Bottleneck({
  maxConcurrent: 5,                    // Limit concurrent transactions
  minTime: 250,                        // 4 requests per second
  reservoir: 200,                      // Total requests
  reservoirRefreshInterval: 60000,     // Refresh every minute
  reservoirRefreshAmount: 200,         // Refill 200 requests
  strategy: Bottleneck.strategy.BLOCK   // Queue requests when rate limit is reached
});

const limiterMetadata = new Bottleneck({
  maxConcurrent: 3,                    // Limit concurrent metadata fetches
  minTime: 500,                        // 2 requests per second
  reservoir: 100,                      // Total requests
  reservoirRefreshInterval: 60000,     // Refresh every minute
  reservoirRefreshAmount: 100,         // Refill 100 requests
  strategy: Bottleneck.strategy.BLOCK   // Queue requests when rate limit is reached
});

// Add cluster-wide event listeners for better monitoring
const setupLimiterListeners = (limiter: Bottleneck, name: string) => {
  limiter.on('error', (error) => {
    logger.error(`[Limiter ${name}] Error:`, error);
  });

  limiter.on('failed', (error, jobInfo) => {
    logger.warn(`[Limiter ${name}] Job failed after ${jobInfo.retryCount} attempts:`, error);
  });

  limiter.on('idle', () => {
    logger.info(`[Limiter ${name}] All queued jobs have been processed.`);
  });
};

setupLimiterListeners(limiterTransaction, 'Transaction');
setupLimiterListeners(limiterMetadata, 'Metadata');

/**
 * Enhanced retry helper with exponential backoff and jitter
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  let attempts = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempts++;
      if (attempts > MAX_RETRIES) {
        logger.error(`${context} - Max retries exceeded`);
        throw error;
      }

      const isRateLimit = error.response?.status === 429;
      const retryAfter = isRateLimit
        ? parseInt(error.response.headers['retry-after'] || '1', 10) * 1000
        : undefined;

      let delay = BASE_DELAY * Math.pow(2, attempts) + Math.random() * JITTER;

      if (retryAfter) {
        delay = Math.max(retryAfter, delay);
      }

      logger.warn(`${context} - Retry ${attempts}/${MAX_RETRIES} in ${delay.toFixed(0)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Check if an instruction is an InitializeMint instruction
 */
const isInitializeMintInstruction = (
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): boolean => {
  try {
    if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) return false;

    // Handle parsed instruction
    if ('parsed' in instruction) {
      return instruction.parsed?.type === 'initializeMint';
    }

    // Handle partially decoded instruction
    if ('data' in instruction && instruction.data) {
      const data = typeof instruction.data === 'string' 
        ? Buffer.from(instruction.data, 'base64') // Convert base64 string to Buffer
        : Buffer.from(instruction.data);
      
      return data[0] === TokenInstruction.InitializeMint; // Direct comparison with enum
    }

    return false;
  } catch (error) {
    logger.error('Error decoding instruction:', error);
    return false;
  }
};

/**
 * Extract mint address from initialize mint instruction
 */
const extractMintFromInstruction = (
  tx: ParsedTransactionWithMeta,
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): string | null => {
  try {
    // Handle parsed instruction
    if ('parsed' in instruction) {
      return instruction.parsed?.info?.mint || null;
    }

    // Handle partially decoded instruction
    const mintAccount = instruction.accounts[0];
    if (typeof mintAccount !== 'number') {
      logger.error('Mint account is not a number');
      return null;
    }
    const mintPubkey = tx.transaction.message.accountKeys[mintAccount]?.pubkey;
    return mintPubkey?.toBase58() || null;
  } catch (error) {
    logger.error('Error extracting mint address:', error);
    return null;
  }
};

/**
 * Validate mint address
 */
const isValidMint = (address: string): boolean => {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
};

/**
 * Enhanced metadata fetching with caching
 */
const fetchTokenMetadataWithCache = async (mintAddress: string) => {
  const cacheKey = `token:${mintAddress}`;
  try {
    // Check cache first
    const cachedData = await cached.get(cacheKey);
    if (cachedData) return JSON.parse(cachedData as string);

    // Fetch fresh data if not in cache
    const metadata = await limiterMetadata.schedule(() => 
      withRetry(() => fetchTokenMetadata(mintAddress), 'Fetch Metadata')
    );
    
    // Cache for 5 minutes
    await cached.set(cacheKey, JSON.stringify(metadata));
    return metadata;
  } catch (error) {
    logger.error(`Metadata fetch failed for ${mintAddress}:`, error);
    return null;
  }
};

/**
 * Handle a newly detected token by processing it for all active users
 */
const handleNewToken = async (mintAddress: string, creationSlot: number) => {
  if (!isValidMint(mintAddress)) {
    logger.warn(`Invalid mint address: ${mintAddress}`);
    return;
  }

  logger.info(`Processing new token: ${mintAddress}`);

  for (const [userId, config] of activeUsers) {
    try {
      if (creationSlot < config.startSlot) {
        logger.debug(`Skipping token ${mintAddress} for user ${userId} (slot ${creationSlot} < ${config.startSlot})`);
        continue;
      }

      const tokenInfo: TokenInfo = { mintAddress };
      const passesFilters = await applyFilters(tokenInfo, userId);

      if (passesFilters) {
        await processValidToken(userId, tokenInfo);
      }
    } catch (error) {
      logger.error(`Error processing token ${mintAddress} for user ${userId}:`, error);
    }
  }
};

/**
 * Process tokens that pass filters by fetching metadata and sending notifications
 */
const processValidToken = async (userId: number, tokenInfo: TokenInfo) => {
  try {
    const [metadata, userSettings] = await Promise.all([
      fetchTokenMetadataWithCache(tokenInfo.mintAddress),
      getUserSettings(userId)
    ]);

    const autobuyEnabled = userSettings?.Autobuy === true;
    const message = constructTokenMessage(tokenInfo, metadata, autobuyEnabled);

    await botInstance.api.sendMessage(userId, message, {
      parse_mode: 'HTML',
    });

    if (autobuyEnabled) {
      await handleTokenPurchase(userId, tokenInfo);
    }
  } catch (error) {
    logger.error(`Failed to process token ${tokenInfo.mintAddress} for user ${userId}:`, error);
    await botInstance.api.sendMessage(
      userId,
      '⚠️ <b>Error processing token notification!</b>',
      { parse_mode: 'HTML' }
    );
  }
};

/**
 * Handle token purchase for autobuy
 */
const handleTokenPurchase = async (userId: number, tokenInfo: TokenInfo) => {
  try {
    const success = await purchaseToken(userId, tokenInfo);
    const message = success
      ? '✅ <b>Token purchased successfully!</b>'
      : '❌ <b>Failed to purchase token!</b>';

    await botInstance.api.sendMessage(userId, message, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    logger.error(`Purchase failed for ${tokenInfo.mintAddress}:`, error);
    await botInstance.api.sendMessage(
      userId,
      '⚠️ <b>Error processing purchase!</b>',
      { parse_mode: 'HTML' }
    );
  }
};

/**
 * Construct token notification message
 */
const constructTokenMessage = (
  tokenInfo: TokenInfo,
  metadata: any,
  autobuy: boolean
): string => {
  const tokenAddress = tokenInfo.mintAddress;
  const pairs = metadata?.pairs || metadata?.data?.pairs || [];

  if (pairs.length > 0) {
    const tokenDetails = pairs[0];
    const baseToken = tokenDetails.baseToken || {};
    const priceUsd = tokenDetails.priceUsd
      ? `$${parseFloat(tokenDetails.priceUsd).toFixed(6)}`
      : 'N/A';
    const liquidityUsd = tokenDetails.liquidity?.usd
      ? `$${parseFloat(tokenDetails.liquidity.usd).toLocaleString()}`
      : 'N/A';
    const dexUrl = tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;

    return [
      '🚀 <b>New Token Detected!</b>',
      `<b>Name:</b> ${baseToken.name || 'Unknown'}`,
      `<b>Symbol:</b> ${baseToken.symbol || 'UNKNOWN'}`,
      `<b>Mint:</b> <code>${tokenAddress}</code>`,
      `<b>Price:</b> ${priceUsd}`,
      `<b>Liquidity:</b> ${liquidityUsd}`,
      '',
      `<a href="${dexUrl}">DexScreener</a> | <a href="https://solscan.io/token/${tokenAddress}">Solscan</a>`,
      '',
      autobuy ? '🟢 Auto-buy Enabled' : '🔴 Auto-buy Disabled'
    ].join('\n');
  }

  return [
    '🚀 <b>New SPL Token Found!</b>',
    `<b>Name:</b> ${metadata?.metadata?.name || 'N/A'}`,
    `<b>Symbol:</b> ${metadata?.metadata?.symbol || 'N/A'}`,
    `<b>Mint:</b> <code>${tokenAddress}</code>`,
    '',
    `<a href="https://solscan.io/token/${tokenAddress}">Solscan Link</a>`,
    '',
    autobuy ? '🟢 Auto-buy Enabled' : '🔴 Auto-buy Disabled'
  ].join('\n');
};

/**
 * Initialize WebSocket listener for new token mints
 */
const initializeMintListener = async () => {
  if (websocketSubscriptionId !== null) return;

  websocketSubscriptionId = connection.onLogs(
    TOKEN_PROGRAM_ID,
    async (logs, ctx) => {
      if (logs.err || processedSignatures.has(logs.signature)) return;

      // Immediately mark as processed to avoid duplicates
      processedSignatures.add(logs.signature);

      limiterTransaction.schedule(async () => {
        try {
          const tx = await withRetry(
            () => connection.getParsedTransaction(logs.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed'
            }),
            `Fetch TX ${logs.signature.slice(0, 15)}...`
          );

          if (!tx) {
            logger.warn(`Transaction ${logs.signature} not found`);
            return;
          }

          const instructions = tx.transaction.message.instructions;
          const innerInstructions = tx.meta?.innerInstructions || [];

          const tokenProgramInstructions = [
            ...instructions.filter(ix => ix.programId.equals(TOKEN_PROGRAM_ID)),
            ...innerInstructions.flatMap(({ instructions }) => 
              instructions.filter(ix => 'programId' in ix && ix.programId.equals(TOKEN_PROGRAM_ID))
            )
          ];

          const initMintIx = tokenProgramInstructions.find(isInitializeMintInstruction);
          if (!initMintIx) return;

          const mintAddress = extractMintFromInstruction(tx, initMintIx);
          if (mintAddress) {
            await handleNewToken(mintAddress, ctx.slot);
          }
        } catch (error: any) {
          logger.error(`Error processing transaction ${logs.signature}:`, error);
          processedSignatures.delete(logs.signature); // Allow retrying in future
        }
      }).catch(error => {
        logger.error(`Failed to schedule transaction job for ${logs.signature}:`, error);
      });
    },
    'confirmed'
  );

  logger.info('WebSocket listener initialized with rate limiting');
};

/**
 * Enhanced connection health monitoring
 */
const checkConnectionHealth = async () => {
  try {
    await withRetry(
      () => connection.getEpochInfo(),
      'Connection health check'
    );
    logger.info('Connection healthy');
    return true;
  } catch (error) {
    logger.error('Connection health check failed:', error);
    return false;
  }
};

// Add periodic health checks
setInterval(() => {
  checkConnectionHealth().then(healthy => {
    if (!healthy) {
      logger.warn('Restarting WebSocket connection...');
      if (websocketSubscriptionId !== null) {
        connection.removeOnLogsListener(websocketSubscriptionId);
        websocketSubscriptionId = null;
      }
      initializeMintListener();
    }
  });
}, 60000); // Check every minute

/**
 * Start token listener for a user
 */
export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUsers.has(userId)) {
    logger.warn(`User ${userId} already listening`);
    return;
  }

  const startSlot = await connection.getSlot('confirmed');
  activeUsers.set(userId, { startSlot, filters: [] });

  // Initialize listener only if not already running
  if (!websocketSubscriptionId) {
    const healthy = await checkConnectionHealth();
    if (healthy) {
      await initializeMintListener();
      logger.info('System initialization complete');
    } else {
      logger.error('Failed to initialize listener due to connection issues');
    }
  }

  logger.info(`User ${userId} started listening from slot ${startSlot}`);
};

/**
 * Stop token listener for a user
 */
export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUsers.has(userId)) {
    logger.warn(`User ${userId} is not actively listening`);
    return;
  }

  activeUsers.delete(userId);
  logger.info(`User ${userId} stopped listening`);

  if (activeUsers.size === 0 && websocketSubscriptionId !== null) {
    try {
      await connection.removeOnLogsListener(websocketSubscriptionId);
      websocketSubscriptionId = null;
      processedSignatures.clear();
      logger.info('Stopped Solana token listener');
    } catch (error) {
      logger.error('Error stopping token listener:', error);
    }
  }
};
