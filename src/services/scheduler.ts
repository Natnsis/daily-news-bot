import cron from 'node-cron';
import { fetchTopHeadlines, formatNewsMessage } from './newsService.js';
import { DateTime } from 'luxon';
import { Telegraf } from 'telegraf';
import { prisma } from '../lib/prisma.js';

export function startScheduler(bot: Telegraf<any>) {
  // Run every hour at the top of the hour
  cron.schedule('0 * * * *', async () => {
    console.log('Running scheduled news check...');
    
    // Iterate through all active channels and check their local time
    const channels = await prisma.channelConfig.findMany({
      where: { isActive: true }
    });

    for (const channel of channels) {
      const { id, scheduledHours, timezone, categories } = channel;
      
      // Check local time for the channel
      const localNow = DateTime.now().setZone(timezone || 'UTC');
      const currentHour = localNow.hour;

      if (scheduledHours.includes(currentHour)) {
        console.log(`Posting news to channel ${id} for hour ${currentHour}`);
        
        // Fetch news for a random selected category
        const category = categories[Math.floor(Math.random() * categories.length)] || 'general';
        
        try {
          const articles = await fetchTopHeadlines(category);
          const message = formatNewsMessage(articles, category);
          
          await bot.telegram.sendMessage(id, message, { 
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: false }
          });
          
          // Update last posted time
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
