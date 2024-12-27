// src/services/solanaListener.ts

import { PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot'; 
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService';
import { getUserSettings } from './userSettingsService';

// -------------------------------------
// Import from your rate-limiter file
// -------------------------------------
import {
  getRandomConnection, // for the subscription
} from './rpcRateLimiter';

// -------------------------------------
// DexScreener API Endpoint
// -------------------------------------
const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

// -------------------------------------
// Validate Mint Address
// -------------------------------------
const isValidMint = (address: string): boolean => {
  try {
    new PublicKey(address);
    return PublicKey.isOnCurve(new PublicKey(address));
  } catch {
    return false;
  }
};

// -------------------------------------
// Instead of a single connection, use a
// random connection for the subscription
// -------------------------------------
let subscriptionConnection = getRandomConnection();

// -------------------------------------
// Listener state
// -------------------------------------
let listenerId: number | null = null;
const activeUserIds: Set<number> = new Set();
let isProcessing = false; // prevents overlapping calls

/**
 * Fetch detailed token information from DexScreener.
 * @param tokenAddress The mint address of the token.
 * @returns Token details or null if fetching fails.
 */
const fetchTokenDetails = async (tokenAddress: string): Promise<any | null> => {
  try {
    const response = await axios.get(`${DEXSCREENER_TOKENS_URL}${tokenAddress}`);
    if (response.status === 200) {
      logger.debug(
        `DexScreener API Response for ${tokenAddress}: ${JSON.stringify(
          response.data,
          null,
          2
        )}`
      );
      return response.data;
    } else {
      logger.error(
        `DexScreener API responded with status ${response.status} for token ${tokenAddress}.`
      );
      return null;
    }
  } catch (error: any) {
    logger.error(
      `Error fetching token details from DexScreener for ${tokenAddress}: ${error.message}`,
      error
    );
    return null;
  }
};

/**
 * Constructs a detailed and catchy message with token information.
 * @param tokenInfo Basic token information.
 * @param dexData Detailed token information from DexScreener.
 * @param autobuy Indicates whether Autobuy is enabled.
 * @returns Formatted message string.
 */
const constructTokenMessage = async (
  tokenInfo: TokenInfo,
  dexData: any,
  autobuy: boolean
): Promise<string> => {
  const tokenAddress = tokenInfo.mintAddress;

  // Log the DexScreener data structure
  logger.debug(
    `Constructing message with DexScreener data: ${JSON.stringify(dexData, null, 2)}`
  );

  // Adjust access based on DexScreener's response structure
  const pairs = dexData?.pairs || dexData?.data?.pairs;
  if (pairs && pairs.length > 0) {
    const tokenDetails = pairs[0];
    const baseToken = tokenDetails.baseToken || {};
    const priceUsd = tokenDetails.priceUsd
      ? parseFloat(tokenDetails.priceUsd).toFixed(6)
      : 'N/A';
    const liquidity = tokenDetails?.liquidity?.usd
      ? parseFloat(tokenDetails.liquidity.usd).toLocaleString()
      : 'N/A';
    const fdv = tokenDetails.fdv
      ? parseFloat(tokenDetails.fdv).toLocaleString()
      : 'N/A';
    const marketCap = tokenDetails.marketCap
      ? parseFloat(tokenDetails.marketCap).toLocaleString()
      : 'N/A';
    const dexUrl = tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;
    const creationTime = tokenDetails.creationTime
      ? new Date(tokenDetails.creationTime * 1000).toUTCString()
      : 'N/A';

    // Determine the buying status message
    const buyingStatus = autobuy
      ? '➡️ <b>Buying Token...</b>'
      : '🔒 <b>Autobuy is OFF. Token not purchased.</b>';

    return `🚀 <b>🔥 New Token Alert!</b>

<b>Token Name:</b> ${baseToken.name || 'N/A'}
<b>Symbol:</b> ${baseToken.symbol || 'N/A'}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🌐 <b>Blockchain:</b> Solana

💲 <b>Price USD:</b> $${priceUsd}
💧 <b>Liquidity USD:</b> $${liquidity}
📈 <b>FDV:</b> $${fdv}
📊 <b>Market Cap:</b> $${marketCap}
🕒 <b>Creation Time:</b> ${creationTime}

🔗 <b>DexScreener URL:</b> <a href="${dexUrl}">View on DexScreener</a>
🔗 <b>SolScan URL:</b> <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💥 <i>This token has passed all your filters!</i>

${buyingStatus}

🔔 To listen for more tokens, use /start_listener.
`;
  } else {
    // DexScreener does not have pairs data; fetch token metadata
    const metadata = await fetchTokenMetadata(tokenAddress);
    const name = metadata?.name || 'N/A';
    const symbol = metadata?.symbol || 'N/A';

    const buyingStatus = autobuy
      ? '💰 <b>Buying Token...</b>'
      : '🔒 <b>Autobuy is OFF. Token not purchased.</b>';

    if (name === 'N/A' && symbol === 'N/A') {
      // Both DexScreener and Metaplex failed to provide details
      return `🚨 <b>Token Match Found!</b>

<b>Mint Address:</b> <code>${tokenAddress}</code>

🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💡 <i>Additional details are unavailable.</i>

${buyingStatus}

🔔 To listen for more tokens, use /start_listener.
`;
    }

    return `🚨 <b>Token Match Found!</b>

<b>Token Name:</b> ${name}
<b>Symbol:</b> ${symbol}
<b>Mint Address:</b> <code>${tokenAddress}</code>

🔗 <a href="https://solscan.io/token/${tokenAddress}">View on SolScan</a>

💡 <i>Additional details are unavailable.</i>

${buyingStatus}

🔔 To listen for more tokens, use /start_listener.
`;
  }
};

/**
 * Starts the token listener for a specific user.
 */
export const startTokenListener = async (userId: number): Promise<void> => {
  // Prevent re-start for the same user
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  // Create the subscription only if it doesn't exist yet
  if (listenerId === null) {
    listenerId = subscriptionConnection.onProgramAccountChange(
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      async (keyedAccountInfo) => {
        // Check if we are already processing to avoid overlap
        if (isProcessing) {
          logger.debug('Listener is already processing an event. Skipping this event.');
          return;
        }

        // If no active users remain, there's no need to process
        if (activeUserIds.size === 0) {
          logger.debug('No active users. Listener should be stopped.');
          return;
        }

        isProcessing = true; // Acquire the processing lock

        try {
          const accountId = keyedAccountInfo.accountId.toBase58();

          // Validate mint address
          if (!isValidMint(accountId)) {
            logger.warn(`Invalid mint address detected: ${accountId}. Skipping.`);
            return;
          }

          const tokenInfo: TokenInfo = { mintAddress: accountId };
          
          // Snapshot of activeUserIds to safely iterate
          const users = Array.from(activeUserIds);

          // Process for each user
          for (const uid of users) {
            try {
              // 1) Apply user-defined filters
              const passesFilters = await applyFilters(tokenInfo, uid);
              if (!passesFilters) {
                logger.debug(`Token ${accountId} did not pass filters for user ${uid}.`);
                continue;
              }

              logger.info(
                `Token ${accountId} passed filters for user ${uid}. Fetching details and sending message.`
              );

              // 2) Fetch DexScreener data
              const dexData = await fetchTokenDetails(accountId);

              // 3) Get user settings to check Autobuy
              const userSettings = await getUserSettings(uid);
              const autobuy: boolean = userSettings.Autobuy === true;

              // 4) Construct the message
              const message = await constructTokenMessage(tokenInfo, dexData, autobuy);

              // 5) Send Telegram message
              await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });

              // 6) If Autobuy is ON, purchase the token
              if (autobuy) {
                const purchaseSuccess = await purchaseToken(uid, tokenInfo);

                if (purchaseSuccess) {
                  logger.info(`Token ${accountId} successfully purchased for user ${uid}.`);
                  await botInstance.api.sendMessage(
                    uid,
                    `✅ <b>Token purchased successfully!</b>`,
                    { parse_mode: 'HTML' }
                  );
                } else {
                  logger.error(`Failed to purchase token ${accountId} for user ${uid}.`);
                  await botInstance.api.sendMessage(
                    uid,
                    `❌ <b>Failed to purchase the token.</b> Please check your settings or try again later.`,
                    { parse_mode: 'HTML' }
                  );
                }
              } else {
                // Inform user that Autobuy is off
                logger.info(`Autobuy is OFF for user ${uid}. Token ${accountId} not purchased.`);
                await botInstance.api.sendMessage(
                  uid,
                  `ℹ️ <b>Autobuy is OFF. Token not purchased.</b> You can enable Autobuy in your settings if you wish to perform automatic purchases.`,
                  { parse_mode: 'HTML' }
                );
              }

            } catch (error: any) {
              logger.error(
                `Error processing token ${accountId} for user ${uid}: ${error.message}`,
                error
              );
            }
          }

          // After processing all users, check if we should stop the listener
          if (activeUserIds.size === 0 && listenerId !== null) {
            try {
              subscriptionConnection.removeProgramAccountChangeListener(listenerId);
              logger.info('Solana token listener stopped as there are no active users.');
              listenerId = null;
            } catch (error: any) {
              logger.error(`Error stopping token listener: ${error.message}`, error);
            }
          }
        } catch (error: any) {
          logger.error(`Unexpected error in listener callback: ${error.message}`, error);
        } finally {
          isProcessing = false; // Release the processing lock
        }
      },
      'confirmed'
    );

    logger.info('Solana token listener started.');
  }
};

/**
 * Stops the token listener for a specific user.
 */
export const stopTokenListener = async (userId: number): Promise<void> => {
  if (!activeUserIds.has(userId)) {
    logger.warn(`Token detection is not active for user ${userId}.`);
    return;
  }

  activeUserIds.delete(userId);
  logger.info(`User ${userId} stopped token detection.`);

  // If no more active users, remove the subscription
  if (activeUserIds.size === 0 && listenerId !== null) {
    try {
      subscriptionConnection.removeProgramAccountChangeListener(listenerId);
      logger.info('Solana token listener stopped.');
      listenerId = null;
    } catch (error: any) {
      logger.error(`Error stopping token listener: ${error.message}`, error);
    }
  }
};
