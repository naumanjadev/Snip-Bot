// src/controllers/filterController.ts

import { MyContext } from '../types';
import { updateUserSettings, getUserSettings } from '../services/userSettingsService';
import { startTokenListener, stopTokenListener } from '../services/solanaListener';

/**
 * Handles the /set_liquidity command.
 * @param ctx - The context of the Telegram message.
 */
export const handleSetLiquidityCommand = async (ctx: MyContext): Promise<void> => {
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Please enter the minimum liquidity threshold in SOL (or type "no minimum"):');
    ctx.session.awaitingInputFor = 'set_liquidity';
  } else {
    const input = ctx.message?.text?.trim().toLowerCase();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    if (input === 'no minimum') {
      await updateUserSettings(userId, { liquidityThreshold: null });
      await ctx.reply('Liquidity threshold removed.');
    } else {
      const value = parseFloat(input);
      if (isNaN(value) || value < 0) {
        await ctx.reply('Please enter a valid number.');
        return;
      }
      await updateUserSettings(userId, { liquidityThreshold: value });
      await ctx.reply(`Liquidity threshold set to ${value} SOL.`);
    }
    ctx.session.awaitingInputFor = undefined;
  }
};

/**
 * Handles the /set_mint_authority command.
 * @param ctx - The context of the Telegram message.
 */
export const handleSetMintAuthorityCommand = async (ctx: MyContext): Promise<void> => {
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Should the token have mint authority? (yes/no/no preference):');
    ctx.session.awaitingInputFor = 'set_mint_authority';
  } else {
    const input = ctx.message?.text?.trim().toLowerCase();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    if (input === 'yes') {
      await updateUserSettings(userId, { requireMintAuthority: true });
      await ctx.reply('Filter set: Token must have mint authority.');
    } else if (input === 'no') {
      await updateUserSettings(userId, { requireMintAuthority: false });
      await ctx.reply('Filter set: Token must not have mint authority.');
    } else if (input === 'no preference') {
      await updateUserSettings(userId, { requireMintAuthority: null });
      await ctx.reply('Mint authority filter removed.');
    } else {
      await ctx.reply('Please respond with "yes", "no", or "no preference".');
      return;
    }
    ctx.session.awaitingInputFor = undefined;
  }
};

/**
 * Handles the /set_top_holders command.
 * @param ctx - The context of the Telegram message.
 */
export const handleSetTopHoldersCommand = async (ctx: MyContext): Promise<void> => {
  if (!ctx.session.awaitingInputFor) {
    await ctx.reply('Enter the maximum allowed concentration percentage among top 10 holders (0-100):');
    ctx.session.awaitingInputFor = 'set_top_holders';
  } else {
    const input = ctx.message?.text?.trim();
    const userId = ctx.from?.id;

    if (!userId || input === undefined) {
      await ctx.reply('Unable to process your request.');
      ctx.session.awaitingInputFor = undefined;
      return;
    }

    const value = parseFloat(input);
    if (isNaN(value) || value < 0 || value > 100) {
      await ctx.reply('Please enter a valid percentage between 0 and 100.');
      return;
    }
    await updateUserSettings(userId, { topHoldersThreshold: value });
    await ctx.reply(`Top holders concentration threshold set to ${value}%.`);
    ctx.session.awaitingInputFor = undefined;
  }
};

/**
 * Displays the current filters set by the user.
 * @param ctx - The context of the Telegram message.
 */
export const handleShowFiltersCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    const settings = await getUserSettings(userId);

    const liquidityThresholdText =
      settings.liquidityThreshold !== null ? `${settings.liquidityThreshold} SOL` : 'No minimum';
    const requireMintAuthorityText =
      settings.requireMintAuthority === true
        ? 'Yes'
        : settings.requireMintAuthority === false
        ? 'No'
        : 'No preference';
    const topHoldersThresholdText =
      settings.topHoldersThreshold !== null ? `${settings.topHoldersThreshold}%` : 'No limit';

    const filters = `<b>Your current filters are:</b>
- <b>Liquidity Threshold:</b> ${liquidityThresholdText}
- <b>Mint Authority Required:</b> ${requireMintAuthorityText}
- <b>Top Holders Concentration Threshold:</b> ${topHoldersThresholdText}`;

    await ctx.reply(filters, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error showing filters for user ${userId}:`, error);
    await ctx.reply('Unable to retrieve your filters at this time.');
  }
};

/**
 * Starts the token listener for a user.
 * @param ctx - The context of the Telegram message.
 */
export const handleStartListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    // Start the listener for this user
    await startTokenListener(userId);
    await ctx.reply('📡 Token detection has been started.');
  } catch (error) {
    console.error(`Error starting token listener for user ${userId}:`, error);
    await ctx.reply('Failed to start token detection. Please try again later.');
  }
};

/**
 * Stops the token listener for a user.
 * @param ctx - The context of the Telegram message.
 */
export const handleStopListenerCommand = async (ctx: MyContext): Promise<void> => {
  const userId = ctx.from?.id;

  if (!userId) {
    await ctx.reply('Unable to retrieve user information.');
    return;
  }

  try {
    await stopTokenListener(userId);
    await ctx.reply('📡 Token detection has been stopped.');
  } catch (error) {
    console.error(`Error stopping token listener for user ${userId}:`, error);
    await ctx.reply('Failed to stop token detection. Please try again later.');
  }
};
