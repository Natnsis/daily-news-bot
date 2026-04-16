import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const NEWS_API_BASE_URL = 'https://newsapi.org/v2';
const API_KEY = process.env.NEWS_API_KEY;

export interface Article {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}

export async function fetchTopHeadlines(category: string = 'general', country: string = 'us', pageSize: number = 5): Promise<Article[]> {
  try {
    const response = await axios.get(`${NEWS_API_BASE_URL}/top-headlines`, {
      params: {
        category,
        country,
        pageSize,
        apiKey: API_KEY,
      },
    });

    if (response.data.status !== 'ok') {
      throw new Error(`NewsAPI Error: ${response.data.message}`);
    }

    return response.data.articles.map((article: any) => ({
      title: article.title,
      description: article.description,
      url: article.url,
      source: article.source.name,
      publishedAt: article.publishedAt,
    }));
  } catch (error: any) {
    console.error('Error fetching news:', error.message);
    return [];
  }
}

export function formatNewsMessage(articles: Article[], category: string): string {
  if (articles.length === 0) {
    return `No news found for category: *${category}*.`;
  }

  let message = `🗞 *Daily News: ${category.charAt(0).toUpperCase() + category.slice(1)}*\n\n`;

  articles.forEach((article, index) => {
    message += `${index + 1}. [${article.title}](${article.url})\n`;
    message += `_Source: ${article.source}_\n\n`;
  });

  return message;
}
