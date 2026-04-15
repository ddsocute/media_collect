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
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ITEMS = 500;
const RECENT_DAYS = 7;
const RECENT_WINDOW_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});
const convertToTraditional = Converter({ from: "cn", to: "twp" });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await ensureJson(SOURCES_FILE, []);
  await ensureJson(STATE_FILE, {
    items: [],
    readIds: [],
    lastRefresh: null,
    sourceErrors: {}
  });
}

async function ensureJson(file, fallback) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, `${JSON.stringify(fallback, null, 2)}\n`);
  }
}

async function readJson(file, fallback) {
  await ensureJson(file, fallback);
  const raw = await fs.readFile(file, "utf8");
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
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
    const lastPath = parsed.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(lastPath || parsed.hostname.replace(/^www\./, ""));
  } catch {
    return "未命名來源";
  }
}

function sourceHome(source) {
  return source.url || source.feedUrl || "";
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
    return source.url;
  }

  throw new Error("這個來源需要 RSS bridge 或 API token 才能自動更新");
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
  const timer = setTimeout(() => controller.abort(), 15000);
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

  for (const source of targets) {
    try {
      const result = await fetchSourceItems(source);
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
        updatedSources[sourceIndex] = {
          ...updatedSources[sourceIndex],
          feedUrl: updatedSources[sourceIndex].feedUrl || result.resolvedFeedUrl,
          name: updatedSources[sourceIndex].name || result.feedTitle,
          lastCheckedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      sourceErrors[source.id] = {
        message: error.message,
        checkedAt: new Date().toISOString()
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
  return { sources: updatedSources, state: nextState };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (req, res, next) => {
  try {
    const sources = await readJson(SOURCES_FILE, []);
    const state = withRecentState(await readJson(STATE_FILE, {}));
    res.json({ sources, state });
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
    res.json({ state: nextState });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "伺服器發生錯誤" });
});

await ensureDataFiles();

const port = Number(process.env.PORT || 5173);
app.listen(port, () => {
  console.log(`Signal Board is running at http://localhost:${port}`);
});
