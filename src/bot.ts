import { Telegraf, Markup, Context } from 'telegraf';
import dotenv from 'dotenv';
import { prisma } from './lib/prisma.js';
import { startScheduler } from './services/scheduler.js';
import { fetchTopHeadlines, formatNewsMessage } from './services/newsService.js';

dotenv.config();

const bot = new Telegraf<Context>(process.env.TELEGRAM_BOT_TOKEN!);

const NEWS_CATEGORIES = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];

// Welcome message
bot.start((ctx) => {
  ctx.reply('👋 Welcome to the Daily News Bot!\n\nI can post news updates to your channels at scheduled times.\n\nTo configure a channel, add me as an admin to the channel and run /setup in that channel.');
});

// Setup command (to be run in a channel)
bot.command('setup', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const chatType = ctx.chat?.type as string;

  if (chatType !== 'channel' && chatType !== 'group' && chatType !== 'supergroup') {
    return ctx.reply('Please run this command inside the channel or group you want to configure.');
  }

  try {
    const member = await ctx.getChatMember(ctx.botInfo.id);
    if (member.status !== 'administrator') {
      return ctx.reply('I need to be an administrator in this channel to post news.');
    }
  } catch (err) {
    return ctx.reply('Ensure I have administrator permissions in this channel.');
  }

  // Initialize or get config
  let config = await prisma.channelConfig.findUnique({ where: { id: chatId } });
  
  if (!config) {
    config = await prisma.channelConfig.create({
      data: {
        id: chatId,
        name: ('title' in ctx.chat ? ctx.chat.title : 'Unknown'),
        ownerId: BigInt(ctx.from!.id),
        categories: ['general'],
        scheduledHours: [9], // Default 9 AM
      }
    });
  }

  ctx.reply(`✅ Setup started for *${'title' in ctx.chat ? ctx.chat.title : 'Unknown'}*.\n\nPlease check your Private Messages to complete the configuration.`, { parse_mode: 'Markdown' });

  // Send configuration menu in DM
  const dmMessage = `Configure settings for channel: *${'title' in ctx.chat ? ctx.chat.title : 'Unknown'}*\n\n` +
    `Current Categories: ${config.categories.join(', ')}\n` +
    `Current Schedule: ${config.scheduledHours.map(h => h + ':00').join(', ')}\n` +
    `Timezone: ${config.timezone}`;

  await ctx.telegram.sendMessage(ctx.from!.id, dmMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📂 Select Categories', `config_categories_${chatId}`)],
      [Markup.button.callback('⏰ Set Timing', `config_timing_${chatId}`)],
      [Markup.button.callback('🌍 Set Timezone', `config_timezone_${chatId}`)],
      [Markup.button.callback('📢 Test Post Now', `test_post_${chatId}`)]
    ])
  });
});

// Handle Category Selection
bot.action(/config_categories_(.+)/, async (ctx) => {
  const chatId = (ctx.match as any)[1];
  const buttons = NEWS_CATEGORIES.map(cat => 
    Markup.button.callback(cat, `toggle_cat_${chatId}_${cat}`)
  );
  
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('⬅️ Back', `back_to_main_${chatId}`)]);

  await ctx.editMessageText('Select news categories (multiple allowed):', Markup.inlineKeyboard(rows));
});

// Toggle Category
bot.action(/toggle_cat_(.+)_(.+)/, async (ctx) => {
  const [_, chatId, category] = ctx.match as any;
  let config = await prisma.channelConfig.findUnique({ where: { id: chatId } });
  
  if (!config) return ctx.answerCbQuery('Config not found.');

  let newCategories = [...config.categories];
  if (newCategories.includes(category)) {
    newCategories = newCategories.filter(c => c !== category);
  } else {
    newCategories.push(category);
  }

  if (newCategories.length === 0) newCategories = ['general'];

  await prisma.channelConfig.update({
    where: { id: chatId },
    data: { categories: newCategories }
  });

  ctx.answerCbQuery(`Updated: ${category}`);
});

// Test Post
bot.action(/test_post_(.+)/, async (ctx) => {
  const chatId = (ctx.match as any)[1];
  ctx.answerCbQuery('Fetching news and posting...');
  
  const config = await prisma.channelConfig.findUnique({ where: { id: chatId } });
  if (!config) return ctx.reply('Configuration error.');

  const category = config.categories[0] || 'general';
  
  const articles = await fetchTopHeadlines(category);
  const message = formatNewsMessage(articles, category);
  
  try {
    await ctx.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown', link_preview_options: { is_disabled: false } });
    ctx.reply('✅ Test post sent successfully!');
  } catch (err: any) {
    ctx.reply(`❌ Failed to send post: ${err.message}`);
  }
});

export function launchBot() {
  console.log('Attempting to launch Telegram bot...');
  bot.launch().then(() => {
    console.log('Bot started successfully!');
    startScheduler(bot);
  }).catch((err) => {
    console.error('Failed to launch bot:', err);
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

export default bot;
