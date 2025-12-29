import { load, CheerioAPI } from 'cheerio';
import { client } from '../utils/client.js';
import { encryptToken, decryptIframeData, decryptMegaUpData } from '../utils/animekai-crypto.js';
import type { Browser, BrowserContext, Page } from 'playwright';

const DEFAULT_BASE = 'https://anikai.to/';

interface SearchResult {
  id: string;
  url: string;
  title: string;
  image: string;
  type: string;
  subCount: number;
  dubCount: number;
}

interface Episode {
  id: string;
  number: number;
  title: string;
  image?: string;
  overview?: string;
  rating?: number;
}

interface Genre {
  href: string;
  text: string;
}

interface AnimeInfo {
  id: string;
  title: string;
  japaneseTitle: string;
  url: string;
  image?: string;
  type: string;
  totalEpisodes: number;
  episodes: Episode[];
  hasSub: boolean;
  hasDub: boolean;
  subOrDub: 'sub' | 'dub' | 'both';
  status?: string;
  season?: string;
  genres: string[];
  malId?: number;
  anilistId?: number;
}

interface Source {
  url: string;
  isM3U8: boolean;
}

interface Subtitle {
  file: string;
  label: string;
  kind: string;
}

interface EpisodeSources {
  headers: Record<string, string>;
  sources: Source[];
  subtitles: Subtitle[];
}

interface ServerCandidate {
  type: string;
  lid: string;
  name: string;
}

interface AniZipEpisode {
  image?: string;
  overview?: string;
  rating?: string;
}

interface AniZipData {
  episodes?: Record<string, AniZipEpisode>;
}

function fixUrl(url: string, base: string = DEFAULT_BASE): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

async function requestWithRetry(
  url: string,
  config: Record<string, any> = {},
  retries: number = 2,
  perRequestTimeoutMs: number = 60000
): Promise<any> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await client.get(url, { timeout: perRequestTimeoutMs, ...config });
      return data;
    } catch (e) {
      lastErr = e as Error;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function extractFromMegaUpHeadless(
  pageUrl: string,
  baseHeaders: Record<string, string>
): Promise<EpisodeSources | null> {
  try {
    const playwright = await import('playwright').catch(() => ({ chromium: null }));
    if (!playwright.chromium) return null;

    const ua = baseHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
    const browser: Browser = await playwright.chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext({
      userAgent: ua,
      extraHTTPHeaders: {
        Referer: baseHeaders.Referer || 'https://megaup.site',
        'Accept-Language': baseHeaders['Accept-Language'] || 'en-US,en;q=0.9',
      },
    });
    const page: Page = await context.newPage();

    const seenM3U8 = new Set<string>();
    const seenVTT = new Set<string>();

    page.on('request', (req) => {
      try {
        const url = req.url();
        if (/\.m3u8(\?|$)/i.test(url)) seenM3U8.add(url);
        if (/\.vtt(\?|$)/i.test(url) && !/thumbnails/i.test(url)) seenVTT.add(url);
      } catch {}
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const playSelectors = ['button', '.vjs-big-play-button', '.plyr__control', '.jw-icon-playback'];
    for (const sel of playSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
      }
    }
    
    await Promise.race([
      page.waitForRequest(req => /\.m3u8(\?|$)/i.test(req.url()), { timeout: 10000 }).catch(() => null),
      page.waitForTimeout(7000),
    ]);

    const m3u8 = Array.from(seenM3U8)[0];
    const subtitles: Subtitle[] = Array.from(seenVTT).map((u) => ({
      file: u,
      label: extractLangLabelFromUrl(u),
      kind: 'captions',
    }));

    await context.close();
    await browser.close();

    if (m3u8) {
      const pageUrlObj = new URL(pageUrl);
      const origin = `${pageUrlObj.protocol}//${pageUrlObj.host}`;
      return {
        headers: { Referer: origin, 'User-Agent': ua },
        sources: [{ url: m3u8, isM3U8: true }],
        subtitles,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function getJson(
  url: string,
  params: Record<string, any> = {},
  headers: Record<string, string> = {}
): Promise<any> {
  return await requestWithRetry(url, { params, headers }, 2, 30000);
}

function extractBackgroundUrl(style: string): string {
  if (!style) return '';
  const m = style.match(/url\(([^)]+)\)/i);
  if (!m) return '';
  return m[1].replace(/^['"]|['"]$/g, '');
}

export class AnimeKai {
  private baseUrl: string;

  constructor(baseUrl: string = DEFAULT_BASE) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async search(query: string): Promise<{ results: SearchResult[] }> {
    const url = `${this.baseUrl}/browser?keyword=${encodeURIComponent(query)}`;
    const { data: html } = await client.get(url, {
      responseType: 'text',
      headers: { Referer: this.baseUrl }
    });
    const $ = load(html);
    
    const results: SearchResult[] = $("div.aitem-wrapper div.aitem").map((_, el) => {
      const item = $(el);
      const href = fixUrl(item.find('a.poster').attr('href') || '', this.baseUrl);
      const title = item.find('a.title').text().trim();
      const subCount = parseInt(item.find('div.info span.sub').text().trim() || '0', 10) || 0;
      const dubCount = parseInt(item.find('div.info span.dub').text().trim() || '0', 10) || 0;
      const posterUrl = fixUrl(
        item.find('a.poster img').attr('data-src') || item.find('a.poster img').attr('src') || '',
        this.baseUrl
      );
      const type = (item.find('div.fd-infor > span.fdi-item').text().trim() || '').toLowerCase();
      
      return {
        id: href,
        url: href,
        title,
        image: posterUrl,
        type,
        subCount,
        dubCount,
      };
    }).get();
    
    return { results };
  }

  async fetchAnimeInfo(idOrUrl: string): Promise<AnimeInfo> {
    const url = fixUrl(idOrUrl, this.baseUrl);
    const { data: html } = await client.get(url, {
      responseType: 'text',
      headers: { Referer: this.baseUrl }
    });
    const $ = load(html);

    const title = $('h1.title').first().text().trim();
    const japaneseTitle = $('h1.title').first().attr('data-jp') || '';
    const animeId = $('div.rate-box').attr('data-id') || '';
    const malId = $('div.watch-section').attr('data-mal-id') || null;
    const aniId = $('div.watch-section').attr('data-al-id') || null;
    const subCount = parseInt($('#main-entity div.info span.sub').text().trim() || '0', 10) || 0;
    const dubCount = parseInt($('#main-entity div.info span.dub').text().trim() || '0', 10) || 0;
    const bgStyle = $('div.watch-section-bg').attr('style') || '';
    const posterFromBg = extractBackgroundUrl(bgStyle);

    // Use the new encryption utility
    const underscore = await encryptToken(animeId);
    const listJson = await getJson(
      `${this.baseUrl}/ajax/episodes/list`,
      { ani_id: animeId, _: underscore },
      { Referer: url }
    );
    const listHtml = listJson?.result || '';
    const $$ = load(listHtml);

    const episodes: Episode[] = [];
    $$("div.eplist a").each((index, el) => {
      const a = $$(el);
      const token = a.attr('token');
      const name = a.find('span').text().trim();
      const numAttr = a.attr('num');
      const number = numAttr ? parseInt(numAttr, 10) : (index + 1);
      if (token) {
        episodes.push({ id: token, number, title: name });
      }
    });

    let aniZip: AniZipData | null = null;
    if (malId) {
      try {
        const { data: aniZipData } = await client.get<AniZipData>(
          `https://api.ani.zip/mappings`,
          { params: { mal_id: malId } }
        );
        aniZip = aniZipData || null;
      } catch {
        aniZip = null;
      }
      if (aniZip && aniZip.episodes) {
        episodes.forEach((ep) => {
          const meta = aniZip?.episodes?.[String(ep.number)];
          if (meta) {
            ep.image = meta.image || undefined;
            ep.overview = meta.overview || undefined;
            const r = parseFloat(meta.rating || '0');
            ep.rating = Number.isFinite(r) ? Math.round(r * 10) : 0;
          }
        });
      }
    }

    const genres: string[] = $('div.detail a')
      .toArray()
      .map((el) => ({ href: $(el).attr('href') || '', text: $(el).text().trim() }))
      .filter((x) => x.href.includes('/genres/'))
      .map((x) => x.text);

    let statusText: string | undefined = undefined;
    const statusDiv = $('div').filter((_, el) => /\bstatus\b/i.test($(el).text()));
    if (statusDiv.length) {
      const spanTxt = statusDiv.first().find('span').first().text().trim();
      if (spanTxt) statusText = spanTxt;
    }

    return {
      id: url,
      title,
      japaneseTitle,
      url,
      image: posterFromBg ? fixUrl(posterFromBg, this.baseUrl) : undefined,
      type: 'anime',
      totalEpisodes: episodes.length,
      episodes,
      hasSub: subCount > 0,
      hasDub: dubCount > 0,
      subOrDub: subCount && dubCount ? 'both' : (dubCount ? 'dub' : 'sub'),
      status: statusText,
      season: undefined,
      genres,
      malId: malId ? Number(malId) : undefined,
      anilistId: aniId ? Number(aniId) : undefined,
    };
  }

  async fetchEpisodeSources(
    episodeToken: string,
    serverName?: string,
    dub: boolean = false
  ): Promise<EpisodeSources> {
    // Use the new encryption utility
    const underscoreToken = await encryptToken(episodeToken);
    const listJson = await getJson(
      `${this.baseUrl}/ajax/links/list`,
      { token: episodeToken, _: underscoreToken },
      { Referer: this.baseUrl }
    );
    const listHtml = listJson?.result || '';
    const $ = load(listHtml);

    const preferredTypes = dub ? ['dub'] : ['sub', 'softsub'];
    const serverCandidates: ServerCandidate[] = [];
    
    preferredTypes.forEach((type) => {
      $(`div.server-items[data-id=${type}] span.server[data-lid]`).each((_, el) => {
        const span = $(el);
        serverCandidates.push({
          type,
          lid: span.attr('data-lid') || '',
          name: span.text().trim(),
        });
      });
    });

    if (serverCandidates.length === 0) {
      throw new Error('No servers found for this episode');
    }

    let chosen = serverCandidates[0];
    if (serverName) {
      const found = serverCandidates.find(s => s.name.toLowerCase() === serverName.toLowerCase());
      if (found) chosen = found;
    }

    // Use the new encryption utility
    const underscoreLid = await encryptToken(chosen.lid);
    const viewJson = await getJson(
      `${this.baseUrl}/ajax/links/view`,
      { id: chosen.lid, _: underscoreLid },
      { Referer: this.baseUrl }
    );
    const result = viewJson?.result || '';

    // Use the new decryption utility
    const decodedData = await decryptIframeData(result);
    const iframeUrl = decodedData.url;

    if (!iframeUrl) {
      throw new Error('Failed to resolve iframe URL');
    }

    if (/megaup\.(site|cc)/i.test(iframeUrl)) {
      const resolved = await extractFromMegaUp(iframeUrl);
      if (resolved) return resolved;
    }

    return {
      headers: {
        Referer: this.baseUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      sources: [
        { url: iframeUrl, isM3U8: /\.m3u8($|\?)/.test(iframeUrl) }
      ],
      subtitles: [],
    };
  }
}

async function extractFromMegaUp(pageUrl: string): Promise<EpisodeSources | null> {
  try {
    const pageUrlObj = new URL(pageUrl);
    const origin = `${pageUrlObj.protocol}//${pageUrlObj.host}`;
    const headers: Record<string, string> = {
      Referer: 'https://megaup.site',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
    };
    
    // Try to get the page and extract encrypted data
    const pageHtml = await requestWithRetry(pageUrl, { responseType: 'text', headers }, 1, 30000);
    
    // Look for encrypted player data in the page
    const encryptedDataMatch = String(pageHtml).match(/"result"\s*:\s*"([^"]+)"/);
    
    if (encryptedDataMatch && encryptedDataMatch[1]) {
      // Use the new MegaUp decryption utility
      const decrypted = await decryptMegaUpData(encryptedDataMatch[1], headers['User-Agent']);
      
      const subtitles: Subtitle[] = decrypted.tracks
        .filter((t) => !/thumbnails/i.test(t.file))
        .map((t) => ({
          file: t.file,
          label: t.label,
          kind: t.kind,
        }));

      if (decrypted.sources.length > 0) {
        return {
          headers: { Referer: origin, 'User-Agent': headers['User-Agent'] },
          sources: decrypted.sources.map(s => ({
            url: s.file,
            isM3U8: s.file.includes('.m3u8') || s.file.endsWith('m3u8'),
          })),
          subtitles,
        };
      }
    }

    // Fallback to regex extraction if decryption fails
    const m3u8Matches = String(pageHtml).match(/https?:[^\"'\s]+\.m3u8[^\"'\s]*/gi) || [];
    const vttMatches = String(pageHtml).match(/https?:[^\"'\s]+\.vtt[^\"'\s]*/gi) || [];
    
    const subtitles: Subtitle[] = vttMatches
      .filter((u) => !/thumbnails/i.test(u))
      .map((u) => ({
        file: u,
        label: extractLangLabelFromUrl(u),
        kind: 'captions',
      }));

    if (m3u8Matches.length > 0) {
      const file = m3u8Matches[0];
      return {
        headers: { Referer: origin, 'User-Agent': headers['User-Agent'] },
        sources: [{ url: file!, isM3U8: true }],
        subtitles,
      };
    }

    // Last resort: headless browser
    const headless = await extractFromMegaUpHeadless(pageUrl, headers);
    if (headless) return headless;
    
    return null;
  } catch {
    return null;
  }
}

function extractLangLabelFromUrl(url: string): string {
  try {
    const file = url.split('/').pop() || '';
    const code = (file.split('_')[0] || '').toLowerCase();
    const map: Record<string, string> = {
      eng: 'English', ger: 'German', deu: 'German', spa: 'Spanish', fre: 'French', fra: 'French',
      ita: 'Italian', jpn: 'Japanese', chi: 'Chinese', zho: 'Chinese', kor: 'Korean', rus: 'Russian',
      ara: 'Arabic', hin: 'Hindi', por: 'Portuguese', vie: 'Vietnamese', pol: 'Polish', ukr: 'Ukrainian',
      swe: 'Swedish', ron: 'Romanian', rum: 'Romanian', ell: 'Greek', gre: 'Greek', hun: 'Hungarian',
      fas: 'Persian', per: 'Persian', tha: 'Thai'
    };
    return map[code] || code.toUpperCase() || 'Subtitle';
  } catch {
    return 'Subtitle';
  }
}

export default AnimeKai;
