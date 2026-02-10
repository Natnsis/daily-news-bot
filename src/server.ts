import express from 'express';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
dotenv.config()

//bot
const bot = new Telegraf(process.env.TELEGRAM_TOKEN!)

//main paths
bot.start((ctx) => ctx.reply('welcome'))

bot.launch()




//app
const app = express();

app.listen(3000, () => {
  console.log('bot is running');
});
