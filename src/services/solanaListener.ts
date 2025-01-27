import { PublicKey, Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot';
import { fetchTokenMetadata } from './tokenMetadataService';
import { getUserSettings } from './userSettingsService';

/**
 * WebSocket RPC URL to subscribe to logs in real-time.
 * Replace the API key with your own if needed.
 */
const SUBSCRIPTION_RPC_URL = 'wss://mainnet.helius-rpc.com/?api-key=04beb6c3-21a5-4a66-9b3f-3547bceca91d';

const HELIUS_HTTP_URL = 'https://mainnet.helius-rpc.com/?api-key=04beb6c3-21a5-4a66-9b3f-3547bceca91d';
const HELIUS_WSS_URL = 'wss://mainnet.helius-rpc.com/?api-key=04beb6c3-21a5-4a66-9b3f-3547bceca91d';
/**
 * Connection configured for both confirming transactions and receiving WebSocket events.
 */
const subscriptionConnection = new Connection(HELIUS_HTTP_URL, {
  commitment: 'confirmed',
  wsEndpoint: HELIUS_WSS_URL 
});

/**
 * Tracks active users:
 *   - key: user ID (e.g., Telegram userId)
 *   - value: { startSlot, filters[] }
 * We only process tokens whose creation slot >= user’s startSlot.
 */
const activeUsers = new Map<number, {
  startSlot: number;
  filters: string[];
}>();

/**
 * Set of transaction signatures we have already processed (to avoid double-processing).
 */
const processedSignatures = new Set<string>();

/**
 * Subscription ID returned by onLogs so we can remove it if no active users remain.
 */
let websocketSubscriptionId: number | null = null;

/* ------------------------------------------------------------------
 *  1) Initialize Mint Listener
 * ------------------------------------------------------------------ */
const initializeMintListener = async () => {
  // If we already have a subscription, do nothing
  if (websocketSubscriptionId !== null) {
    return;
  }

  /**
   * Subscribe to logs emitted by the Token program. We'll look for "Instruction: InitializeMint" 
   * lines in the log to detect brand-new SPL mints as they happen.
   */
  websocketSubscriptionId = subscriptionConnection.onLogs(
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    async (logs, ctx) => {
      logger.debug(`Received logs: ${JSON.stringify(logs)}`);

      try {
        // If transaction errors or has already been processed, skip
        if (logs.err || processedSignatures.has(logs.signature)) {
          return;
        }

        // Check logs for "Instruction: InitializeMint" and the Token program's mention
        const isNewMintCreation = logs.logs.some(log =>
          log.includes('Program log: Instruction: InitializeMint') &&
          log.includes('Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        );

        if (!isNewMintCreation) {
          return;
        }

        // Record that we've processed this transaction signature
        processedSignatures.add(logs.signature);

        logger.debug(`New mint detected in tx: ${logs.signature}`);

        // Fetch the parsed transaction details
        const tx = await subscriptionConnection.getParsedTransaction(
          logs.signature,
          'confirmed'
        );

        if (!tx) {
          logger.warn(`Transaction ${logs.signature} not found`);
          return;
        }

        // Extract the mint address from this transaction
        const mintAccount = extractMintFromTransaction(tx);
        if (!mintAccount) {
          return;
        }

        // Process the newly created token across all active users
        handleNewToken(mintAccount, ctx.slot);
      } catch (error) {
        logger.error(`Error processing transaction ${logs.signature}:`, error);
      }
    },
    'confirmed'
  );

  logger.info('WebSocket listener for new mints initialized');
};

/* ------------------------------------------------------------------
 *  2) Extract the Mint Address from the Parsed Transaction
 * ------------------------------------------------------------------ */
const extractMintFromTransaction = (tx: ParsedTransactionWithMeta): string | null => {
  try {
    // The "InitializeMint" instruction in the Token program has data[0] = 0.
    const initializeIx = tx.transaction.message.instructions.find(ix => 
      (ix as any).programId?.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
      (ix as any).data[0] === 0
    );

    if (!initializeIx) {
      return null;
    }

    // The first account of this instruction is the mint account.
    const mintIndex = (initializeIx as any).accounts[0];
    return new PublicKey(tx.transaction.message.accountKeys[mintIndex].pubkey).toBase58();
  } catch (error) {
    logger.error('Error extracting mint from transaction:', error);
    return null;
  }
};

/* ------------------------------------------------------------------
 *  3) Handle the Newly Created Token for All Active Users
 * ------------------------------------------------------------------ */
const handleNewToken = async (mintAddress: string, creationSlot: number) => {
  if (!isValidMint(mintAddress)) {
    logger.warn(`Invalid mint address: ${mintAddress}`);
    return;
  }

  logger.info(`Processing new token: ${mintAddress}`);

  // Loop over all active users
  for (const [userId, config] of activeUsers) {
    try {
      // Skip if the token was created before the user started listening
      if (creationSlot < config.startSlot) {
        logger.debug(
          `Skipping token ${mintAddress} for user ${userId} (older slot: creation=${creationSlot} < userStart=${config.startSlot})`
        );
        continue;
      }

      const tokenInfo: TokenInfo = { mintAddress };
      const passesFilters = await applyFilters(tokenInfo, userId);

      if (!passesFilters) {
        logger.debug(`Token ${mintAddress} failed filters for user ${userId}`);
        continue;
      }

      // If passes filters, proceed with final steps
      await processValidToken(userId, tokenInfo);
    } catch (error) {
      logger.error(`Error processing token ${mintAddress} for user ${userId}:`, error);
    }
  }
};

/* ------------------------------------------------------------------
 *  4) Process Tokens Passing Filters
 *      - Fetch DexScreener or metadata
 *      - Construct & send Telegram message
 *      - Attempt auto-purchase if enabled
 * ------------------------------------------------------------------ */
const processValidToken = async (userId: number, tokenInfo: TokenInfo) => {
  try {
    // Fetch DexScreener data & user settings in parallel
    const [dexData, userSettings] = await Promise.all([
      fetchTokenMetadata(tokenInfo.mintAddress),
      getUserSettings(userId)
    ]);

    const autobuyEnabled = userSettings?.Autobuy === true;
    const message = await constructTokenMessage(tokenInfo, dexData, autobuyEnabled);

    // Send Telegram notification
    await botInstance.api.sendMessage(userId, message, {
      parse_mode: 'HTML',
    });

    // If autobuy is on, attempt purchase
    if (autobuyEnabled) {
      await handleTokenPurchase(userId, tokenInfo);
    }
  } catch (error) {
    logger.error(`Failed to process token ${tokenInfo.mintAddress} for user ${userId}:`, error);
  }
};

/* ------------------------------------------------------------------
 *  5) Perform Token Purchase (Autobuy)
 * ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------
 *  6) Start/Stop Token Listener for Each User
 * ------------------------------------------------------------------ */
export const startTokenListener = async (userId: number): Promise<void> => {
  if (activeUsers.has(userId)) {
    logger.warn(`User ${userId} already listening.`);
    return;
  }

  const startSlot = await subscriptionConnection.getSlot('confirmed');
  activeUsers.set(userId, {
    startSlot,
    filters: []  // Add any user-specific filters here
  });

  logger.info(`User ${userId} started listening from slot ${startSlot}`);

  // Initialize the onLogs subscription if not yet active
  if (!websocketSubscriptionId) {
    await initializeMintListener();
  }
};

export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUsers.has(userId)) {
    logger.warn(`User ${userId} is not actively listening.`);
    return;
  }

  activeUsers.delete(userId);
  logger.info(`User ${userId} stopped listening.`);

  // If no users remain, remove the subscription
  if (activeUsers.size === 0 && websocketSubscriptionId !== null) {
    try {
      await subscriptionConnection.removeOnLogsListener(websocketSubscriptionId);
      logger.info('No active users left. Stopped Solana token listener.');
    } catch (err: any) {
      logger.error(`Error stopping token listener: ${err.message}`, err);
    } finally {
      websocketSubscriptionId = null;
      processedSignatures.clear();
    }
  }
};

/* ------------------------------------------------------------------
 *  7) Utility Helpers
 * ------------------------------------------------------------------ */
const isValidMint = (address: string): boolean => {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build a Telegram message using DexScreener data or fallback to minimal metadata.
 */
const constructTokenMessage = async (
  tokenInfo: TokenInfo,
  dexData: any,
  autobuy: boolean
): Promise<string> => {
  const tokenAddress = tokenInfo.mintAddress;
  // DexScreener data can appear in different fields, adapt as needed.
  const pairs = dexData?.pairs || dexData?.data?.pairs;

  if (pairs && pairs.length > 0) {
    const tokenDetails = pairs[0];
    const baseToken = tokenDetails.baseToken || {};
    const priceUsd = tokenDetails.priceUsd
      ? `$${parseFloat(tokenDetails.priceUsd).toFixed(6)}`
      : 'N/A';
    const liquidityUsd = tokenDetails.liquidity?.usd
      ? `$${parseFloat(tokenDetails.liquidity.usd).toLocaleString()}`
      : 'N/A';
    const dexUrl = tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;
    const buyingStatus = autobuy
      ? '🟢 Auto-buy Enabled'
      : '🔴 Auto-buy Disabled';

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
      buyingStatus
    ].join('\n');
  }

  // If DexScreener doesn't have data, fallback to minimal info.
  const fallbackName = dexData?.metadata?.name || 'N/A';
  const fallbackSymbol = dexData?.metadata?.symbol || 'N/A';
  const buyingStatus = autobuy
    ? '🟢 Auto-buy Enabled'
    : '🔴 Auto-buy Disabled';

  return [
    '🚀 <b>New SPL Token Found!</b>',
    `<b>Name:</b> ${fallbackName}`,
    `<b>Symbol:</b> ${fallbackSymbol}`,
    `<b>Mint:</b> <code>${tokenAddress}</code>`,
    '',
    `<a href="https://solscan.io/token/${tokenAddress}">SolScan Link</a>`,
    '',
    buyingStatus
  ].join('\n');
};
