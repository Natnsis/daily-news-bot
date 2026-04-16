import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const NEWS_API_BASE_URL = "https://newsapi.org/v2";
const DEVTO_API_BASE_URL = "https://dev.to/api";
const API_KEY = process.env.NEWS_API_KEY;
const DEVTO_TAGS = ["javascript", "webdev", "programming", "devops", "ai"];

export type NewsSource = "newsapi" | "devto";

export interface Article {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
}

export interface FetchArticlesOptions {
  category?: string;
  page?: number;
  pageSize?: number;
}

export async function findArticlesToPost(
  source: NewsSource,
  category: string,
  sentArticleUrls: string[],
  desiredCount = 5,
): Promise<Article[]> {
  const sentUrlSet = new Set(sentArticleUrls);
  const selected: Article[] = [];

  for (let page = 1; page <= 3 && selected.length < desiredCount; page += 1) {
    const batch = await fetchArticles(source, {
      category,
      page,
      pageSize: 10,
    });

    for (const article of batch) {
      if (sentUrlSet.has(article.url)) {
        continue;
      }

      sentUrlSet.add(article.url);
      selected.push(article);

      if (selected.length >= desiredCount) {
        break;
      }
    }
  }

  return selected;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function trimText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function getAvailableCategories(source: NewsSource): string[] {
  if (source === "devto") {
    return ["technology"];
  }

  return [
    "business",
    "entertainment",
    "general",
    "health",
    "science",
    "sports",
    "technology",
  ];
}

export function normalizeSource(source: string | null | undefined): NewsSource {
  return source === "devto" ? "devto" : "newsapi";
}

export async function fetchArticles(
  source: NewsSource,
  options: FetchArticlesOptions = {},
): Promise<Article[]> {
  if (source === "devto") {
    return fetchDevToArticles(options.page ?? 1, options.pageSize ?? 10);
  }

  return fetchTopHeadlines(
    options.category ?? "general",
    "us",
    options.pageSize ?? 10,
    options.page ?? 1,
  );
}

export async function fetchTopHeadlines(
  category = "general",
  country = "us",
  pageSize = 10,
  page = 1,
): Promise<Article[]> {
  try {
    const response = await axios.get(`${NEWS_API_BASE_URL}/top-headlines`, {
      params: {
        category,
        country,
        page,
        pageSize,
        apiKey: API_KEY,
      },
    });

    if (response.data.status !== "ok") {
      throw new Error(`NewsAPI Error: ${response.data.message}`);
    }

    return (response.data.articles as Array<Record<string, unknown>>)
      .map((article) => ({
        title: normalizeText(String(article.title ?? "")),
        description: trimText(
          normalizeText(String(article.description ?? article.content ?? "")),
          220,
        ),
        url: normalizeText(String(article.url ?? "")),
        source: normalizeText(
          String(
            typeof article.source === "object" &&
              article.source !== null &&
              "name" in article.source
              ? (article.source as { name?: unknown }).name ?? "NewsAPI"
              : "NewsAPI",
          ),
        ),
        publishedAt: normalizeText(String(article.publishedAt ?? "")),
      }))
      .filter((article) => article.title && article.url);
  } catch (error: any) {
    console.error("Error fetching NewsAPI articles:", error.message);
    return [];
  }
}

export async function fetchDevToArticles(
  page = 1,
  pageSize = 10,
): Promise<Article[]> {
  try {
    const response = await axios.get(`${DEVTO_API_BASE_URL}/articles`, {
      params: {
        page,
        per_page: pageSize,
        tags: DEVTO_TAGS.join(","),
      },
    });

    return (response.data as Array<Record<string, unknown>>)
      .map((article) => ({
        title: normalizeText(String(article.title ?? "")),
        description: trimText(
          normalizeText(String(article.description ?? "")),
          220,
        ),
        url: normalizeText(String(article.url ?? "")),
        source: "DEV Community",
        publishedAt: normalizeText(
          String(article.published_at ?? article.readable_publish_date ?? ""),
        ),
      }))
      .filter((article) => article.title && article.url);
  } catch (error: any) {
    console.error("Error fetching DEV articles:", error.message);
    return [];
  }
}

export function formatNoNewsMessage(
  source: NewsSource,
  category: string,
  channelName: string,
): string {
  const sourceName = source === "devto" ? "DEV Community" : "NewsAPI";
  return `Nothing was posted to ${channelName} because ${sourceName} had no unsent ${category} stories available right now.`;
}

export function formatNewsMessage(
  articles: Article[],
  category: string,
  source: NewsSource,
): string {
  const headerCategory =
    category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
  const sourceName = source === "devto" ? "DEV Community" : "NewsAPI";
  const lines = [`Daily ${headerCategory} Update`, `Source: ${sourceName}`, ""];

  articles.slice(0, 5).forEach((article, index) => {
    lines.push(`${index + 1}. ${article.title}`);
    if (article.description) {
      lines.push(`   ${article.description}`);
    }
    lines.push(`   From: ${article.source}`);
    lines.push(`   Read: ${article.url}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}
