import express, { type Request, type Response } from 'express';
import dotenv from 'dotenv';
import { launchBot } from './bot.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', message: 'Daily News Bot Server is running' });
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.send('Telegram Daily News Bot is online.');
});

// Start Express server
const server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  
  // Launch the Telegram bot
  launchBot();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
