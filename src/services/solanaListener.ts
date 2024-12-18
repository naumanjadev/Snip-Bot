// src/services/solanaListener.ts

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { applyFilters } from './tokenFilters';
import { TokenInfo } from '../types';
import { purchaseToken } from './purchaseService';
import { botInstance } from '../bots/telegramBot'; // Import the exported bot instance
import axios from 'axios';
import { fetchTokenMetadata } from './tokenMetadataService'; // Import the metadata fetcher
import { getMintWithRateLimit } from './rpcRateLimiter'; // Import the rate-limited getMint
import { Mint } from '@solana/spl-token';
import { getUserSettings } from './userSettingsService'; // Import getUserSettings

// DexScreener API Endpoint
const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

// Validate Mint Address
const isValidMint = (address: string): boolean => {
  try {
    new PublicKey(address);
    return PublicKey.isOnCurve(new PublicKey(address));
  } catch {
    return false;
  }
};

// Connection to Solana RPC
export const connection: Connection = new Connection(config.solanaRpcUrl, 'confirmed');

let listenerId: number | null = null;
const activeUserIds: Set<number> = new Set();
let isProcessing: boolean = false; // Flag to prevent concurrent processing

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
  logger.debug(`Constructing message with DexScreener data: ${JSON.stringify(dexData, null, 2)}`);

  // Adjust access based on DexScreener's response structure
  const pairs = dexData.pairs || dexData.data?.pairs;

  if (pairs && pairs.length > 0) {
    const tokenDetails = pairs[0];
    const baseToken = tokenDetails.baseToken || {};
    const quoteToken = tokenDetails.quoteToken || {};
    const priceUsd = tokenDetails.priceUsd
      ? parseFloat(tokenDetails.priceUsd).toFixed(6)
      : 'N/A';
    const liquidity = tokenDetails.liquidity?.usd
      ? parseFloat(tokenDetails.liquidity.usd).toLocaleString()
      : 'N/A';
    const fdv = tokenDetails.fdv
      ? parseFloat(tokenDetails.fdv).toLocaleString()
      : 'N/A';
    const marketCap = tokenDetails.marketCap
      ? parseFloat(tokenDetails.marketCap).toLocaleString()
      : 'N/A';
    const dexUrl =
      tokenDetails.url || `https://dexscreener.com/solana/${tokenAddress}`;
    const creationTime = tokenDetails.creationTime
      ? new Date(tokenDetails.creationTime * 1000).toUTCString()
      : 'N/A';

    // Determine the buying status message
    const buyingStatus = autobuy
      ? '➡️ <b>Buying Token...</b>'
      : '🔒 <b>Autobuy is OFF. Token not purchased.</b> Please enable Autobuy to perform automatic purchases.';

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

    // Determine the buying status message
    const buyingStatus = autobuy
      ? '💰 <b>Buying Token...</b>'
      : '🔒 <b>Autobuy is OFF. Token not purchased.</b> Please enable Autobuy to perform automatic purchases.';

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
  if (activeUserIds.has(userId)) {
    logger.warn(`Token detection is already active for user ${userId}.`);
    return;
  }

  activeUserIds.add(userId);
  logger.info(`User ${userId} started token detection.`);

  if (listenerId === null) {
    listenerId = connection.onProgramAccountChange(
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      async (keyedAccountInfo, context) => {
        if (isProcessing) {
          logger.debug('Listener is already processing an event. Skipping this event.');
          return;
        }

        if (activeUserIds.size === 0) {
          logger.debug('No active users. Listener should be stopped.');
          return;
        }

        isProcessing = true; // Acquire the processing lock

        try {
          const accountId = keyedAccountInfo.accountId.toBase58();

          // Validate mint address before processing
          if (!isValidMint(accountId)) {
            logger.warn(`Invalid mint address detected: ${accountId}. Skipping.`);
            return;
          }

          const tokenInfo: TokenInfo = { mintAddress: accountId };
          
          // Create a snapshot of activeUserIds to allow safe removal during iteration
          const users = Array.from(activeUserIds);

          for (const uid of users) {
            try {
              const passesFilters = await applyFilters(tokenInfo, uid);
              if (passesFilters) {
                logger.info(
                  `Token ${accountId} passed filters for user ${uid}. Fetching details and sending message.`
                );

                // Fetch detailed token information from DexScreener
                const dexData = await fetchTokenDetails(accountId);

                // Log DexScreener data for debugging
                if (dexData) {
                  logger.debug(
                    `DexScreener Data for ${accountId}: ${JSON.stringify(
                      dexData,
                      null,
                      2
                    )}`
                  );
                }

                // Fetch user settings to check Autobuy status
                const userSettings = await getUserSettings(uid);
                const autobuy: boolean = userSettings.Autobuy === true;

                // Construct the detailed message
                const message = await constructTokenMessage(tokenInfo, dexData, autobuy);

                // Send the message to the user via Telegram
                await botInstance.api.sendMessage(uid, message, { parse_mode: 'HTML' });

                if (autobuy) {
                  // Perform the token purchase
                  const purchaseSuccess = await purchaseToken(uid, tokenInfo);

                  if (purchaseSuccess) {
                    logger.info(`Token ${accountId} successfully purchased for user ${uid}.`);
                    // Notify the user about the successful purchase
                    await botInstance.api.sendMessage(uid, `✅ <b>Token purchased successfully!</b>`, { parse_mode: 'HTML' });
                  } else {
                    logger.error(`Failed to purchase token ${accountId} for user ${uid}.`);
                    // Notify the user about the failed purchase
                    await botInstance.api.sendMessage(uid, `❌ <b>Failed to purchase the token.</b> Please check your settings or try again later.`, { parse_mode: 'HTML' });
                  }
                } else {
                  // Inform the user that Autobuy is off
                  logger.info(`Autobuy is OFF for user ${uid}. Token ${accountId} not purchased.`);
                  await botInstance.api.sendMessage(uid, `ℹ️ <b>Autobuy is OFF. Token not purchased.</b> You can enable Autobuy in your settings if you wish to perform automatic purchases.`, { parse_mode: 'HTML' });
                }

                // Keep the listener active; do not remove the user from activeUserIds
              } else {
                logger.debug(
                  `Token ${accountId} did not pass filters for user ${uid}.`
                );
              }
            } catch (error: any) {
              logger.error(
                `Error processing token ${accountId} for user ${uid}: ${error.message}`,
                error
              );
            }
          }

          // After processing all users, check if listener should be removed
          if (activeUserIds.size === 0 && listenerId !== null) {
            try {
              connection.removeProgramAccountChangeListener(listenerId);
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
      'confirmed' // Ensure the commitment level is appropriate
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

  if (activeUserIds.size === 0 && listenerId !== null) {
    try {
      connection.removeProgramAccountChangeListener(listenerId);
      logger.info('Solana token listener stopped.');
      listenerId = null;
    } catch (error: any) {
      logger.error(`Error stopping token listener: ${error.message}`, error);
    }
  }
};
