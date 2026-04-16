import cron from 'node-cron';
import { fetchTopHeadlines, formatNewsMessage } from './newsService.js';
import { DateTime } from 'luxon';
import { Telegraf } from 'telegraf';
import { prisma } from '../lib/prisma.js';

export function startScheduler(bot: Telegraf<any>) {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    const now = DateTime.now();
    
    // Get all active channels
    const channels = await prisma.channelConfig.findMany({
      where: { isActive: true }
    });

    for (const channel of channels) {
      const { id, scheduledTimes, isRandom, postsPerDay, timezone, categories, lastPostedAt } = channel;
      const localNow = now.setZone(timezone || 'UTC');
      const timeStr = localNow.toFormat('HH:mm');
      
      // 1. Daily Random Time Generation
      // If random is enabled and we haven't generated times yet today (or they are empty)
      let currentScheduledTimes = [...scheduledTimes];
      
      // Reset/Generate random times if it's the start of the day and we are in random mode
      // or if we have 0 times and are in random mode
      const isNewDay = lastPostedAt ? localNow.startOf('day') > DateTime.fromJSDate(lastPostedAt).setZone(timezone || 'UTC').startOf('day') : true;

      if (isRandom && (isNewDay || currentScheduledTimes.length === 0)) {
        console.log(`Generating ${postsPerDay} random times for channel ${id}`);
        currentScheduledTimes = generateRandomTimes(postsPerDay);
        
        await prisma.channelConfig.update({
          where: { id },
          data: { scheduledTimes: currentScheduledTimes }
        });
      }

      // 2. Check if we should post now
      if (currentScheduledTimes.includes(timeStr)) {
        // Prevent double posting in the same minute
        if (lastPostedAt && DateTime.fromJSDate(lastPostedAt).toFormat('HH:mm') === timeStr && 
            DateTime.fromJSDate(lastPostedAt).hasSame(localNow, 'day')) {
          continue;
        }

        console.log(`Posting news to channel ${id} at ${timeStr}`);
        
        const category = categories[Math.floor(Math.random() * categories.length)] || 'general';
        
        try {
          const articles = await fetchTopHeadlines(category);
          const message = formatNewsMessage(articles, category);
          
          await bot.telegram.sendMessage(id, message, { 
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: false }
          });
          
          await prisma.channelConfig.update({
            where: { id },
            data: { lastPostedAt: new Date() }
          });
        } catch (err: any) {
          console.error(`Failed to post to channel ${id}:`, err.message);
        }
      }
    }
  });
}

function generateRandomTimes(count: number): string[] {
  const times: string[] = [];
  for (let i = 0; i < count; i++) {
    const hour = Math.floor(Math.random() * 24);
    const minute = Math.floor(Math.random() * 60);
    const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    if (!times.includes(time)) {
      times.push(time);
    } else {
      i--; // Retry
    }
  }
  return times.sort();
}
