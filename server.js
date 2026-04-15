import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { XMLParser } from "fast-xml-parser";
import { Converter } from "opencc-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const SEED_SOURCES_FILE = path.join(DATA_DIR, "sources.json");
const IS_VERCEL = Boolean(process.env.VERCEL);
const RUNTIME_DATA_DIR = IS_VERCEL ? path.join("/tmp", "media_collect") : DATA_DIR;
const SOURCES_FILE = path.join(RUNTIME_DATA_DIR, "sources.json");
const STATE_FILE = path.join(RUNTIME_DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const REDIS_REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAS_REDIS = Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);
const STORAGE_NAMESPACE = process.env.MEDIA_COLLECT_NAMESPACE || "media_collect";
const SOURCES_KEY = `${STORAGE_NAMESPACE}:sources`;
const STATE_KEY = `${STORAGE_NAMESPACE}:state`;
const MAX_ITEMS = 500;
const RECENT_DAYS = 7;
const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});
const convertToTraditional = Converter({ from: "cn", to: "twp" });
let dataReadyPromise;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }

  try {
    await ensureDataReady();
    next();
  } catch (error) {
    next(error);
  }
});

async function ensureDataFiles() {
  if (HAS_REDIS) {
    await ensureRedisJson(SOURCES_KEY, await readSeedSources());
    await ensureRedisJson(STATE_KEY, defaultState());
    return;
  }

  await fs.mkdir(RUNTIME_DATA_DIR, { recursive: true });
  await ensureSourcesFile();
  await ensureJson(STATE_FILE, defaultState());
}

function defaultState() {
  return {
    items: [],
    readIds: [],
    lastRefresh: null,
    sourceErrors: {}
  };
}

async function readSeedSources() {
  try {
    const raw = await fs.readFile(SEED_SOURCES_FILE, "utf8");
    return raw.trim() ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function ensureSourcesFile() {
  try {
    await fs.access(SOURCES_FILE);
    return;
  } catch {
    try {
      const seed = await fs.readFile(SEED_SOURCES_FILE, "utf8");
      await fs.writeFile(SOURCES_FILE, seed.trim() ? seed : "[]\n");
    } catch {
      await fs.writeFile(SOURCES_FILE, "[]\n");
    }
  }
}

async function ensureJson(file, fallback) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, `${JSON.stringify(fallback, null, 2)}\n`);
  }
}

async function readJson(file, fallback) {
  if (HAS_REDIS) {
    return readRedisJson(keyForFile(file), fallback);
  }

  await ensureJson(file, fallback);
  const raw = await fs.readFile(file, "utf8");
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

async function writeJson(file, value) {
  if (HAS_REDIS) {
    await writeRedisJson(keyForFile(file), value);
    return;
  }

  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function keyForFile(file) {
  return file === SOURCES_FILE ? SOURCES_KEY : STATE_KEY;
}

async function ensureRedisJson(key, fallback) {
  const existing = await redisCommand("GET", key);
  if (existing == null) {
    await writeRedisJson(key, fallback);
  }
}

async function readRedisJson(key, fallback) {
  const raw = await redisCommand("GET", key);
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;
  return JSON.parse(raw);
}

async function writeRedisJson(key, value) {
  await redisCommand("SET", key, JSON.stringify(value));
}

async function redisCommand(command, ...args) {
  const response = await fetch(REDIS_REST_URL.replace(/\/$/, ""), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${REDIS_REST_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify([command, ...args])
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis ${command} failed with HTTP ${response.status}`);
  }

  return payload.result;
}

function storageInfo() {
  if (HAS_REDIS) {
    return {
      mode: "redis",
      label: "雲端同步",
      persistent: true,
      shared: true
    };
  }

  return {
    mode: IS_VERCEL ? "tmp" : "file",
    label: IS_VERCEL ? "Vercel 暫存" : "本機檔案",
    persistent: !IS_VERCEL,
    shared: false
  };
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function makeId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function normalizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://${text}`;
}

function cleanSource(input) {
  const type = String(input.type || "rss").toLowerCase();
  const url = normalizeUrl(input.url || input.feedUrl);
  const feedUrl = normalizeUrl(input.feedUrl || "");
  const name = toTraditional(String(input.name || "").trim() || guessNameFromUrl(url));
  const now = new Date().toISOString();

  return {
    id: input.id || crypto.randomUUID(),
    type,
    name,
    url,
    feedUrl,
    notes: toTraditional(String(input.notes || "").trim()),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function guessNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (isApplePodcastHost(parsed.hostname)) {
      const slug = [...parts].reverse().find((part) => !/^id\d+$/i.test(part) && part !== "podcast");
      if (slug) return titleFromSlug(slug);
    }

    const lastPath = parts.pop();
    return decodeURIComponent(lastPath || parsed.hostname.replace(/^www\./, ""));
  } catch {
    return "未命名來源";
  }
}

function titleFromSlug(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isApplePodcastHost(hostname) {
  return /(^|\.)podcasts\.apple\.com$/i.test(String(hostname || ""));
}

function sourceHome(source) {
  return source.url || source.feedUrl || "";
}

function shouldUseFeedTitle(source, feedTitle) {
  if (!feedTitle) return false;
  const currentName = String(source.name || "");
  return !currentName || currentName === toTraditional(guessNameFromUrl(source.url));
}

function parseYoutubeChannelId(value) {
  const text = String(value || "");
  const direct = text.match(/\b(UC[\w-]{20,})\b/);
  if (direct) return direct[1];
  return "";
}

async function resolveFeedUrl(source) {
  if (source.feedUrl) return source.feedUrl;

  if (source.type === "youtube") {
    const channelId = parseYoutubeChannelId(source.url);
    if (channelId) {
      return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    }
    return resolveYoutubeFeedFromPage(source.url);
  }

  if (source.type === "podcast" || source.type === "rss") {
    if (isApplePodcastUrl(source.url)) {
      return resolveApplePodcastFeed(source.url);
    }
    return source.url;
  }

  throw new Error("這個來源需要 RSS bridge 或 API token 才能自動更新");
}

function isApplePodcastUrl(value) {
  try {
    return isApplePodcastHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function parseApplePodcastId(value) {
  const match = String(value || "").match(/\/id(\d+)(?:[/?#]|$)/i);
  return match?.[1] || "";
}

function appleCountryFromUrl(value) {
  try {
    const country = new URL(value).pathname.split("/").filter(Boolean)[0];
    return /^[a-z]{2}$/i.test(country) ? country.toLowerCase() : "tw";
  } catch {
    return "tw";
  }
}

async function resolveApplePodcastFeed(url) {
  const id = parseApplePodcastId(url);
  if (!id) {
    throw new Error("找不到 Apple Podcasts 節目 ID");
  }

  const country = appleCountryFromUrl(url);
  const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`;
  const response = await fetchWithTimeout(lookupUrl, { accept: "application/json" });
  const data = await response.json();
  const result = Array.isArray(data.results) ? data.results.find((item) => item.feedUrl) : null;

  if (!result?.feedUrl) {
    throw new Error("Apple Podcasts 沒有提供這個節目的 RSS feed");
  }

  return result.feedUrl;
}

async function resolveYoutubeFeedFromPage(url) {
  const response = await fetchWithTimeout(url, { accept: "text/html" });
  const html = await response.text();
  const linkMatch = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i);
  if (linkMatch?.[1]) return decodeHtml(linkMatch[1]);

  const metaMatch = html.match(/(?:itemprop=["']channelId["'][^>]+content=["']|["']channelId["']\s*:\s*["'])(UC[\w-]{20,})/i);
  if (metaMatch?.[1]) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${metaMatch[1]}`;
  }

  throw new Error("找不到 YouTube 頻道 RSS，請改貼 /channel/UC... 連結");
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": options.accept || "application/rss+xml, application/atom+xml, text/xml, application/xml, */*",
        "user-agent": "SignalBoard/0.1 (+local dashboard)"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSourceItems(source) {
  const feedUrl = await resolveFeedUrl(source);
  const response = await fetchWithTimeout(feedUrl);
  const xml = await response.text();
  const parsed = parser.parse(xml);
  const feed = parseFeed(parsed, source, feedUrl);
  return {
    items: feed.items,
    resolvedFeedUrl: feedUrl,
    feedTitle: feed.title
  };
}

function parseFeed(parsed, source, feedUrl) {
  if (parsed.rss?.channel) {
    return parseRss(parsed.rss.channel, source, feedUrl);
  }
  if (parsed.feed) {
    return parseAtom(parsed.feed, source, feedUrl);
  }
  throw new Error("無法辨識這個 feed 格式");
}

function parseRss(channel, source, feedUrl) {
  const channelTitle = toTraditional(textValue(channel.title) || source.name);
  const channelImage = channel.image?.url || channel["itunes:image"]?.["@_href"] || "";
  const items = toArray(channel.item).map((entry) => {
    const title = toTraditional(textValue(entry.title) || "未命名更新");
    const link = textValue(entry.link) || textValue(entry.guid) || sourceHome(source);
    if (isShortFormLink(source.type, link)) return null;
    const publishedAt = normalizeDate(entry.pubDate || entry["dc:date"] || entry.isoDate);
    const guid = textValue(entry.guid) || link || title;
    const image = pickImage(entry, source) || channelImage;

    return decorateItem({
      source,
      feedUrl,
      externalId: guid,
      title,
      link,
      publishedAt,
      summary: toTraditional(stripHtml(textValue(entry.description || entry["content:encoded"]))),
      image
    });
  }).filter(Boolean);

  return { title: channelTitle, items };
}

function parseAtom(feed, source, feedUrl) {
  const feedTitle = toTraditional(textValue(feed.title) || source.name);
  const items = toArray(feed.entry).map((entry) => {
    const title = toTraditional(textValue(entry.title) || "未命名更新");
    const link = atomLink(entry.link) || sourceHome(source);
    if (isShortFormLink(source.type, link)) return null;
    const publishedAt = normalizeDate(entry.published || entry.updated);
    const externalId = textValue(entry.id) || link || title;

    return decorateItem({
      source,
      feedUrl,
      externalId,
      title,
      link,
      publishedAt,
      summary: toTraditional(stripHtml(textValue(entry.summary || entry.content))),
      image: pickImage(entry, source)
    });
  }).filter(Boolean);

  return { title: feedTitle, items };
}

function decorateItem(item) {
  const stable = `${item.source.id}:${item.externalId}:${item.link}:${item.title}`;
  return {
    id: makeId(stable),
    sourceId: item.source.id,
    sourceName: toTraditional(item.source.name),
    sourceType: item.source.type,
    sourceUrl: sourceHome(item.source),
    feedUrl: item.feedUrl,
    externalId: item.externalId,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    summary: item.summary,
    image: item.image,
    fetchedAt: new Date().toISOString()
  };
}

function toTraditional(value) {
  return convertToTraditional(String(value || ""));
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") {
    return String(value["#text"] || value["@_url"] || value["@_href"] || "").trim();
  }
  return "";
}

function atomLink(value) {
  const links = toArray(value);
  const alternate = links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate") || links[0];
  if (!alternate) return "";
  return typeof alternate === "string" ? alternate : alternate["@_href"] || alternate["#text"] || "";
}

function normalizeDate(value) {
  const date = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function pickImage(entry, source) {
  const mediaGroup = entry["media:group"] || {};
  const mediaThumb = toArray(entry["media:thumbnail"]).find(Boolean);
  const groupThumb = toArray(mediaGroup["media:thumbnail"]).find(Boolean);
  const mediaContent = toArray(entry["media:content"]).find((item) => {
    const type = item?.["@_type"] || "";
    return type.startsWith("image/") || item?.["@_url"];
  });
  const groupContent = toArray(mediaGroup["media:content"]).find((item) => {
    const type = item?.["@_type"] || "";
    return type.startsWith("image/") || item?.["@_url"];
  });
  const enclosure = toArray(entry.enclosure).find((item) => {
    const type = item?.["@_type"] || "";
    return type.startsWith("image/");
  });
  const itunesImage = entry["itunes:image"];

  return (
    mediaThumb?.["@_url"] ||
    groupThumb?.["@_url"] ||
    mediaContent?.["@_url"] ||
    groupContent?.["@_url"] ||
    enclosure?.["@_url"] ||
    itunesImage?.["@_href"] ||
    youtubeThumbnail(entry, source) ||
    ""
  );
}

function youtubeThumbnail(entry, source) {
  if (source?.type !== "youtube") return "";
  const videoId =
    textValue(entry["yt:videoId"]) ||
    textValue(entry.id).replace(/^yt:video:/, "") ||
    extractYoutubeVideoId(atomLink(entry.link) || textValue(entry.link));

  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function extractYoutubeVideoId(value) {
  const text = String(value || "");
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  return match?.[1] || "";
}

function isRecentItem(item, now = Date.now()) {
  const published = new Date(item.publishedAt).getTime();
  return Number.isFinite(published) && published >= now - RECENT_WINDOW_MS;
}

function isShortFormLink(sourceType, link) {
  const text = String(link || "");
  if (sourceType === "youtube") return /(?:youtube\.com\/shorts\/|\/shorts\/)/i.test(text);
  return /\/reels?\//i.test(text);
}

function withRecentState(state, now = Date.now()) {
  const items = (state.items || [])
    .filter((item) => isRecentItem(item, now))
    .filter((item) => !isShortFormLink(item.sourceType, item.link))
    .map((item) => ({
      ...item,
      sourceName: toTraditional(item.sourceName),
      title: toTraditional(item.title),
      summary: toTraditional(item.summary)
    }));
  const visibleIds = new Set(items.map((item) => item.id));

  return {
    ...state,
    items,
    readIds: (state.readIds || []).filter((id) => visibleIds.has(id))
  };
}

async function refreshSources({ sourceId } = {}) {
  const sources = await readJson(SOURCES_FILE, []);
  const now = Date.now();
  const state = withRecentState(await readJson(STATE_FILE, {}), now);
  const readIds = new Set(state.readIds || []);
  const previousItems = Array.isArray(state.items) ? state.items : [];
  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  const sourceErrors = { ...(state.sourceErrors || {}) };
  const nextItems = sourceId ? previousItems.filter((item) => item.sourceId !== sourceId) : [];
  const targets = sourceId ? sources.filter((source) => source.id === sourceId) : sources;
  const updatedSources = sources.map((source) => ({ ...source }));

  const results = await Promise.all(
    targets.map(async (source) => {
      try {
        const result = await fetchSourceItems(source);
        return { source, result };
      } catch (error) {
        return { source, error };
      }
    })
  );

  for (const { source, result, error } of results) {
    if (error) {
      sourceErrors[source.id] = {
        message: error.message,
        checkedAt: new Date().toISOString()
      };
      continue;
    }

    for (const item of result.items) {
      const previous = previousById.get(item.id);
      nextItems.push({
        ...previous,
        ...item,
        read: readIds.has(item.id)
      });
    }

    delete sourceErrors[source.id];
    const sourceIndex = updatedSources.findIndex((item) => item.id === source.id);
    if (sourceIndex >= 0) {
      const currentSource = updatedSources[sourceIndex];
      updatedSources[sourceIndex] = {
        ...currentSource,
        feedUrl: currentSource.feedUrl || result.resolvedFeedUrl,
        name: shouldUseFeedTitle(currentSource, result.feedTitle) ? result.feedTitle : currentSource.name,
        lastCheckedAt: new Date().toISOString()
      };
    }
  }

  const deduped = Array.from(new Map(nextItems.map((item) => [item.id, item])).values())
    .filter((item) => isRecentItem(item, now))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_ITEMS)
    .map((item) => ({ ...item, read: readIds.has(item.id) }));
  const visibleIds = new Set(deduped.map((item) => item.id));

  const nextState = {
    ...state,
    items: deduped,
    readIds: Array.from(readIds).filter((id) => visibleIds.has(id)),
    lastRefresh: new Date(now).toISOString(),
    sourceErrors
  };

  await writeJson(SOURCES_FILE, updatedSources);
  await writeJson(STATE_FILE, nextState);
  return { sources: updatedSources, state: nextState, storage: storageInfo() };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, storage: storageInfo() });
});

app.get("/api/dashboard", async (req, res, next) => {
  try {
    const sources = await readJson(SOURCES_FILE, []);
    const state = withRecentState(await readJson(STATE_FILE, {}));
    res.json({ sources, state, storage: storageInfo() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources", async (req, res, next) => {
  try {
    const sources = await readJson(SOURCES_FILE, []);
    const source = cleanSource(req.body);
    if (!source.url && !source.feedUrl) {
      res.status(400).json({ error: "請貼上來源連結或 feed 連結" });
      return;
    }

    sources.unshift(source);
    await writeJson(SOURCES_FILE, sources);
    res.status(201).json({ source });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/sources/:id", async (req, res, next) => {
  try {
    const sources = await readJson(SOURCES_FILE, []);
    const index = sources.findIndex((source) => source.id === req.params.id);
    if (index === -1) {
      res.status(404).json({ error: "找不到這個來源" });
      return;
    }

    sources[index] = cleanSource({ ...sources[index], ...req.body, id: sources[index].id });
    await writeJson(SOURCES_FILE, sources);
    res.json({ source: sources[index] });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sources/:id", async (req, res, next) => {
  try {
    const sources = await readJson(SOURCES_FILE, []);
    const state = await readJson(STATE_FILE, {});
    const nextSources = sources.filter((source) => source.id !== req.params.id);
    const nextState = {
      ...state,
      items: (state.items || []).filter((item) => item.sourceId !== req.params.id),
      sourceErrors: Object.fromEntries(
        Object.entries(state.sourceErrors || {}).filter(([id]) => id !== req.params.id)
      )
    };

    await writeJson(SOURCES_FILE, nextSources);
    await writeJson(STATE_FILE, nextState);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/refresh", async (req, res, next) => {
  try {
    const result = await refreshSources();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources/:id/refresh", async (req, res, next) => {
  try {
    const result = await refreshSources({ sourceId: req.params.id });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/read", async (req, res, next) => {
  try {
    const state = withRecentState(await readJson(STATE_FILE, {}));
    const ids = new Set(state.readIds || []);
    const targetIds = req.body.all
      ? (state.items || []).map((item) => item.id)
      : toArray(req.body.ids);

    for (const id of targetIds) ids.add(id);

    const nextState = {
      ...state,
      readIds: Array.from(ids),
      items: (state.items || []).map((item) => ({ ...item, read: ids.has(item.id) }))
    };
    await writeJson(STATE_FILE, nextState);
    res.json({ state: nextState, storage: storageInfo() });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "伺服器發生錯誤" });
});

export async function ensureDataReady() {
  dataReadyPromise ||= ensureDataFiles();
  await dataReadyPromise;
}

export default app;

if (!IS_VERCEL && process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await ensureDataReady();
  const port = Number(process.env.PORT || 5173);
  app.listen(port, () => {
    console.log(`Signal Board is running at http://localhost:${port}`);
  });
}
