import { Telegraf, Markup, Context } from "telegraf";
import dotenv from "dotenv";
import { prisma } from "./lib/prisma.js";
import { startScheduler } from "./services/scheduler.js";
import {
  fetchTopHeadlines,
  formatNewsMessage,
} from "./services/newsService.js";

dotenv.config();

const bot = new Telegraf<Context>(process.env.TELEGRAM_BOT_TOKEN!);

const NEWS_CATEGORIES = [
  "business",
  "entertainment",
  "general",
  "health",
  "science",
  "sports",
  "technology",
];

// State management for setup wizard
interface SetupState {
  step:
    | "AWAITING_CHANNEL"
    | "AWAITING_CATEGORIES"
    | "AWAITING_TIMING_TYPE"
    | "AWAITING_SPECIFIC_TIMES"
    | "AWAITING_FREQUENCY";
  channelId?: string;
  channelName?: string;
  categories: string[];
  isRandom?: boolean;
  scheduledTimes: string[];
  postsPerDay: number;
}

const userStates = new Map<number, SetupState>();

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
  const config = await prisma.channelConfig.findUnique({
    where: { id: channelId },
  });
  if (!config) return ctx.answerCbQuery("Config not found.");

  const message =
    `⚙️ **Managing: ${config.name}**\n\n` +
    `Categories: ${config.categories.join(", ")}\n` +
    `Timing: ${config.isRandom ? "🎲 Random" : "🕒 " + config.scheduledTimes.join(", ")}\n` +
    `Frequency: ${config.postsPerDay} per day\n` +
    `Status: ${config.isActive ? "✅ Active" : "❌ Inactive"}`;

  ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
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
  const config = await prisma.channelConfig.findUnique({
    where: { id: channelId },
  });
  if (!config) return;

  const userId = ctx.from!.id;
  userStates.set(userId, {
    step: "AWAITING_CATEGORIES",
    channelId: config.id,
    channelName: config.name || config.id,
    categories: config.categories,
    scheduledTimes: config.scheduledTimes,
    postsPerDay: config.postsPerDay,
    isRandom: config.isRandom,
  });

  const buttons = NEWS_CATEGORIES.map((cat) => {
    const isSelected = config.categories.includes(cat);
    return Markup.button.callback(
      `${isSelected ? "✅ " : ""}${cat}`,
      `setup_toggle_${cat}`,
    );
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push(buttons.slice(i, i + 2));
  rows.push([
    Markup.button.callback("✅ Done Selecting", "setup_categories_done"),
  ]);

  await ctx.editMessageText(
    "Select news categories:",
    Markup.inlineKeyboard(rows),
  );
});

bot.action(/edit_time_(.+)/, async (ctx) => {
  const channelId = (ctx.match as any)[1];
  const config = await prisma.channelConfig.findUnique({
    where: { id: channelId },
  });
  if (!config) return;

  const userId = ctx.from!.id;
  userStates.set(userId, {
    step: "AWAITING_TIMING_TYPE",
    channelId: config.id,
    channelName: config.name || config.id,
    categories: config.categories,
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
    await ctx.reply(`🚀 Sending an instant news post to **${config.name}**...`, {
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
  const config = await prisma.channelConfig.findUnique({
    where: { id: channelId },
  });
  if (!config) return ctx.reply("❌ Configuration not found.");

  const category =
    config.categories[Math.floor(Math.random() * config.categories.length)] ||
    "general";
  const articles = await fetchTopHeadlines(category);
  const message = formatNewsMessage(articles, category);

  try {
    await ctx.telegram.sendMessage(channelId, message, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: false },
    });
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("News posted!");
    }
    await ctx.reply(`✅ News successfully posted to **${config.name}**!`, {
      parse_mode: "Markdown",
    });
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
  await triggerNewsPost(ctx, channelId);
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

    if ("forward_from_chat" in ctx.message!) {
      const chat = ctx.message.forward_from_chat;
      if (chat?.type === "channel") {
        channelId = chat.id.toString();
        channelName = "title" in chat ? chat.title : chat.id.toString();
      }
    } else if ("text" in ctx.message!) {
      const text = ctx.message.text;
      try {
        const chat = await ctx.telegram.getChat(text);
        if (chat.type === "channel") {
          channelId = chat.id.toString();
          channelName = "title" in chat ? chat.title : chat.id.toString();
        }
      } catch (err) {
        return ctx.reply(
          "❌ Could not find that channel. Make sure it's public and I am added to it.",
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
          `⚠️ **${existing.name}** is already configured.\n\nWould you like to manage its settings instead?`,
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
      state.channelName = channelName;
      state.step = "AWAITING_CATEGORIES";

      const buttons = NEWS_CATEGORIES.map((cat) =>
        Markup.button.callback(cat, `setup_toggle_${cat}`),
      );
      const rows = [];
      for (let i = 0; i < buttons.length; i += 2)
        rows.push(buttons.slice(i, i + 2));
      rows.push([
        Markup.button.callback("✅ Done Selecting", "setup_categories_done"),
      ]);

      ctx.reply(
        `✅ Found channel: **${channelName}**\n\nNow, select the news categories you want to post:`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard(rows),
        },
      );
    } else {
      ctx.reply(
        "❌ That doesn't seem to be a channel. Please forward a message from a channel or send a username.",
      );
    }
  } else if (state.step === "AWAITING_SPECIFIC_TIMES") {
    if ("text" in ctx.message!) {
      const times = ctx.message.text.split(",").map((t) => t.trim());
      const validTimes = times.filter((t) =>
        /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(t),
      );

      if (validTimes.length === 0) {
        return ctx.reply(
          "❌ Please enter valid times in HH:mm format (e.g., 01:20, 14:00).",
        );
      }

      state.scheduledTimes = validTimes;
      state.postsPerDay = validTimes.length;
      state.isRandom = false;
      await saveConfiguration(ctx, userId, state);
    }
  } else if (state.step === "AWAITING_FREQUENCY") {
    if ("text" in ctx.message!) {
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
bot.action(/setup_toggle_(.+)/, async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state || state.step !== "AWAITING_CATEGORIES")
    return ctx.answerCbQuery();

  const category = (ctx.match as any)[1];
  if (state.categories.includes(category)) {
    state.categories = state.categories.filter((c) => c !== category);
  } else {
    state.categories.push(category);
  }

  const buttons = NEWS_CATEGORIES.map((cat) => {
    const isSelected = state.categories.includes(cat);
    return Markup.button.callback(
      `${isSelected ? "✅ " : ""}${cat}`,
      `setup_toggle_${cat}`,
    );
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2)
    rows.push(buttons.slice(i, i + 2));
  rows.push([
    Markup.button.callback("✅ Done Selecting", "setup_categories_done"),
  ]);

  await ctx.editMessageText(
    `Selected: ${state.categories.join(", ") || "None"}\n\nSelect news categories:`,
    Markup.inlineKeyboard(rows),
  );
  ctx.answerCbQuery();
});

// Category Done -> Timing Type
bot.action("setup_categories_done", async (ctx) => {
  const userId = ctx.from?.id;
  const state = userStates.get(userId);
  if (!state || state.categories.length === 0)
    return ctx.answerCbQuery("Select at least one category!");

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
    "Enter the times for posting separated by commas (e.g., `01:20, 14:00, 20:30`):",
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
  try {
    await prisma.channelConfig.upsert({
      where: { id: state.channelId },
      update: {
        name: state.channelName,
        ownerId: BigInt(userId),
        categories: state.categories,
        scheduledTimes: state.scheduledTimes,
        postsPerDay: state.postsPerDay,
        isRandom: state.isRandom,
        timezone: process.env.DEFAULT_TIMEZONE || "UTC",
        isActive: true,
      },
      create: {
        id: state.channelId!,
        name: state.channelName,
        ownerId: BigInt(userId),
        categories: state.categories,
        scheduledTimes: state.scheduledTimes,
        postsPerDay: state.postsPerDay,
        isRandom: state.isRandom,
        timezone: process.env.DEFAULT_TIMEZONE || "UTC",
      },
    });

    userStates.delete(userId);
    await ctx.reply(
      `🎉 **Configuration saved!**\n\nChannel: ${state.channelName}\nCategories: ${state.categories.join(", ")}\nTiming: ${state.isRandom ? "Randomly" : state.scheduledTimes.join(", ")} (${state.postsPerDay} per day)\n\nI will start posting news shortly!`,
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
    await ctx.reply(`❌ Failed to save configuration: ${err.message}`);
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
