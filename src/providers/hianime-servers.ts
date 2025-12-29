import { load } from 'cheerio';
import { client } from '../utils/client.js';
import { HIANIME_URL } from '../constants/api-constants.js';

interface ServerItem {
  serverName: string;
  serverId: number | null;
  dataId: number | null;
}

interface EpisodeServersResult {
  sub: ServerItem[];
  dub: ServerItem[];
  raw: ServerItem[];
  episodeId: string;
  episodeNo: number;
}

interface ServerDataResponse {
  html?: string;
}

interface SourcesResponse {
  link?: string;
  sources?: string | Array<{ file: string }>;
  tracks?: any[];
  intro?: { start: number; end: number };
  outro?: { start: number; end: number };
}

interface KeyJsonResponse {
  mega?: string;
}

interface Source {
  url: string;
  isM3U8: boolean;
}

interface EpisodeSourcesResult {
  headers: {
    Referer: string;
    'User-Agent': string;
  };
  sources: Source[];
  subtitles?: any[];
  tracks?: any[];
  intro?: {
    start: number;
    end: number;
  };
  outro?: {
    start: number;
    end: number;
  };
}

/**
 * Get all available servers for a HiAnime episode
 * @param episodeId - Episode ID in format "anime-title-123?ep=456"
 * @returns Object containing sub, dub, and raw server lists
 */
export async function getEpisodeServers(episodeId: string): Promise<EpisodeServersResult> {
  const result: EpisodeServersResult = {
    sub: [],
    dub: [],
    raw: [],
    episodeId,
    episodeNo: 0,
  };

  try {
    if (!episodeId || episodeId.trim() === "" || episodeId.indexOf("?ep=") === -1) {
      throw new Error("Invalid anime episode ID");
    }

    const epId = episodeId.split("?ep=")[1];
    const ajaxUrl = `${HIANIME_URL}/ajax/v2/episode/servers?episodeId=${epId}`;
    
    const { data } = await client.get<ServerDataResponse>(ajaxUrl, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `${HIANIME_URL}/watch/${episodeId}`
      }
    });

    if (!data.html) {
      throw new Error("No server data found");
    }

    const $ = load(data.html);

    // Extract episode number
    const epNoSelector = ".server-notice strong";
    result.episodeNo = Number($(epNoSelector).text().split(" ").pop()) || 0;

    // Extract SUB servers
    $(`.ps_-block.ps_-block-sub.servers-sub .ps__-list .server-item`).each((_, el) => {
      result.sub.push({
        serverName: $(el).find("a").text().toLowerCase().trim(),
        serverId: Number($(el)?.attr("data-server-id")?.trim()) || null,
        dataId: Number($(el)?.attr("data-id")?.trim()) || null,
      });
    });

    // Extract DUB servers
    $(`.ps_-block.ps_-block-sub.servers-dub .ps__-list .server-item`).each((_, el) => {
      result.dub.push({
        serverName: $(el).find("a").text().toLowerCase().trim(),
        serverId: Number($(el)?.attr("data-server-id")?.trim()) || null,
        dataId: Number($(el)?.attr("data-id")?.trim()) || null,
      });
    });

    // Extract RAW servers
    $(`.ps_-block.ps_-block-sub.servers-raw .ps__-list .server-item`).each((_, el) => {
      result.raw.push({
        serverName: $(el).find("a").text().toLowerCase().trim(),
        serverId: Number($(el)?.attr("data-server-id")?.trim()) || null,
        dataId: Number($(el)?.attr("data-id")?.trim()) || null,
      });
    });

    return result;
  } catch (error) {
    console.error('Error fetching episode servers:', (error as Error).message);
    throw error;
  }
}

/**
 * Get streaming sources for a HiAnime episode
 * @param episodeId - Episode ID in format "anime-title-123?ep=456"
 * @param serverName - Name of the server to get sources from
 * @param category - Type of episode: 'sub', 'dub', or 'raw'
 * @returns Object containing sources and related metadata
 */
export async function getEpisodeSources(
  episodeId: string, 
  serverName: string = 'hd-1', 
  category: 'sub' | 'dub' | 'raw' = 'sub'
): Promise<EpisodeSourcesResult> {
  try {
    if (!episodeId || episodeId.trim() === "" || episodeId.indexOf("?ep=") === -1) {
      throw new Error("Invalid anime episode ID");
    }

    // First get available servers
    const servers = await getEpisodeServers(episodeId);
    
    // Find the requested server
    const serverList = servers[category] || [];
    const server = serverList.find(s => s.serverName.toLowerCase() === serverName.toLowerCase());
    
    if (!server) {
      throw new Error(`Server '${serverName}' not found for category '${category}'`);
    }

    if (!server.dataId) {
      throw new Error(`No data ID found for server '${serverName}'`);
    }

    const dataId = server.dataId;
    const serverId = server.serverId;
    
    // Fetch the source URL
    const { data } = await client.get<SourcesResponse>(
      `${HIANIME_URL}/ajax/v2/episode/sources?id=${dataId}`,
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${HIANIME_URL}/watch/${episodeId}`
        }
      }
    );

    // If the target is a MegaCloud embed, extract the direct source URL
    if (data?.link && /megacloud\./i.test(data.link)) {
      const extracted = await extractFromMegaCloud(data.link);
      return extracted;
    }

    // Return sources format similar to the AniWatch package for other hosts
    return {
      headers: {
        Referer: data.link || '',
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36"
      },
      sources: [
        {
          url: data.link || '',
          isM3U8: data.link?.includes('.m3u8') || false,
        }
      ],
      subtitles: [],
    };
  } catch (error) {
    console.error('Error fetching episode sources:', (error as Error).message);
    throw error;
  }
}

// --- Helpers ---
async function extractFromMegaCloud(embedUrl: string): Promise<EpisodeSourcesResult> {
  // Parse domain for Referer
  const urlObj = new URL(embedUrl);
  const defaultDomain = `${urlObj.protocol}//${urlObj.host}`;

  // Use a mobile UA to match site expectations
  const mobileUA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

  // Load embed page HTML
  const { data: html } = await client.get<string>(embedUrl, {
    responseType: 'text',
    headers: {
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: defaultDomain,
      'User-Agent': mobileUA,
    },
  });

  const $ = load(html);

  // Get file id from #megacloud-player
  const videoTag = $('#megacloud-player');
  const fileId = videoTag?.attr('data-id');
  if (!fileId) {
    throw new Error('MegaCloud: missing file id (possibly expired URL)');
  }

  // Extract nonce - either 48 chars or 3x16 concatenated
  let nonce: string | null = null;
  const nonceRegex48 = /\b[a-zA-Z0-9]{48}\b/;
  const match48 = html.match(nonceRegex48);
  if (match48) {
    nonce = match48[0];
  } else {
    const match3x16 = html.match(/\b([a-zA-Z0-9]{16})\b[\s\S]*?\b([a-zA-Z0-9]{16})\b[\s\S]*?\b([a-zA-Z0-9]{16})\b/);
    if (match3x16) nonce = `${match3x16[1]}${match3x16[2]}${match3x16[3]}`;
  }
  if (!nonce) {
    throw new Error('MegaCloud: failed to capture nonce');
  }

  // Get decryption key from public repo
  const { data: keyJson } = await client.get<KeyJsonResponse>(
    'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
    {
      headers: { 'User-Agent': mobileUA }
    }
  );
  const secret = keyJson?.mega;

  // Try to get sources JSON
  const { data: sourcesResp } = await client.get<SourcesResponse>(
    `${defaultDomain}/embed-2/v3/e-1/getSources`,
    {
      params: { id: fileId, _k: nonce },
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: defaultDomain,
        'User-Agent': mobileUA,
      }
    }
  );

  let fileUrl: string | null = null;
  let tracks: any[] = [];
  let intro = { start: 0, end: 0 };
  let outro = { start: 0, end: 0 };
  
  if (Array.isArray(sourcesResp?.sources) && sourcesResp.sources[0]?.file) {
    fileUrl = sourcesResp.sources[0].file;
    // Extract tracks if available
    if (sourcesResp?.tracks && Array.isArray(sourcesResp.tracks)) {
      tracks = sourcesResp.tracks;
    }
    // Extract intro/outro if available
    if (sourcesResp?.intro) {
      intro = sourcesResp.intro;
    }
    if (sourcesResp?.outro) {
      outro = sourcesResp.outro;
    }
  } else if (sourcesResp?.sources) {
    // Encrypted payload; use remote decoder
    const decodeBase = 'https://script.google.com/macros/s/AKfycbxHbYHbrGMXYD2-bC-C43D3njIbU-wGiYQuJL61H4vyy6YVXkybMNNEPJNPPuZrD1gRVA/exec';
    const params = new URLSearchParams({
      encrypted_data: String(sourcesResp.sources),
      nonce: nonce,
      secret: String(secret || ''),
    });
    // Some servers expect 'nonce' as '_k' or 'nonce'; try both key names
    if (!params.has('_k')) params.append('_k', nonce);

    const { data: decodedText } = await client.get<string>(
      `${decodeBase}?${params.toString()}`,
      {
        responseType: 'text',
        headers: { 'User-Agent': mobileUA }
      }
    );
    const match = /\"file\":\"(.*?)\"/.exec(decodedText);
    if (match) fileUrl = match[1].replace(/\\\//g, '/');
    
    // Try to extract tracks from decoded text
    const tracksMatch = /\"tracks\":\[(.*?)\]/s.exec(decodedText);
    if (tracksMatch) {
      try {
        const tracksJson = JSON.parse(`[${tracksMatch[1]}]`);
        tracks = tracksJson;
      } catch (e) {
        // If parsing fails, leave tracks empty
      }
    }
    
    // Try to extract intro from decoded text
    const introMatch = /\"intro\":\{\"start\":(\d+),\"end\":(\d+)\}/.exec(decodedText);
    if (introMatch) {
      intro = { start: parseInt(introMatch[1]), end: parseInt(introMatch[2]) };
    }
    
    // Try to extract outro from decoded text
    const outroMatch = /\"outro\":\{\"start\":(\d+),\"end\":(\d+)\}/.exec(decodedText);
    if (outroMatch) {
      outro = { start: parseInt(outroMatch[1]), end: parseInt(outroMatch[2]) };
    }
  }

  if (!fileUrl) {
    throw new Error('MegaCloud: failed to extract file URL');
  }

  return {
    headers: {
      Referer: defaultDomain,
      'User-Agent': mobileUA,
    },
    tracks: tracks,
    intro: intro,
    outro: outro,
    sources: [
      {
        url: fileUrl,
        isM3U8: /\.m3u8($|\?)/.test(fileUrl),
      }
    ],
  };
}

export default {
  getEpisodeServers,
  getEpisodeSources
};