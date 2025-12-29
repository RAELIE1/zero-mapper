import axios from 'axios';

interface EpisodePlayer {
  [playerName: string]: string;
}

interface EpisodeData {
  episode: number;
  players: EpisodePlayer;
}

interface VideoSource {
  url: string;
  quality: string;
  isM3U8: boolean;
}

interface ExtractedSources {
  sources: VideoSource[];
  headers?: Record<string, string>;
}

const REQUEST_TIMEOUT = 15000;

/**
 * Unpacker for packed JavaScript (commonly used by video hosts)
 */
function unpackJs(packed: string): string {
  try {
    const match = packed.match(/}\('(.+)',(\d+),(\d+),'(.+)'\.split\('\|'\)/);
    if (!match) return '';

    const payload = match[1].replace(/\\'/g, "'");
    const radix = parseInt(match[2]);
    const count = parseInt(match[3]);
    const symbols = match[4].split('|');

    let unpacked = payload;

    for (let i = count - 1; i >= 0; i--) {
      if (symbols[i]) {
        const token = i.toString(radix);
        const regex = new RegExp('\\b' + token + '\\b', 'g');
        unpacked = unpacked.replace(regex, symbols[i]);
      }
    }

    return unpacked;
  } catch {
    return '';
  }
}

/**
 * Extract sources from VidMoly
 */
async function extractVidMoly(embedUrl: string): Promise<VideoSource[]> {
  try {
    // CRITICAL: Convert vidmoly.to to vidmoly.net
    const url = embedUrl.replace('vidmoly.to', 'vidmoly.net');
    
    const { data } = await axios.get(url, {
      headers: {
        'Referer': new URL(embedUrl).origin, // Use original URL origin for referer
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    // Try to extract the file URL
    const patterns = [
      /file:\s*"([^"]+)"/,
      /sources:\s*\[\s*{\s*file:\s*"([^"]+)"/,
      /source\s*src="([^"]+\.m3u8[^"]*)"/,
    ];

    let masterUrl = '';
    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match && match[1]) {
        masterUrl = match[1];
        break;
      }
    }

    if (!masterUrl) {
      console.warn(`VidMoly: Could not find video source`);
      return [];
    }

    // Try to fetch the master playlist for quality options
    try {
      const m3u8Response = await axios.get(masterUrl, {
        headers: {
          'Referer': url, // Use the converted .net URL
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: REQUEST_TIMEOUT,
      });

      const sources: VideoSource[] = [{
        quality: 'auto',
        url: masterUrl,
        isM3U8: true,
      }];

      // Parse variant playlists
      if (m3u8Response.data.includes('#EXT-X-STREAM-INF')) {
        const videoList = m3u8Response.data.split('#EXT-X-STREAM-INF:');
        
        for (const video of videoList) {
          if (!video.includes('m3u8')) continue;

          const lines = video.split('\n');
          const variantUrl = lines[1]?.trim();
          
          if (!variantUrl) continue;

          const resolutionMatch = video.match(/RESOLUTION=(\d+)x(\d+)/);
          const quality = resolutionMatch ? `${resolutionMatch[2]}p` : 'unknown';

          sources.push({
            url: variantUrl,
            quality,
            isM3U8: true,
          });
        }
      }

      return sources;
    } catch {
      // Return just the master URL if we can't parse variants
      return [{
        quality: 'auto',
        url: masterUrl,
        isM3U8: true,
      }];
    }
  } catch (error) {
    console.error(`VidMoly extraction error:`, error);
    return [];
  }
}

/**
 * Extract sources from MoveArnPre
 */
async function extractMoveArnPre(embedUrl: string): Promise<VideoSource[]> {
  try {
    const { data } = await axios.get(embedUrl, {
      headers: {
        'Referer': new URL(embedUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    let masterUrl = '';

    // Try to find packed JavaScript
    const packedMatch = data.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?}\('(.+)',(\d+),(\d+),'(.+?)'\.split\('\|'\)\)\)/);
    
    if (packedMatch) {
      const unpacked = unpackJs(packedMatch[0]);
      
      if (unpacked) {
        // Try to find HLS URLs
        const hlsMatches: Record<string, string> = {};
        const hlsPattern = /["']hls(\d+)["']:\s*["']([^"']+)["']/g;
        let match;
        
        while ((match = hlsPattern.exec(unpacked)) !== null) {
          const url = match[2];
          if (!url.endsWith('.txt') && (url.includes('.m3u8') || url.includes('/stream/'))) {
            hlsMatches[`hls${match[1]}`] = url;
          }
        }
        
        // Priority order for quality
        const priority = ['hls4', 'hls2', 'hls3'];
        for (const key of priority) {
          if (hlsMatches[key]) {
            masterUrl = hlsMatches[key];
            break;
          }
        }
        
        // Fallback patterns
        if (!masterUrl) {
          const patterns = [
            /file:\s*["']([^"']*master\.m3u8[^"']*)["']/,
            /["']([^"']*\/stream\/[^"']*master\.m3u8[^"']*)["']/,
          ];

          for (const pattern of patterns) {
            const match = unpacked.match(pattern);
            if (match?.[1]) {
              masterUrl = match[1];
              break;
            }
          }
        }
      }
    }

    // Try direct patterns if unpacking failed
    if (!masterUrl) {
      const patterns = [
        /sources:\s*\[\s*\{\s*file:\s*["']([^"']+)["']/,
        /file:\s*["']([^"']*master\.m3u8[^"']*)["']/,
        /["']([^"']*\/stream\/[^"']*master\.m3u8[^"']*)["']/,
      ];

      for (const pattern of patterns) {
        const match = data.match(pattern);
        if (match?.[1]) {
          masterUrl = match[1];
          break;
        }
      }
    }

    if (!masterUrl) return [];

    // Make relative URLs absolute
    if (masterUrl.startsWith('/')) {
      masterUrl = `${new URL(embedUrl).origin}${masterUrl}`;
    }

    try {
      const { data: m3u8Data } = await axios.get(masterUrl, {
        headers: {
          'Referer': embedUrl,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        timeout: REQUEST_TIMEOUT,
      });

      const sources: VideoSource[] = [{
        quality: 'auto',
        url: masterUrl,
        isM3U8: true,
      }];

      // Parse variants
      if (m3u8Data.includes('#EXT-X-STREAM-INF')) {
        const variants = m3u8Data.split('#EXT-X-STREAM-INF:');

        for (const variant of variants) {
          if (!variant.includes('m3u8')) continue;

          const lines = variant.split('\n');
          const variantUrl = lines[1]?.trim();
          if (!variantUrl) continue;

          const resMatch = variant.match(/RESOLUTION=\d+x(\d+)/);
          const quality = resMatch ? `${resMatch[1]}p` : 'unknown';

          let fullUrl = variantUrl;
          if (!variantUrl.startsWith('http')) {
            const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
            fullUrl = baseUrl + variantUrl;
          }

          sources.push({
            url: fullUrl,
            quality,
            isM3U8: true,
          });
        }
      }

      return sources;
    } catch {
      return [{
        quality: 'auto',
        url: masterUrl,
        isM3U8: true,
      }];
    }
  } catch (error) {
    console.error(`MoveArnPre extraction error:`, error);
    return [];
  }
}

/**
 * Extract sources from Sibnet
 */
async function extractSibnet(embedUrl: string): Promise<VideoSource[]> {
  try {
    const { data } = await axios.get(embedUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
        'Referer': 'https://video.sibnet.ru/',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const srcMatch = data.match(/player\.src\(\[\{src:\s*"([^"]+)",\s*type:\s*"([^"]+)"/);
    
    if (!srcMatch) {
      throw new Error('Could not find video source');
    }

    const videoPath = srcMatch[1];
    const videoType = srcMatch[2];

    const fullUrl = videoPath.startsWith('http') 
      ? videoPath 
      : `https://video.sibnet.ru${videoPath}`;

    return [{
      url: fullUrl,
      quality: 'default',
      isM3U8: videoType.includes('m3u8') || fullUrl.includes('.m3u8'),
    }];
  } catch (error) {
    console.error(`Sibnet extraction error:`, error);
    return [];
  }
}

/**
 * Extract sources from Sendvid
 */
async function extractSendvid(embedUrl: string): Promise<VideoSource[]> {
  try {
    const { data } = await axios.get(embedUrl, {
      headers: {
        'Referer': new URL(embedUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const patterns = [
      /og:video"\s*content="([^"]+)"/,
      /<source\s+src="([^"]+)"/,
      /file:\s*"([^"]+)"/,
    ];

    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match && match[1]) {
        return [{
          url: match[1],
          quality: 'default',
          isM3U8: match[1].includes('.m3u8'),
        }];
      }
    }

    return [];
  } catch (error) {
    console.error(`Sendvid extraction error:`, error);
    return [];
  }
}

/**
 * Extract sources from Lpayer (embed4me)
 */
async function extractLpayer(embedUrl: string): Promise<VideoSource[]> {
  try {
    const { data } = await axios.get(embedUrl, {
      headers: {
        'Referer': new URL(embedUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const patterns = [
      /file:\s*["']([^"']+\.m3u8[^"']*)["']/,
      /source[^>]*src=["']([^"']+)["']/,
      /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g,
    ];

    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        return [{
          url,
          quality: 'default',
          isM3U8: url.includes('.m3u8'),
        }];
      }
    }

    return [];
  } catch (error) {
    console.error(`Lpayer extraction error:`, error);
    return [];
  }
}

/**
 * Generic extractor fallback
 */
async function extractGeneric(embedUrl: string): Promise<VideoSource[]> {
  try {
    const { data } = await axios.get(embedUrl, {
      headers: {
        'Referer': new URL(embedUrl).origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const patterns = [
      /file:\s*["']([^"']+\.m3u8[^"']*)["']/,
      /source[^>]*src=["']([^"']+)["']/,
      /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g,
    ];

    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match) {
        const url = match[1] || match[0];
        return [{
          url,
          quality: 'default',
          isM3U8: url.includes('.m3u8'),
        }];
      }
    }

    return [];
  } catch (error) {
    console.error(`Generic extraction error:`, error);
    return [];
  }
}

/**
 * Main extraction router - detects server type and extracts accordingly
 */
export async function extractSources(embedUrl: string): Promise<ExtractedSources> {
  console.log(`[AnimeSama] Extracting from: ${embedUrl}`);

  try {
    let sources: VideoSource[] = [];
    
    // Convert vidmoly.to to vidmoly.net for the referer as well
    const refererUrl = embedUrl.includes('vidmoly') 
      ? embedUrl.replace('vidmoly.to', 'vidmoly.net')
      : embedUrl;

    // Route to appropriate extractor based on URL
    if (embedUrl.includes('vidmoly')) {
      sources = await extractVidMoly(embedUrl);
    } else if (embedUrl.includes('movearnpre')) {
      sources = await extractMoveArnPre(embedUrl);
    } else if (embedUrl.includes('sibnet')) {
      sources = await extractSibnet(embedUrl);
    } else if (embedUrl.includes('sendvid')) {
      sources = await extractSendvid(embedUrl);
    } else if (embedUrl.includes('embed4me') || embedUrl.includes('lpayer')) {
      sources = await extractLpayer(embedUrl);
    } else {
      // Try generic extraction
      sources = await extractGeneric(embedUrl);
    }

    return {
      sources,
      headers: {
        Referer: refererUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };
  } catch (error) {
    console.error(`[AnimeSama] Extraction failed:`, error);
    throw new Error(`Failed to extract sources from ${embedUrl}`);
  }
}

/**
 * Fetch episodes.js data for a specific season
 * EXPORTED for use in servers endpoint
 */
export async function fetchEpisodesData(
  animeId: string,
  seasonSlug: string,
  language: string
): Promise<EpisodeData[]> {
  try {
    const animeUrl = `https://anime-sama.tv/catalogue/${animeId}/`;
    const episodesUrl = `https://anime-sama.tv/catalogue/${animeId}/${seasonSlug}/${language}/`;
    
    const response = await axios.get(episodesUrl, {
      headers: {
        'Referer': animeUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const html = response.data;

    // Find episodes.js reference
    const episodesJsMatch = html.match(/src\s*=\s*['"]([^'"]*episodes\.js[^'">\s]*)/);
    
    if (!episodesJsMatch) {
      throw new Error('Could not find episodes.js reference');
    }

    const episodesJsUrl = new URL(episodesJsMatch[1], episodesUrl).href;
    
    const jsResponse = await axios.get(episodesJsUrl, {
      headers: {
        'Referer': episodesUrl,
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: REQUEST_TIMEOUT,
    });

    const episodesJs = jsResponse.data;
    const episodeData: EpisodeData[] = [];
    const epsRegex = /var eps(\d+)\s*=\s*\[([\s\S]*?)\];/g;
    let match;

    while ((match = epsRegex.exec(episodesJs)) !== null) {
      const playerNumber = match[1];
      const urlsString = match[2];

      const urls = urlsString
        .split(',')
        .map((u: string) => u.trim().replace(/^['"]|['"]$/g, ''))
        .filter((u: string) => u.length > 0);

      urls.forEach((embedUrl: string, index: number) => {
        if (!episodeData[index]) {
          episodeData[index] = {
            episode: index + 1,
            players: {},
          };
        }
        episodeData[index].players[`Player ${playerNumber}`] = embedUrl;
      });
    }

    return episodeData;
  } catch (error) {
    console.error(`[AnimeSama] Failed to fetch episodes:`, error);
    throw new Error(`Failed to fetch episodes data`);
  }
}

/**
 * Find best server URL from available players
 */
function findServerUrl(players: EpisodePlayer, serverPreference: string): string | null {
  const serverKeywords: Record<string, string[]> = {
    vidmoly: ['vidmoly.net', 'vidmoly.to', 'vidmoly'],
    sibnet: ['sibnet.ru', 'sibnet'],
    sendvid: ['sendvid.com', 'sendvid'],
    movearnpre: ['movearnpre.com', 'movearnpre'],
    doodstream: ['doodstream', 'dood'],
    lpayer: ['lpayer.embed4me.com', 'embed4me', 'lpayer'],
    oneupload: ['oneupload.to', 'oneupload'],
  };

  const keywords = serverKeywords[serverPreference.toLowerCase()] || [serverPreference.toLowerCase()];

  for (const [, url] of Object.entries(players)) {
    for (const keyword of keywords) {
      if (url.toLowerCase().includes(keyword)) {
        return url;
      }
    }
  }
  
  return null;
}

/**
 * Get HLS sources for a specific episode
 */
export async function getEpisodeHLS(
  animeId: string,
  seasonSlug: string,
  episodeNumber: number,
  language: string = 'vostfr',
  serverPreference: string = 'auto'
): Promise<ExtractedSources> {
  try {
    const episodes = await fetchEpisodesData(animeId, seasonSlug, language);
    
    const episode = episodes[episodeNumber - 1];
    if (!episode) {
      throw new Error(`Episode ${episodeNumber} not found (available: 1-${episodes.length})`);
    }

    let serverUrl: string | null = null;
    
    if (serverPreference === 'auto') {
      // Try servers in order of preference
      const preferenceOrder = ['vidmoly', 'movearnpre', 'sibnet', 'sendvid', 'lpayer'];
      for (const server of preferenceOrder) {
        serverUrl = findServerUrl(episode.players, server);
        if (serverUrl) {
          console.log(`[AnimeSama] Using ${server} server`);
          break;
        }
      }
    } else {
      serverUrl = findServerUrl(episode.players, serverPreference);
    }

    if (!serverUrl) {
      const availableServers = Object.keys(episode.players).join(', ');
      throw new Error(
        `No ${serverPreference} server found. Available: ${availableServers}`
      );
    }

    return await extractSources(serverUrl);
  } catch (error) {
    console.error(`[AnimeSama] getEpisodeHLS error:`, error);
    throw error;
  }
}
