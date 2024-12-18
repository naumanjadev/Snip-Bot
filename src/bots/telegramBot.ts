// src/bot.ts

import { Bot, session } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  handleWalletCommand,
  handleDeleteWalletCommand,
  handleMainMenuCommand,
  handleExportWalletCommand,
  handleWithdrawCommand,
  handleConfirmWithdraw,
  handleCancel,
  handleWithdrawAmountInput,
} from '../controllers/walletController';
import {
  handleSetLiquidityCommand,
  handleSetMintAuthorityCommand,
  handleSetTopHoldersCommand,
  handleStartListenerCommand,
  handleStopListenerCommand,
  handleAutoBuyCommand,
  handleShowFiltersCommand,
} from '../controllers/filterController';
import { PublicKey } from '@solana/web3.js';
import { MyContext, SessionData } from '../types';

type MySession = SessionData;

/**
 * Sends a notification to the current user.
 * @param ctx - The context from which to derive the chat ID.
 * @param message - The message to send to the user.
 */
export const notifyUser = async (ctx: MyContext, message: string): Promise<void> => {
  if (!ctx.chat || !ctx.chat.id) {
    logger.warn(`No chat id found for user ${ctx.from?.id}, cannot send notification.`);
    return;
  }
  try {
    await ctx.api.sendMessage(ctx.chat.id, message);
  } catch (error) {
    logger.error(`Error sending notification to user ${ctx.from?.id}:`, error);
  }
};

/**
 * Creates and configures the Telegram bot.
 * @returns An instance of the configured bot.
 */
export const createBot = (): Bot<MyContext> => {
  if (!config.telegramBotToken) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in the environment variables.');
    process.exit(1);
  }

  const bot = new Bot<MyContext>(config.telegramBotToken);

  bot.use(session({ initial: (): MySession => ({}) }));

  bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
      ctx.session.awaitingInputFor = undefined;
      const currentCommand = ctx.message.text.split(' ')[0];
      const confirmationCommands = ['/cancel', '/confirm_withdraw'];
      if (!confirmationCommands.includes(currentCommand)) {
        ctx.session.awaitingConfirmation = undefined;
      }
      ctx.session.withdrawAddress = undefined;
      ctx.session.withdrawAmount = undefined;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const welcomeMessage = `
👋 <b>Welcome to the Solana Trading Bot!</b>

Please choose an option:
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/help - Show available commands
    `;
    await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
    logger.info(`User ${ctx.from?.id} started the bot.`);
  });

  // /help command handler
  bot.command('help', async (ctx) => {
    const helpMessage = `
❓ <b>Available Commands</b>
/start - Start the bot and see options
/wallet - Manage your Solana wallet
/set_filters - Set token filters
/show_filters - Show current filters
/start_listener - Start token detection
/stop_listener - Stop token detection
/delete_wallet - Delete your Solana wallet
/main_menu - Go back to the main menu
    `;
    await ctx.reply(helpMessage, { parse_mode: 'HTML' });
  });

  // Wallet commands
  bot.command('wallet', handleWalletCommand);
  bot.command('delete_wallet', handleDeleteWalletCommand);
  bot.command('export_wallet', handleExportWalletCommand);
  bot.command('withdraw', handleWithdrawCommand);
  bot.command('cancel', handleCancel);
  bot.command('main_menu', handleMainMenuCommand);

  // Filter commands with aliases
  bot.command(['set_filters', 'setfilters'], async (ctx) => {
    const message = `
🔧 <b>Set Token Filters</b>

Please choose a filter to set:
/set_liquidity - Set liquidity threshold
/set_mint_authority - Set mint authority requirement
/set_auto_buy - Set auto-buy preference
/set_top_holders - Set top holders concentration threshold
    `;
    await ctx.reply(message, { parse_mode: 'HTML' });
  });

  bot.command(['set_liquidity', 'setliquidity'], handleSetLiquidityCommand);
  bot.command(['set_mint_authority', 'setmintauthority'], handleSetMintAuthorityCommand);
  bot.command(['set_top_holders', 'settopholders'], handleSetTopHoldersCommand);
  bot.command(['show_filters', 'showfilters'], handleShowFiltersCommand);
  bot.command(['set_auto_buy', 'setautobuy'], handleAutoBuyCommand);

  // Listener commands with aliases
  bot.command(['start_listener', 'startlistener'], handleStartListenerCommand);
  bot.command(['stop_listener', 'stoplistener'], handleStopListenerCommand);

  // Handle text input for setting filters and confirmations
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      return;
    }

    const { awaitingInputFor, awaitingConfirmation } = ctx.session;

    if (awaitingInputFor || awaitingConfirmation) {
      if (awaitingInputFor === 'set_liquidity') {
        await handleSetLiquidityCommand(ctx);
      } else if (awaitingInputFor === 'set_mint_authority') {
        await handleSetMintAuthorityCommand(ctx);
      } else if (awaitingInputFor === 'set_top_holders') {
        await handleSetTopHoldersCommand(ctx);
      } else if (awaitingInputFor === 'set_auto_buy') {
        await handleAutoBuyCommand(ctx);
      } else if (awaitingInputFor === 'withdraw_address') {
        const input = ctx.message.text.trim();
        try {
          new PublicKey(input);
          ctx.session.withdrawAddress = input;
          ctx.session.awaitingInputFor = 'withdraw_amount';
          await ctx.reply('💰 Please enter the amount of SOL you want to withdraw:');
        } catch (error) {
          await ctx.reply('❌ Invalid Solana address. Please enter a valid Solana wallet address:');
        }
      } else if (awaitingInputFor === 'withdraw_amount') {
        await handleWithdrawAmountInput(ctx);
      } else if (awaitingConfirmation === 'withdraw') {
        const input = ctx.message.text.trim().toLowerCase();
        if (input === 'yes') {
          await handleConfirmWithdraw(ctx);
        } else {
          await ctx.reply('Withdrawal cancelled.');
          ctx.session.awaitingConfirmation = undefined;
        }
      } else if (awaitingConfirmation === 'delete_wallet') {
        await handleDeleteWalletCommand(ctx);
      } else if (awaitingConfirmation === 'export_wallet') {
        await handleExportWalletCommand(ctx);
      } else {
        ctx.session.awaitingInputFor = undefined;
        ctx.session.awaitingConfirmation = undefined;
        await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
      }
    } else {
      await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text && text.startsWith('/')) {
      await ctx.reply('❌ Unknown command. Type /help to see the list of available commands.');
    } else {
      await ctx.reply('❗️ Please use the available commands. Type /help to see the list of commands.');
    }
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error(`Error while handling update ${ctx.update.update_id}: ${(err.error as Error).message}`);
  });

  return bot;
};

export const notifyUserById = async (userId: number, message: string): Promise<void> => {
  try {
    await botInstance.api.sendMessage(userId, message, { parse_mode: 'HTML' });
  } catch (error) {
    logger.error(`Error sending message to user ${userId}:`, error);
  }
};

export const botInstance = createBot();
