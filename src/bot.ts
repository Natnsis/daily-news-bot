import { Telegraf, Markup, Context } from "telegraf";
import dotenv from "dotenv";
import { prisma } from "./lib/prisma.js";
import { startScheduler } from "./services/scheduler.js";
import {
  findArticlesToPost,
  formatNewsMessage,
  formatNoNewsMessage,
  getAvailableCategories,
  normalizeSource,
  type NewsSource,
} from "./services/newsService.js";

dotenv.config();

const bot = new Telegraf<Context>(process.env.TELEGRAM_BOT_TOKEN!);

// State management for setup wizard
interface SetupState {
  step:
    | "AWAITING_CHANNEL"
    | "AWAITING_SOURCE"
    | "AWAITING_CATEGORIES"
    | "AWAITING_TIMING_TYPE"
    | "AWAITING_SPECIFIC_TIMES"
    | "AWAITING_FREQUENCY";
  channelId?: string;
  channelName?: string;
  source?: NewsSource;
  categories: string[];
  isRandom?: boolean;
  scheduledTimes: string[];
  postsPerDay: number;
}

interface StoredChannelConfig {
  id: string;
  name: string | null;
  ownerId: bigint;
  source?: string | null;
  categories: string[];
  sentArticleUrls?: string[];
  scheduledTimes: string[];
  postsPerDay: number;
  isRandom: boolean;
  timezone: string;
  lastPostedAt: Date | null;
  nextRunAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const userStates = new Map<number, SetupState>();

function getSourceLabel(source: NewsSource): string {
  return source === "devto" ? "DEV Community" : "NewsAPI";
}

function getConfiguredCategories(source: NewsSource, categories: string[]): string[] {
  if (source === "devto") {
    return ["technology"];
  }

  const allowed = new Set(getAvailableCategories(source));
  const filtered = categories.filter((category) => allowed.has(category));
  return filtered.length > 0 ? filtered : ["general"];
}

function selectCategory(source: NewsSource, categories: string[]): string {
  const configuredCategories = getConfiguredCategories(source, categories);
  return (
    configuredCategories[
      Math.floor(Math.random() * configuredCategories.length)
    ] ?? "general"
  );
}

function buildSourceKeyboard(selectedSource?: NewsSource) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${selectedSource === "newsapi" ? "✅ " : ""}NewsAPI`,
        "setup_source_newsapi",
      ),
    ],
    [
      Markup.button.callback(
        `${selectedSource === "devto" ? "✅ " : ""}DEV Community`,
        "setup_source_devto",
      ),
    ],
  ]);
}

function buildCategoryKeyboard(source: NewsSource, selectedCategories: string[]) {
  const buttons = getAvailableCategories(source).map((category) => {
    const isSelected = selectedCategories.includes(category);
    return Markup.button.callback(
      `${isSelected ? "✅ " : ""}${category}`,
      `setup_toggle_${category}`,
    );
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([
    Markup.button.callback("✅ Done Selecting", "setup_categories_done"),
  ]);

  return Markup.inlineKeyboard(rows);
}

// Welcome message
bot.start((ctx) => {
  ctx.reply(
    "👋 Welcome to the Daily News Bot!\n\nI can post news updates to your channels at scheduled times.\n\nType /setup to start configuring a new channel. \nType /config to manage your channels.",
  );
});

// Setup command
bot.command("setup", async (ctx) => {
  const userId = ctx.from.id;
  userStates.set(userId, {
    step: "AWAITING_CHANNEL",
    categories: [],
    scheduledTimes: [],
    postsPerDay: 1,
  });

  ctx.reply(
    "🚀 Let's set up your channel!\n\nPlease **forward a message** from the channel here, or send the channel **username** (e.g., @mychannel).",
    { parse_mode: "Markdown" },
  );
});

bot.command("config", async (ctx) => {
  const userId = ctx.from.id;
  const configs = await prisma.channelConfig.findMany({
    where: { ownerId: BigInt(userId) },
  });

  if (configs.length === 0) {
    return ctx.reply("No channels configured yet. Use /setup to add one.");
  }

  const buttons = configs.map((c) => [
    Markup.button.callback(`📺 ${c.name || c.id}`, `manage_${c.id}`),
  ]);
  ctx.reply(
    "🛠 Your Configured Channels:\nSelect a channel to manage:",
    Markup.inlineKeyboard(buttons),
  );
});

bot.action(/manage_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  const config = (await prisma.channelConfig.findUnique({
    where: { id: channelId },
  })) as StoredChannelConfig | null;
  if (!config) {
    return ctx.answerCbQuery("Config not found.");
  }

  const message =
    `⚙️ **Managing: ${config.name ?? config.id}**\n\n` +
    `Source: ${getSourceLabel(normalizeSource(config.source))}\n` +
    `Categories: ${config.categories.join(", ")}\n` +
    `Timing: ${config.isRandom ? "🎲 Random" : "🕒 " + config.scheduledTimes.join(", ")}\n` +
    `Frequency: ${config.postsPerDay} per day\n` +
    `Status: ${config.isActive ? "✅ Active" : "❌ Inactive"}`;

  ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📰 Change Source", `edit_source_${channelId}`)],
      [Markup.button.callback("📂 Change Categories", `edit_cat_${channelId}`)],
      [Markup.button.callback("⏰ Change Timing", `edit_time_${channelId}`)],
      [
        Markup.button.callback(
          "🗑 Delete Config",
          `confirm_delete_${channelId}`,
        ),
      ],
      [Markup.button.callback("⬅️ Back to List", "config")],
    ]),
  });
});

bot.action(/confirm_delete_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  ctx.editMessageText(
    "⚠️ Are you sure you want to delete this configuration?",
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Yes, Delete", `delete_final_${channelId}`)],
      [Markup.button.callback("⬅️ Cancel", `manage_${channelId}`)],
    ]),
  );
});

bot.action(/delete_final_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  await prisma.channelConfig.delete({ where: { id: channelId } });
  ctx.answerCbQuery("Configuration deleted.");
  ctx.editMessageText("✅ Configuration removed successfully.");
});

bot.action(/edit_cat_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  const config = (await prisma.channelConfig.findUnique({
    where: { id: channelId },
  })) as StoredChannelConfig | null;
  if (!config) return;

  const source = normalizeSource(config.source);
  if (source === "devto") {
    await ctx.answerCbQuery(
      "DEV Community posts are technology-only. Change source to unlock other categories.",
    );
    return;
  }

  const userId = ctx.from!.id;
  userStates.set(userId, {
    step: "AWAITING_CATEGORIES",
    channelId: config.id,
    channelName: config.name ?? config.id,
    source,
    categories: getConfiguredCategories(source, config.categories),
    scheduledTimes: config.scheduledTimes,
    postsPerDay: config.postsPerDay,
    isRandom: config.isRandom,
  });

  await ctx.editMessageText(
    "Select news categories:",
    buildCategoryKeyboard(source, getConfiguredCategories(source, config.categories)),
  );
});

bot.action(/edit_source_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  const config = (await prisma.channelConfig.findUnique({
    where: { id: channelId },
  })) as StoredChannelConfig | null;
  if (!config) return;

  const userId = ctx.from!.id;
  const source = normalizeSource(config.source);
  userStates.set(userId, {
    step: "AWAITING_SOURCE",
    channelId: config.id,
    channelName: config.name ?? config.id,
    source,
    categories: getConfiguredCategories(source, config.categories),
    scheduledTimes: config.scheduledTimes,
    postsPerDay: config.postsPerDay,
    isRandom: config.isRandom,
  });

  await ctx.editMessageText(
    "Choose the news source for this channel:",
    buildSourceKeyboard(source),
  );
});

bot.action(/edit_time_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  const config = (await prisma.channelConfig.findUnique({
    where: { id: channelId },
  })) as StoredChannelConfig | null;
  if (!config) return;

  if (!config) return;

  const userId = ctx.from!.id;
  const source = normalizeSource(config.source);
  userStates.set(userId, {
    step: "AWAITING_TIMING_TYPE",
    channelId: config.id,
    channelName: config.name ?? config.id,
    source,
    categories: getConfiguredCategories(source, config.categories),
    scheduledTimes: config.scheduledTimes,
    postsPerDay: config.postsPerDay,
    isRandom: config.isRandom,
  });

  await ctx.editMessageText(
    "⏰ How would you like the posts to be timed?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🕒 Specific Times", "timing_specific")],
      [Markup.button.callback("🎲 Random Times", "timing_random")],
    ]),
  );
});

bot.action("config", async (ctx) => {
  const userId = ctx.from!.id;
  const configs = await prisma.channelConfig.findMany({
    where: { ownerId: BigInt(userId) },
  });

  if (configs.length === 0) {
    return ctx.editMessageText(
      "No channels configured yet. Use /setup to add one.",
    );
  }

  const buttons = configs.map((c) => [
    Markup.button.callback(`📺 ${c.name || c.id}`, `manage_${c.id}`),
  ]);
  ctx.editMessageText(
    "🛠 Your Configured Channels:\nSelect a channel to manage:",
    Markup.inlineKeyboard(buttons),
  );
});

bot.action("setup_new", async (ctx) => {
  const userId = ctx.from!.id;
  userStates.set(userId, {
    step: "AWAITING_CHANNEL",
    categories: [],
    scheduledTimes: [],
    postsPerDay: 1,
  });

  ctx.editMessageText(
    "🚀 Let's set up your channel!\n\nPlease **forward a message** from the channel here, or send the channel **username** (e.g., @mychannel).",
  );
});

// Test command to send news instantly
bot.command("test", async (ctx) => {
  const userId = ctx.from.id;
  const configs = await prisma.channelConfig.findMany({
    where: { ownerId: BigInt(userId) },
  });

  if (configs.length === 0) {
    return ctx.reply("No channels configured. Use /setup first.");
  }

  if (configs.length === 1) {
    const config = configs[0];
    if (!config) return;
    await ctx.reply(`🚀 Sending an instant news post to **${config.name ?? config.id}**...`, {
      parse_mode: "Markdown",
    });
    return triggerNewsPost(ctx, config.id);
  }

  const buttons = configs.map((c) => [
    Markup.button.callback(`📢 Test ${c.name || c.id}`, `trigger_post_${c.id}`),
  ]);

  ctx.reply(
    "🧪 **Instant Test Post**\nSelect a channel to send sample news now:",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    },
  );
});

async function triggerNewsPost(ctx: Context, channelId: string) {
  const config = (await prisma.channelConfig.findUnique({
    where: { id: channelId },
  })) as StoredChannelConfig | null;
  if (!config) {
    return ctx.reply("❌ Configuration not found.");
  }

  const source = normalizeSource(config.source);
  const category = selectCategory(source, config.categories);
  const articles = await findArticlesToPost(
    source,
    category,
    config.sentArticleUrls ?? [],
  );

  if (articles.length === 0) {
    const noNewsMessage = formatNoNewsMessage(
      source,
      category,
      config.name ?? config.id,
    );
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("No news found. Nothing was posted.");
    }
    await ctx.reply(noNewsMessage);
    return;
  }

  const message = formatNewsMessage(articles, category, source);

  try {
    await ctx.telegram.sendMessage(channelId, message, {
      link_preview_options: { is_disabled: true },
    });

    await (prisma.channelConfig as any).update({
      where: { id: channelId },
      data: {
        lastPostedAt: new Date(),
        sentArticleUrls: [
          ...new Set([...(config.sentArticleUrls ?? []), ...articles.map((article) => article.url)]),
        ].slice(-200),
      },
    });

    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("News posted!");
    }
    await ctx.reply(`Posted ${articles.length} story${articles.length === 1 ? "" : "ies"} to ${config.name ?? config.id}.`);
  } catch (err: any) {
    const errorMsg = `❌ Failed to post news: ${err.message}`;
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(errorMsg);
    }
    await ctx.reply(errorMsg);
  }
}

bot.action(/trigger_post_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  if (channelId) {
    await triggerNewsPost(ctx, channelId);
  }
});

// Handle text and forwarded messages for channel identification
bot.on(["text", "forward_date"], async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const state = userStates.get(userId);
  if (!state) return;

  if (state.step === "AWAITING_CHANNEL") {
    let channelId: string | undefined;
    let channelName: string | undefined;

    const msg = ctx.message as any;
    if (!msg) return;

    if (msg.forward_from_chat) {
      const chat = msg.forward_from_chat;
      if (chat.type === "channel") {
        channelId = chat.id.toString();
        channelName = chat.title || chat.id.toString();
      }
    } else if (msg.text) {
      const text = msg.text;
      try {
        const chat = await ctx.telegram.getChat(text);
        if (chat.type === "channel") {
          channelId = chat.id.toString();
          channelName = (chat as any).title || chat.id.toString();
        }
      } catch (err) {
        return ctx.reply(
          "❌ Could not find that channel. Make sure it\'s public and I am added to it.",
        );
      }
    }

    if (channelId) {
      // Check if already exists
      const existing = await prisma.channelConfig.findUnique({
        where: { id: channelId },
      });
      if (existing) {
        return ctx.reply(
          `⚠️ **${existing.name ?? existing.id}** is already configured.\n\nWould you like to manage its settings instead?`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "⚙️ Manage Settings",
                  `manage_${channelId}`,
                ),
              ],
              [Markup.button.callback("🔄 Start Over", "setup_new")],
            ]),
          },
        );
      }
      // Check admin permissions
      try {
        const member = await ctx.telegram.getChatMember(
          channelId,
          ctx.botInfo.id,
        );
        if (member.status !== "administrator") {
          return ctx.reply(
            `❌ I am in the channel but I am not an **administrator**. Please promote me and then send the username again.`,
            { parse_mode: "Markdown" },
          );
        }
      } catch (err) {
        return ctx.reply(
          "❌ I am not a member of that channel. Please add me as an administrator first.",
        );
      }

      state.channelId = channelId;
      state.channelName = channelName || channelId;
      state.step = "AWAITING_SOURCE";

      ctx.reply(
        `✅ Found channel: **${channelName || channelId}**\n\nChoose which source to use for this channel:`,
        {
          parse_mode: "Markdown",
          ...buildSourceKeyboard(state.source),
        },
      );
    } else {
      ctx.reply(
        "❌ That doesn't seem to be a channel. Please forward a message from a channel or send a username.",
      );
    }
  } else if (state.step === "AWAITING_SPECIFIC_TIMES") {
    if (ctx.message && "text" in ctx.message) {
      const parts = ctx.message.text
        .split(",")
        .map((t: string) => t.trim().toLowerCase());
      const validTimes: string[] = [];

      for (const part of parts) {
        // Try 24h format HH:mm
        if (/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(part)) {
          validTimes.push(part.padStart(5, "0"));
          continue;
        }

        // Try AM/PM format h:mm am/pm
        const ampmMatch = part.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
        if (ampmMatch) {
          const [, hourText, minute, period] = ampmMatch;
          if (!hourText || !minute || !period) {
            continue;
          }

          let hour = parseInt(hourText, 10);

          if (hour >= 1 && hour <= 12) {
            if (period === "pm" && hour < 12) hour += 12;
            if (period === "am" && hour === 12) hour = 0;

            const formatted = `${hour.toString().padStart(2, "0")}:${minute}`;
            validTimes.push(formatted);
            continue;
          }
        }
      }

      if (validTimes.length === 0) {
        return ctx.reply(
          "❌ Invalid format. Please enter times like `01:20 am`, `2:00 pm`, or `14:00`.",
          { parse_mode: "Markdown" },
        );
      }

      state.scheduledTimes = validTimes;
      state.postsPerDay = validTimes.length;
      state.isRandom = false;
      await saveConfiguration(ctx, userId, state);
    }
  } else if (state.step === "AWAITING_FREQUENCY") {
    if (ctx.message && "text" in ctx.message) {
      const freq = parseInt(ctx.message.text);
      if (isNaN(freq) || freq < 1 || freq > 20) {
        return ctx.reply("❌ Please enter a number between 1 and 20.");
      }
      state.postsPerDay = freq;
      state.isRandom = true;
      await saveConfiguration(ctx, userId, state);
    }
  }
});

// Handle Category Toggles
bot.action(/setup_source_(newsapi|devto)/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.answerCbQuery();

  const state = userStates.get(userId);
  if (!state || !state.channelId) {
    return ctx.answerCbQuery();
  }

  const source = ((ctx.match as RegExpExecArray)[1] ?? "newsapi") as NewsSource;
  state.source = source;

  if (source === "devto") {
    state.categories = ["technology"];
    state.step = "AWAITING_TIMING_TYPE";
    await ctx.editMessageText(
      "DEV Community selected.\n\nThis source is technology-focused, so the category is locked to `technology`.\n\nHow would you like the posts to be timed?",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🕒 Specific Times", "timing_specific")],
          [Markup.button.callback("🎲 Random Times", "timing_random")],
        ]),
      },
    );
    return ctx.answerCbQuery("DEV Community selected.");
  }

  state.categories = getConfiguredCategories(source, state.categories);
  state.step = "AWAITING_CATEGORIES";
  await ctx.editMessageText(
    `Source selected: ${getSourceLabel(source)}\n\nSelect the news categories for this channel:`,
    buildCategoryKeyboard(source, state.categories),
  );
  return ctx.answerCbQuery("NewsAPI selected.");
});

bot.action(/setup_toggle_(.+)/, async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state || state.step !== "AWAITING_CATEGORIES")
    return ctx.answerCbQuery();

  const category = (ctx.match as any)[1];
  const source = state.source ?? "newsapi";
  if (!getAvailableCategories(source).includes(category)) {
    return ctx.answerCbQuery("That category is not available for this source.");
  }

  if (state.categories.includes(category)) {
    state.categories = state.categories.filter((c) => c !== category);
  } else {
    state.categories.push(category);
  }

  await ctx.editMessageText(
    `Selected: ${state.categories.join(", ") || "None"}\n\nSelect news categories:`,
    buildCategoryKeyboard(source, state.categories),
  );
  ctx.answerCbQuery();
});

// Category Done -> Timing Type
bot.action("setup_categories_done", async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state || state.categories.length === 0)
    return ctx.answerCbQuery("Select at least one category!");

  state.categories = getConfiguredCategories(state.source ?? "newsapi", state.categories);

  state.step = "AWAITING_TIMING_TYPE";
  await ctx.editMessageText(
    "⏰ How would you like the posts to be timed?",
    Markup.inlineKeyboard([
      [Markup.button.callback("🕒 Specific Times", "timing_specific")],
      [Markup.button.callback("🎲 Random Times", "timing_random")],
    ]),
  );
  ctx.answerCbQuery();
});

bot.action("timing_specific", async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state) return;

  state.step = "AWAITING_SPECIFIC_TIMES";
  await ctx.editMessageText(
    "Enter the times for posting separated by commas.\nYou can use 24-hour format or AM/PM (e.g., `1:20 am, 2:00 pm, 20:30`):",
    { parse_mode: "Markdown" },
  );
});

bot.action("timing_random", async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state) return;

  state.step = "AWAITING_FREQUENCY";
  await ctx.editMessageText(
    "How many posts per day would you like? (Enter a number between 1 and 20):",
  );
});

async function saveConfiguration(
  ctx: Context,
  userId: number,
  state: SetupState,
) {
  const channelId = state.channelId;
  if (!channelId) return;

  const source = state.source ?? "newsapi";
  const categories = getConfiguredCategories(source, state.categories);

  try {
    await (prisma.channelConfig as any).upsert({
      where: { id: channelId },
      update: {
        name: state.channelName ?? null,
        ownerId: BigInt(userId),
        source,
        categories,
        scheduledTimes: state.scheduledTimes,
        postsPerDay: state.postsPerDay,
        isRandom: state.isRandom ?? false,
        timezone: process.env.DEFAULT_TIMEZONE || "UTC",
        isActive: true,
      },
      create: {
        id: channelId,
        name: state.channelName ?? null,
        ownerId: BigInt(userId),
        source,
        categories,
        scheduledTimes: state.scheduledTimes,
        postsPerDay: state.postsPerDay,
        isRandom: state.isRandom ?? false,
        timezone: process.env.DEFAULT_TIMEZONE || "UTC",
      },
    });

    userStates.delete(userId);
    await ctx.reply(
      `🎉 **Configuration saved!**\n\nChannel: ${state.channelName}\nSource: ${getSourceLabel(source)}\nCategories: ${categories.join(", ")}\nTiming: ${state.isRandom ? "Randomly" : state.scheduledTimes.join(", ")} (${state.postsPerDay} per day)\n\nI will start posting news shortly!`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📢 Post News Now", `trigger_post_${state.channelId}`)],
          [Markup.button.callback("⚙️ Manage Configuration", `manage_${state.channelId}`)]
        ])
      },
    );
  } catch (err: any) {
    console.error("Save failed:", err);
    const errorMessage = String(err?.message ?? "");
    const isPrismaSchemaMismatch =
      errorMessage.includes("Unknown argument `source`") ||
      errorMessage.includes("Unknown argument `sentArticleUrls`") ||
      errorMessage.includes("column") ||
      errorMessage.includes("does not exist");

    if (isPrismaSchemaMismatch) {
      await ctx.reply(
        "❌ Configuration could not be saved because Prisma is not synced with the latest schema yet.\n\nRun `npm run prisma:sync` and restart the bot, then try again.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.reply(`❌ Failed to save configuration: ${errorMessage}`);
  }
}


export function launchBot() {
  console.log("Attempting to launch Telegram bot...");
  bot
    .launch()
    .then(() => {
      console.log("Bot started successfully!");
      startScheduler(bot);
    })
    .catch((err) => {
      console.error("Failed to launch bot:", err);
    });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

export default bot;
