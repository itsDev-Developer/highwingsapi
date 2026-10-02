import { Hono, type Context } from "hono";
import { fetchPage, HtmlDoc } from "../../lib/scraper";
import { cleanText, normalizeThumbnail, resolveUrl } from "../../lib/format";

const download = new Hono();

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Decode HTML entities. `&amp;` goes last so `&amp;lt;` isn't double-decoded. */
function decodeEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim());
}

/** Entity-decode and un-escape JS-style URLs (https:\/\/…, \u0026). */
function cleanUrl(raw: string): string {
  return decodeEntities(raw)
    .replace(/\\\//g, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\+$/, "")
    .trim();
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** "sare-tsuma-wa-ubawaretai-episode-1-id-01" → { series, episode } */
function titleFromSlug(slug: string): { series: string; episode: string } {
  const base = slug.replace(/-id-\d+$/i, "");
  const m = base.match(/^(.*?)-episode-(\d+)$/i);
  if (m) return { series: titleCase(m[1].replace(/-/g, " ")), episode: `Episode ${m[2]}` };
  return { series: titleCase(base.replace(/-/g, " ")), episode: "" };
}

/** "1080p" / "4k" from visible text, falling back to the URL (…_1080p.mp4). */
function qualityOf(text: string, url = ""): string {
  const m =
    text.match(/\b(\d{3,4}p|[248]k)\b/i) ??
    url.match(/[_\-./](\d{3,4}p|[248]k)(?=[_\-./?]|$)/i);
  return m ? m[1].toLowerCase() : "";
}

function qualityRank(label: string): number {
  const l = label.toLowerCase();
  if (l === "8k") return 4320;
  if (l === "4k") return 2160;
  if (l === "2k") return 1440;
  return parseInt(l, 10) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface DownloadSource {
  /** Direct file URL */
  url: string;
  /** Quality label e.g. "1080p", "1440p", "720p" ("default" if unknown) */
  label: string;
  /** Host extracted from URL e.g. "xupload.org" */
  host: string;
}

export interface DownloadPageData {
  id: string;
  slug: string;
  title: string;
  episodeTitle: string;
  seriesTitle: string;
  url: string;
  /** Canonical watch/stream URL for this episode */
  watchUrl: string;
  /** Canonical download page URL */
  downloadUrl: string;

  thumbnail: string;
  /** Numbered preview screenshots (…/1-1.jpg, 1-2.jpg, …) */
  previews: string[];

  /** All direct download links, best quality first */
  sources: DownloadSource[];

  seriesUrl: string;
  prevEpisode: { title: string; url: string } | null;
  nextEpisode: { title: string; url: string } | null;
  shareCount: string;
  related: { title: string; url: string; poster: string }[];

  datePublished: string;
  dateModified: string;
  description: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Source extraction (three passes, most precise first)
// ═══════════════════════════════════════════════════════════════════════════════

const ATTR_RE = /\b(?:href|onclick|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const NOT_A_FILE = /\/(videos|series|genre|tag|category)\//i;

/** Pull every absolute URL out of href / onclick / data-* attributes. */
function urlsFromAttrs(attrs: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrs)) !== null) {
    const val = cleanUrl(m[1] ?? m[2] ?? "");
    const u = val.match(/https?:\/\/[^\s'"<>]+/i)?.[0];
    if (u) out.push(u);
  }
  return out;
}

function toSource(url: string, label: string): DownloadSource {
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  return { url, label: label || qualityOf("", url) || "default", host };
}

/**
 * Pass 1 + 2: scan <a>/<button> elements.
 * strict=false → trust every button in the chunk (the _4continuar block).
 * strict=true  → whole page; only keep elements that look like download buttons.
 */
function scanButtons(chunk: string, strict: boolean, watchUrl: string): DownloadSource[] {
  const out: DownloadSource[] = [];
  const elRe = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = elRe.exec(chunk)) !== null) {
    const [full, , attrs, inner] = m;
    const text = stripHtml(inner);
    if (/fa-play-circle/i.test(full) || /watch\s*online/i.test(text)) continue;

    const label = qualityOf(text);
    if (strict && !label && !/fa-download/i.test(full)) continue;

    for (const url of urlsFromAttrs(attrs)) {
      if (url === watchUrl || NOT_A_FILE.test(url)) continue;
      out.push(toSource(url, label || qualityOf("", url)));
    }
  }
  return out;
}

/** Pass 3: any raw video-file URL anywhere in the page (incl. inline JS). */
function scanRawVideoUrls(html: string): DownloadSource[] {
  const text = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|mkv|webm|m3u8)(?:\?[^\s"'<>\\]*)?/gi;
  return (text.match(re) ?? []).map((u) => toSource(u, qualityOf("", u)));
}

function extractSources(html: string, watchUrl: string): DownloadSource[] {
  let found: DownloadSource[] = [];

  // Pass 1: the known button group
  const idx = html.search(/_4continuar/i);
  if (idx >= 0) found = scanButtons(html.slice(idx, idx + 4000), false, watchUrl);

  // Pass 2: any download-looking button on the page
  if (!found.length) found = scanButtons(html, true, watchUrl);

  // Pass 3: raw video URLs
  if (!found.length) found = scanRawVideoUrls(html);

  // De-dupe by URL, best quality first
  const byUrl = new Map<string, DownloadSource>();
  for (const s of found) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
  return [...byUrl.values()].sort((a, b) => qualityRank(b.label) - qualityRank(a.label));
}

function pickSource(sources: DownloadSource[], quality?: string): DownloadSource | null {
  if (!sources.length) return null;
  const want = (quality ?? "best").toLowerCase();
  if (want === "best") return sources[0];
  if (want === "lowest" || want === "worst") return sources[sources.length - 1];
  return sources.find((s) => s.label.toLowerCase() === want) ?? sources[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Parser
// ═══════════════════════════════════════════════════════════════════════════════

function parseDownloadPage(html: string, slug: string): DownloadPageData {
  // ── Post ID ────────────────────────────────────────────────────────────────
  const id = html.match(/postid-(\d+)/i)?.[1] ?? "";

  // ── Canonical & watch URL ──────────────────────────────────────────────────
  const downloadUrl =
    html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
    `https://watchhentai.net/download/${slug}/`;

  const watchUrl =
    html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    downloadUrl.replace("/download/", "/videos/");

  // ── Title (h1 → og:title → <title> → slug) ─────────────────────────────────
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const docTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  let rawTitle = decodeEntities(stripHtml(h1 ?? "") || ogTitle || docTitle || "")
    .replace(/\s*[-–|]\s*watch\s*hentai.*$/i, "")
    .replace(/\s+download\s*$/i, "")
    .trim();

  let seriesTitle = "";
  let episodeTitle = "";
  const tm = rawTitle.match(/^(.*?)\s*[–—-]\s*Episode\s+(\S+)/i);
  if (tm) {
    seriesTitle = tm[1].trim();
    episodeTitle = `Episode ${tm[2].trim()}`;
  } else if (rawTitle) {
    seriesTitle = rawTitle;
  } else {
    const fromSlug = titleFromSlug(slug);
    seriesTitle = fromSlug.series;
    episodeTitle = fromSlug.episode;
    rawTitle = episodeTitle ? `${seriesTitle} – ${episodeTitle}` : seriesTitle;
  }
  const title = rawTitle;

  // ── Thumbnail ──────────────────────────────────────────────────────────────
  const thumbMatch =
    html.match(/data-src=["'](https:\/\/watchhentai\.net\/uploads\/\d+\/[^"']+\/1(?:_thumb)?\.jpg)["']/i) ??
    html.match(/data-src=["'](https:\/\/watchhentai\.net\/uploads\/[^"']+\.jpg)["']/i);
  const thumbnail = normalizeThumbnail(thumbMatch?.[1] ?? "");

  // ── Preview screenshots (og:image + lazy <img>), numbered like /1-3.jpg ────
  const previewSet = new Set<string>();
  const numbered = /\/\d+-\d+\.(jpg|jpeg|png|webp)$/i;
  const imgRes = [
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi,
    /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi,
  ];
  for (const re of imgRes) {
    let im: RegExpExecArray | null;
    while ((im = re.exec(html)) !== null) {
      if (numbered.test(im[1])) previewSet.add(im[1]);
    }
  }
  const previews = [...previewSet];

  // ── Download sources ───────────────────────────────────────────────────────
  const sources = extractSources(html, watchUrl);

  // ── Series URL ─────────────────────────────────────────────────────────────
  const seriesUrl =
    html.match(/<a href=["'](https:\/\/watchhentai\.net\/series\/[^"']+)["'][^>]*>\s*<i class=['"]fas fa-bars['"]/i)?.[1] ??
    html.match(/href=["'](https:\/\/watchhentai\.net\/series\/[^"']+)["']/i)?.[1] ??
    "";

  // ── Prev / Next ────────────────────────────────────────────────────────────
  let prevEpisode: DownloadPageData["prevEpisode"] = null;
  let nextEpisode: DownloadPageData["nextEpisode"] = null;

  const pagIdx = html.search(/pag_episodes/i);
  if (pagIdx >= 0) {
    const chunk = html.slice(pagIdx, pagIdx + 3000);
    const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(chunk)) !== null) {
      const attrs = am[1];
      const href = attrs.match(/href=["']([^"']+)["']/i)?.[1] ?? "";
      if (!href || href === "#" || /nonex/i.test(attrs)) continue;
      const label = stripHtml(am[2]).toUpperCase();
      const t = decodeEntities(attrs.match(/title=["']([^"']+)["']/i)?.[1] ?? stripHtml(am[2]));
      if (label.includes("NEXT") && !nextEpisode) nextEpisode = { title: t, url: href };
      else if (label.includes("PREV") && !prevEpisode) prevEpisode = { title: t, url: href };
    }
  }

  // ── Share count ────────────────────────────────────────────────────────────
  const shareCount = html.match(/<b id=['"]social_count['"]>(\d+)<\/b>/i)?.[1] ?? "0";

  // ── Related series ─────────────────────────────────────────────────────────
  const related: DownloadPageData["related"] = [];
  const relIdx = html.search(/id=["']single_relacionados["']/i);
  if (relIdx >= 0) {
    let relHtml = html.slice(relIdx, relIdx + 12000);
    const end = relHtml.search(/<\/section>|<footer/i);
    if (end > 0) relHtml = relHtml.slice(0, end);
    const relDoc = new HtmlDoc(relHtml);
    relDoc.articles().forEach((art) => {
      const url = resolveUrl(art.attr("a", "href"));
      const poster = normalizeThumbnail(art.attr("img", "data-src") || art.attr("img", "src"));
      const t = cleanText(art.attr("img", "alt") || art.attr("img", "title"));
      if (url) related.push({ title: t, url, poster });
    });
  }

  // ── JSON-LD schema (dates, description) ────────────────────────────────────
  let datePublished = "";
  let dateModified = "";
  let description = "";

  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ldRe.exec(html)) !== null) {
    const body = lm[1].trim();
    try {
      const graph = JSON.parse(body);
      const nodes: any[] = graph["@graph"] ?? (Array.isArray(graph) ? graph : [graph]);
      const node = nodes.find((p: any) =>
        ["WebPage", "Article", "VideoObject"].includes(p?.["@type"])
      );
      if (node) {
        datePublished ||= node.datePublished ?? node.uploadDate ?? "";
        dateModified ||= node.dateModified ?? "";
        description ||= node.description ?? "";
      }
    } catch (_) {
      datePublished ||= body.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ?? "";
      dateModified ||= body.match(/"dateModified"\s*:\s*"([^"]+)"/)?.[1] ?? "";
      description ||= body.match(/"description"\s*:\s*"([^"]+)"/)?.[1] ?? "";
    }
  }

  if (!description) {
    description = decodeEntities(
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? ""
    );
  }

  return {
    id, slug, title, episodeTitle, seriesTitle,
    url: downloadUrl, watchUrl, downloadUrl,
    thumbnail, previews, sources,
    seriesUrl, prevEpisode, nextEpisode, shareCount, related,
    datePublished, dateModified, description,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════════

const BASE = "https://watchhentai.net";

async function handleDownload(c: Context) {
  const slug: string = c.req.param("slug") ?? c.req.query("slug") ?? "";

  if (!slug) {
    return c.json(
      { success: false, error: "Missing slug. Use /api/download/{slug} or /api/download?slug={slug}" },
      400
    );
  }

  const path = `/download/${slug}/`;

  try {
    const html = await fetchPage(path);
    const data = parseDownloadPage(html, slug);

    const warnings: string[] = [];
    if (!data.sources.length) {
      warnings.push(
        `No download sources found (page length ${html.length}). ` +
          `Open /api/download/${slug}/debug to inspect the raw HTML.`
      );
    }

    return c.json({
      success: true,
      data,
      meta: {
        scrapedAt: new Date().toISOString(),
        source: `${BASE}${path}`,
        ...(warnings.length ? { warnings } : {}),
      },
    });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
}

/**
 * GET /:slug/direct?quality=best|lowest|1080p[&format=text]
 * 302-redirects to the file, or returns the bare URL as text with format=text.
 */
async function handleDirect(c: Context) {
  const slug = c.req.param("slug") ?? "";
  try {
    const html = await fetchPage(`/download/${slug}/`);
    const { sources } = parseDownloadPage(html, slug);
    const pick = pickSource(sources, c.req.query("quality"));

    if (!pick) {
      return c.json({ success: false, error: "No download sources found for this episode." }, 404);
    }
    if (c.req.query("format") === "text") return c.text(pick.url);
    return c.redirect(pick.url);
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
}

/** GET /:slug/debug — raw-HTML snippets for diagnosing a broken parser. */
async function handleDebug(c: Context) {
  const slug = c.req.param("slug") ?? "";
  try {
    const html = await fetchPage(`/download/${slug}/`);
    const at = (needle: string | RegExp, len = 900) => {
      const i = typeof needle === "string" ? html.indexOf(needle) : html.search(needle);
      return i < 0 ? null : html.slice(Math.max(0, i - 200), i + len);
    };
    return c.json({
      length: html.length,
      docTitle: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
      head: html.slice(0, 300),
      h1: at(/<h1/i),
      downloadBlock: at("_4continuar"),
      downloadIcon: at("fa-download"),
      cdnHost: at("xupload"),
      videoUrls: html.replace(/\\\//g, "/").match(/https?:\/\/[^"'\s<>\\]+\.(?:mp4|mkv|webm|m3u8)[^"'\s<>\\]*/gi),
    });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Routes
//
//   GET /api/download/sare-tsuma-wa-ubawaretai-episode-1-id-01
//   GET /api/download?slug=sare-tsuma-wa-ubawaretai-episode-1-id-01
//   GET /api/download/{slug}/direct?quality=1080p        → 302 to the file
//   GET /api/download/{slug}/direct?format=text          → bare URL as text
//   GET /api/download/{slug}/debug                       → raw HTML snippets
// ═══════════════════════════════════════════════════════════════════════════════

download.get("/", handleDownload);
download.get("/:slug/direct", handleDirect);
download.get("/:slug/debug", handleDebug);
download.get("/:slug", handleDownload);

export default download;
