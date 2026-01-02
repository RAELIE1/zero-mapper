import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';
import { Redis } from 'ioredis';
import { ANIME } from '@consumet/extensions';
import { AnimeKai } from './providers/animekai.js';
import { mapAnilistToAnimePahe, mapAnilistToHiAnime, mapAnilistToAnimeKai, mapAnilistToAnimeSama } from './mappers/index.js';
import { AniList } from './providers/anilist.js';
import { AnimePahe } from './providers/animepahe.js';
import { getEpisodeServers, getEpisodeSources } from './providers/hianime-servers.js';
import { cache } from './utils/cache.js';
import { AnimeMapper } from './mappers/cross-mapper.js';
import { getEpisodeHLS } from './providers/animesama-sources.js';
import FlixHQ from './providers/flixhq/flixhq.js';
import cacheUtils from './utils/redis-cache.js';
import { mapAniListToAnicrush, getCommonHeaders } from './providers/anicrush/mapper.js';
import { getHlsLink } from './providers/anicrush/hls.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

let redis: Redis | null = null;
let redisConnectionAttempts = 0;
const MAX_REDIS_CONNECTION_ATTEMPTS = 3;

if (process.env.REDIS_HOST) {
  try {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times >= MAX_REDIS_CONNECTION_ATTEMPTS) {
          return null;
        }
        return Math.min(times * 200, 1000);
      }
    });
    
    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message);
      redisConnectionAttempts++;
      
      if (redisConnectionAttempts >= MAX_REDIS_CONNECTION_ATTEMPTS) {
        console.warn(`Failed to connect to Redis after ${MAX_REDIS_CONNECTION_ATTEMPTS} attempts. Disabling Redis cache.`);
        if (redis) {
          redis.disconnect();
          redis = null;
        }
      }
    });
    
    redis.on('connect', () => {
      console.log(`Successfully connected to Redis at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
      redisConnectionAttempts = 0;
    });
  } catch (err) {
    console.error('Failed to initialize Redis client:', err);
    redis = null;
  }
}

const memoryCache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_SECONDS = 60 * 60 * 12;

async function cacheGet<T>(key: string): Promise<T | null> {
  if (redis) {
    try {
      return await cacheUtils.get<T>(redis, key);
    } catch (err) {
    }
  }

  const cached = memoryCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return JSON.parse(cached.value);
}

async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<T> {
  if (redis) {
    try {
      return await cacheUtils.set(redis, key, async () => value, ttlSeconds);
    } catch (err) {
      memoryCache.set(key, { 
        value: JSON.stringify(value), 
        expiresAt: Date.now() + ttlSeconds * 1000 
      });
    }
  } else {
    memoryCache.set(key, { 
      value: JSON.stringify(value), 
      expiresAt: Date.now() + ttlSeconds * 1000 
    });
  }
  return value;
}

async function cacheFetch<T>(key: string, fetcher: () => Promise<T>, ttlSeconds: number = CACHE_TTL_SECONDS): Promise<T> {
  if (redis) {
    try {
      return await cacheUtils.fetch(redis, key, fetcher, ttlSeconds);
    } catch (err) {
      return fetcher();
    }
  }
  
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;
  
  const value = await fetcher();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

const TMDB_API_KEY = process.env.TMDB_API_KEY || '61e2290429798c561450eb56b26de19b';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';
const POSTER_SIZE = 'w500';
const BACKDROP_SIZE = 'original';

const flixhq = new FlixHQ();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/animepahe/map/:anilistId', cache('5 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId } = req.params;
    if (!anilistId) return res.status(400).json({ error: 'AniList ID is required' });
    
    const mappingResult = await mapAnilistToAnimePahe(anilistId);
    return res.json(mappingResult);
  } catch (error: any) {
    console.error('Mapping error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/hianime/:anilistId', cache('5 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId } = req.params;
    if (!anilistId) return res.status(400).json({ error: 'AniList ID is required' });
    
    const episodes = await mapAnilistToHiAnime(anilistId);
    return res.json(episodes);
  } catch (error: any) {
    console.error('HiAnime mapping error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/hianime/servers/:animeId', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { animeId } = req.params;
    const { ep } = req.query;
    if (!animeId) return res.status(400).json({ error: 'Anime ID is required' });
    
    const episodeId = ep ? `${animeId}?ep=${ep}` : animeId;
    const servers = await getEpisodeServers(episodeId);
    return res.json(servers);
  } catch (error: any) {
    console.error('HiAnime servers error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/hianime/sources/:animeId', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { animeId } = req.params;
    const { ep, server = 'hd-1', category = 'sub' } = req.query;
    
    if (!animeId || !ep) {
      return res.status(400).json({ error: 'Both anime ID and episode number (ep) are required' });
    }
    
    const episodeId = `${animeId}?ep=${ep}`;
    const sources = await getEpisodeSources(episodeId, String(server), category as 'sub' | 'dub' | 'raw');
    
    return res.json({ success: true, data: sources });
  } catch (error: any) {
    console.error('HiAnime sources error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/animekai/map/:anilistId', cache('5 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId } = req.params;
    if (!anilistId) return res.status(400).json({ error: 'AniList ID is required' });
    
    const mappingResult = await mapAnilistToAnimeKai(anilistId);
    return res.json(mappingResult);
  } catch (error: any) {
    console.error('AnimeKai mapping error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/animesama/map/:anilistId', cache('5 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId } = req.params;
    if (!anilistId) return res.status(400).json({ error: 'AniList ID is required' });
    
    const mappingResult = await mapAnilistToAnimeSama(anilistId);
    return res.json(mappingResult);
  } catch (error: any) {
    console.error('AnimeSama mapping error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/animekai/sources/:episodeId', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { episodeId } = req.params;
    const { server, dub } = req.query;
    if (!episodeId) return res.status(400).json({ error: 'Episode ID is required' });
    
    const animeKai = new AnimeKai();
    const isDub = dub === 'true' || dub === '1';
    const sources = await animeKai.fetchEpisodeSources(episodeId, server as string | undefined, isDub);
    
    return res.json(sources);
  } catch (error: any) {
    console.error('AnimeKai sources error:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/animepahe/sources/:session/:episodeId', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { session, episodeId } = req.params;
    const fullEpisodeId = `${session}/${episodeId}`;
    const animePahe = new AnimePahe();
    const sources = await animePahe.scrapeEpisodesSrcs(fullEpisodeId);
    
    return res.status(200).json(sources);
  } catch (error: any) {
    console.error('Error fetching episode sources:', error.message);
    return res.status(500).json({ 
      error: error.message,
      message: 'Failed to fetch episode sources. If you receive a 403 error, add Referer: "https://kwik.cx/" header.'
    });
  }
});

app.get('/animepahe/sources/:id', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const episodeId = req.params.id;
    if (!episodeId) return res.status(400).json({ error: 'Episode ID is required' });
    
    const animePahe = new AnimePahe();
    const sources = await animePahe.scrapeEpisodesSrcs(episodeId);
    
    return res.status(200).json(sources);
  } catch (error: any) {
    console.error('Error fetching episode sources:', error.message);
    return res.status(500).json({ 
      error: error.message,
      message: 'Failed to fetch episode sources. If you receive a 403 error, add Referer: "https://kwik.cx/" header.'
    });
  }
});

app.get('/animepahe/hls/:anilistId/:episode', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId, episode } = req.params;
    if (!anilistId || !episode) {
      return res.status(400).json({ error: 'Both AniList ID and episode number are required' });
    }
    
    const mappingResult = await mapAnilistToAnimePahe(anilistId);
    
    if (!mappingResult.animepahe?.episodes?.length) {
      return res.status(404).json({ error: 'No episodes found for this anime on AnimePahe' });
    }
    
    let targetEpisode = mappingResult.animepahe.episodes.find(ep => ep.number === parseInt(episode, 10));

    if (!targetEpisode) {
      const requestedIndex = parseInt(episode, 10) - 1;
      const episodesArr = mappingResult.animepahe.episodes;
      if (requestedIndex >= 0 && requestedIndex < episodesArr.length) {
        targetEpisode = episodesArr[requestedIndex];
      }
    }

    if (!targetEpisode) {
      return res.status(404).json({ error: `Episode ${episode} not found on AnimePahe` });
    }
    
    const animePahe = new AnimePahe();
    const sources = await animePahe.scrapeEpisodesSrcs(targetEpisode.episodeId);
    
    return res.status(200).json({ sources, image: targetEpisode.image || '' });
  } catch (error: any) {
    console.error('Error fetching HLS sources:', error.message);
    return res.status(500).json({ 
      error: error.message,
      message: 'Failed to fetch HLS sources. If you receive a 403 error, add Referer: "https://kwik.cx/" header.'
    });
  }
});

app.get('/animesama/servers/:anilistId/:episode', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId, episode } = req.params;
    const { season = 'saison1', category = 'sub' } = req.query;
    
    if (!anilistId || !episode) {
      return res.status(400).json({ error: 'Both AniList ID and episode number are required' });
    }

    // Map category to AnimeSama language format
    const language = category === 'dub' ? 'vf' : 'vostfr';

    // First get the AnimeSama mapping
    const mappingResult = await mapAnilistToAnimeSama(anilistId);
    
    if (!mappingResult.animesamaSlug) {
      return res.status(404).json({ error: 'Anime not found on AnimeSama' });
    }

    // Use the best matched season or the one specified in query
    const seasonSlug = (season as string) === 'saison1' && mappingResult.seasonSlug 
      ? mappingResult.seasonSlug 
      : season as string;

    // Get episodes data to extract available servers
    const { fetchEpisodesData } = await import('./providers/animesama-sources.js');
    const episodes = await fetchEpisodesData(
      mappingResult.animesamaSlug,
      seasonSlug,
      language
    );
    
    const episodeData = episodes[parseInt(episode, 10) - 1];
    if (!episodeData) {
      return res.status(404).json({ 
        error: `Episode ${episode} not found`,
        availableEpisodes: `1-${episodes.length}`
      });
    }

    // Extract server types from player URLs and sort by player number
    const servers = Object.entries(episodeData.players)
      .map(([playerName, url]) => {
        let serverType = 'unknown';
        
        if (url.includes('vidmoly')) serverType = 'vidmoly';
        else if (url.includes('movearnpre')) serverType = 'movearnpre';
        else if (url.includes('sibnet')) serverType = 'sibnet';
        else if (url.includes('sendvid')) serverType = 'sendvid';
        else if (url.includes('embed4me') || url.includes('lpayer')) serverType = 'lpayer';
        else if (url.includes('doodstream')) serverType = 'doodstream';
        else if (url.includes('oneupload')) serverType = 'oneupload';

        // Extract player number for sorting
        const playerNumber = parseInt(playerName.match(/\d+/)?.[0] || '0');

        return {
          name: playerName,
          serverType,
          url,
          _sortOrder: playerNumber
        };
      })
      .sort((a, b) => a._sortOrder - b._sortOrder)
      .map(({ _sortOrder, ...server }) => server); // Remove sort field from final output

    return res.json({
      anilistId: parseInt(anilistId),
      animesamaSlug: mappingResult.animesamaSlug,
      seasonSlug,
      episode: parseInt(episode, 10),
      category,
      totalServers: servers.length,
      servers
    });
  } catch (error: any) {
    console.error('AnimeSama servers error:', error.message);
    return res.status(500).json({ 
      error: error.message,
      message: 'Failed to fetch servers from AnimeSama'
    });
  }
});

app.get('/animesama/hls/:anilistId/:episode', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId, episode } = req.params;
    const { season = 'saison1', category = 'sub', server = 'auto' } = req.query;
    
    if (!anilistId || !episode) {
      return res.status(400).json({ error: 'Both AniList ID and episode number are required' });
    }

    // Map category to AnimeSama language format
    const language = category === 'dub' ? 'vf' : 'vostfr';

    // First get the AnimeSama mapping
    const mappingResult = await mapAnilistToAnimeSama(anilistId);
    
    if (!mappingResult.animesamaSlug) {
      return res.status(404).json({ error: 'Anime not found on AnimeSama' });
    }

    // Use the best matched season or the one specified in query
    const seasonSlug = (season as string) === 'saison1' && mappingResult.seasonSlug 
      ? mappingResult.seasonSlug 
      : season as string;

    // Get HLS sources
    const sources = await getEpisodeHLS(
      mappingResult.animesamaSlug,
      seasonSlug,
      parseInt(episode, 10),
      language,
      server as string
    );

    return res.json({
      anilistId: parseInt(anilistId),
      animesamaSlug: mappingResult.animesamaSlug,
      seasonSlug,
      episode: parseInt(episode, 10),
      category,
      server,
      ...sources
    });
  } catch (error: any) {
    console.error('AnimeSama HLS error:', error.message);
    return res.status(500).json({ 
      error: error.message,
      message: 'Failed to fetch HLS sources from AnimeSama'
    });
  }
});

app.get('/map', cache('15 minutes'), async (req: Request, res: Response) => {
  try {
    const { title, anilistId, malId, tmdbId, mediaType } = req.query;

    const tmdbApiKey = process.env.TMDB_API_KEY;
    const malClientId = process.env.MAL_CLIENT_ID;

    if (!tmdbApiKey) {
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'TMDB_API_KEY not configured. Add it to your environment variables.'
      });
    }

    const mapper = new AnimeMapper(tmdbApiKey, malClientId);
    let result;

    if (anilistId) {
      result = await mapper.mapFromAniList(anilistId as string);
    } else if (malId) {
      if (!malClientId) {
        return res.status(400).json({
          error: 'MAL Client ID not configured',
          message: 'MAL_CLIENT_ID required for MAL operations. Add it to environment variables.'
        });
      }
      result = await mapper.mapFromMAL(malId as string);
    } else if (tmdbId) {
      const type = (mediaType as 'tv' | 'movie') || 'tv';
      result = await mapper.mapFromTMDB(tmdbId as string, type);
    } else if (title) {
      result = await mapper.crossReference(title as string);
    } else {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Provide one of: title, anilistId, malId, or tmdbId',
        examples: {
          byTitle: '/map?title=Attack on Titan',
          byAniList: '/map?anilistId=16498',
          byMAL: '/map?malId=16498',
          byTMDB: '/map?tmdbId=1429&mediaType=tv'
        }
      });
    }

    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Cross-mapping error:', error.message);
    return res.status(500).json({
      error: 'Failed to map anime',
      message: error.message
    });
  }
});

interface TMDBSearchResponse {
  page: number;
  results: any[];
  total_results: number;
  total_pages: number;
}

interface TMDBMovieDetails {
  id: number;
  title: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  release_date: string;
}

interface TMDBTVDetails {
  id: number;
  name: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  first_air_date: string;
  number_of_seasons: number;
}

interface TMDBEpisodeDetails {
  id: number;
  name: string;
  overview: string;
  still_path: string;
  episode_number: number;
  season_number: number;
  air_date: string;
}

async function searchTMDB(query: string, type: string = 'multi'): Promise<TMDBSearchResponse> {
  const cacheKey = `tmdb:search:${type}:${encodeURIComponent(query.toLowerCase())}`;
  
  return cacheFetch<TMDBSearchResponse>(cacheKey, async () => {
    const response = await axios.get(`${TMDB_BASE_URL}/search/${type}`, {
      params: {
        api_key: TMDB_API_KEY,
        query: query,
        include_adult: false
      }
    });
    return response.data;
  });
}

async function getTMDBDetails(id: string, type: string): Promise<TMDBMovieDetails | TMDBTVDetails> {
  const cacheKey = `tmdb:details:${type}:${id}`;
  
  return cacheFetch<TMDBMovieDetails | TMDBTVDetails>(cacheKey, async () => {
    const response = await axios.get(`${TMDB_BASE_URL}/${type}/${id}`, {
      params: {
        api_key: TMDB_API_KEY
      }
    });
    return response.data;
  });
}

function isTitleSimilarEnough(title1: string, title2: string): boolean {
  title1 = title1.toLowerCase().trim();
  title2 = title2.toLowerCase().trim();

  if (title1 === title2) {
    return true;
  }

  const words1 = title1.split(/\s+/).filter(w => w.length > 0);
  const words2 = title2.split(/\s+/).filter(w => w.length > 0);

  if (words1.length <= 2 || words2.length <= 2) {
    const isSubstring = title1.includes(title2) || title2.includes(title1);
    if (isSubstring) {
      return true;
    }
  }

  const commonWords = words1.filter(word => words2.includes(word));
  const wordOverlapRatio = commonWords.length / Math.min(words1.length, words2.length);

  if (wordOverlapRatio < 0.7) {
    return false;
  }

  return true;
}

interface FlixHQSearchResult {
  id: string;
  title: string;
  type: string;
  releaseDate?: string;
  seasons?: number;
}

interface FlixHQSearchResponse {
  results: FlixHQSearchResult[];
}

function findBestFlixHQMatch(searchResults: FlixHQSearchResponse, tmdbDetails: TMDBMovieDetails | TMDBTVDetails, type: string): FlixHQSearchResult | null {
  const isMovie = type === 'MOVIE';
  const tmdbTitle = (isMovie ? (tmdbDetails as TMDBMovieDetails).title : (tmdbDetails as TMDBTVDetails).name).toLowerCase();

  const relevantResults = searchResults.results.filter((m: FlixHQSearchResult) => m.type === type);

  if (relevantResults.length === 0) {
    console.log(`No relevant ${type} results found in FlixHQ search for "${tmdbTitle}".`);
    return null;
  }

  let bestMatch: FlixHQSearchResult | null = null;

  if (!isMovie) {
    const tmdbNumberOfSeasons = (tmdbDetails as TMDBTVDetails).number_of_seasons;
    if (tmdbNumberOfSeasons !== undefined) {
      const foundMatch = relevantResults.find((show: FlixHQSearchResult) => {
        const flixHQSeasons = show.seasons;
        return isTitleSimilarEnough(show.title, tmdbTitle) &&
               flixHQSeasons === tmdbNumberOfSeasons;
      });
      bestMatch = foundMatch || null;

      if (bestMatch) {
        console.log(`Found exact title & season match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Seasons: ${bestMatch.seasons}`);
        return bestMatch;
      }

      const matchingTitleShows = relevantResults.filter((show: FlixHQSearchResult) => isTitleSimilarEnough(show.title, tmdbTitle));
      if (matchingTitleShows.length > 0) {
        const reducedMatch = matchingTitleShows.reduce((closest: FlixHQSearchResult, current: FlixHQSearchResult) => {
          const currentSeasons = current.seasons || 0;
          const closestSeasons = closest.seasons || 0;
          const diffCurrent = Math.abs(currentSeasons - tmdbNumberOfSeasons);
          const diffClosest = Math.abs(closestSeasons - tmdbNumberOfSeasons);

          if (diffCurrent < diffClosest) {
            return current;
          }
          return closest;
        }, matchingTitleShows[0]);
        bestMatch = reducedMatch || null;
        if (bestMatch) {
          console.log(`Found closest season match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Seasons: ${bestMatch.seasons}`);
          return bestMatch;
        }
        return null;
      }
    }
  }

  const tmdbYear = (isMovie ? (tmdbDetails as TMDBMovieDetails).release_date : (tmdbDetails as TMDBTVDetails).first_air_date)?.substring(0, 4);
  const tmdbYearNum = parseInt(tmdbYear || '0');

  const exactMatch = relevantResults.find((m: FlixHQSearchResult) => {
    const flixYear = m.releaseDate ? m.releaseDate.split('-')[0] : undefined;
    return isTitleSimilarEnough(m.title, tmdbTitle) && flixYear === tmdbYear;
  });
  bestMatch = exactMatch || null;

  if (bestMatch) {
    console.log(`Found exact title & year match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
    return bestMatch;
  }

  if (isMovie && tmdbYear && tmdbYear.trim() !== '') {
    console.log(`No exact title & year match found for movie "${tmdbTitle}" (${tmdbYear}). Rejecting non-matching year results.`);
    return null;
  }

  const matchingTitleResults = relevantResults.filter((m: FlixHQSearchResult) => isTitleSimilarEnough(m.title, tmdbTitle));

  if (matchingTitleResults.length > 0) {
    if (tmdbYearNum > 0) {
      const yearMatch = matchingTitleResults.reduce((closest: FlixHQSearchResult, current: FlixHQSearchResult) => {
        const currentYear = parseInt(current.releaseDate ? current.releaseDate.split('-')[0] : '0');
        const closestYear = parseInt(closest.releaseDate ? closest.releaseDate.split('-')[0] : '0');
        const diffCurrent = Math.abs(currentYear - tmdbYearNum);
        const diffClosest = Math.abs(closestYear - tmdbYearNum);

        if (diffCurrent < diffClosest) {
          return current;
        }
        return closest;
      }, matchingTitleResults[0]);
      bestMatch = yearMatch || null;
      if (bestMatch) {
        console.log(`Found closest year match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
        return bestMatch;
      }
      return null;
    } else {
      bestMatch = matchingTitleResults[0] || null;
      if (bestMatch) {
        console.log(`Found similar title (no TMDB year) match on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${bestMatch.releaseDate}`);
        return bestMatch;
      }
      return null;
    }
  }

  if (!isMovie) {
    bestMatch = relevantResults[0] || null;
    if (bestMatch) {
      const fallbackYear = bestMatch.releaseDate ? bestMatch.releaseDate.split('-')[0] : 'Unknown';
      console.log(`Fallback (TV): Used first relevant result on FlixHQ: ${bestMatch.title} (ID: ${bestMatch.id}) - Year: ${fallbackYear} (Type: ${bestMatch.type})`);
      return bestMatch;
    }
  }

  console.log(`No suitable ${type} results found on FlixHQ after applying strict filters.`);
  return null;
}

app.get('/anicrush/mapper/:anilistId', cache('5 minutes'), async (req: Request, res: Response) => {
  try {
    const { anilistId } = req.params;
    if (!anilistId) return res.status(400).json({ error: 'AniList ID is required' });
    
    const mappedData = await mapAniListToAnicrush(anilistId);
    res.json(mappedData);
  } catch (error: any) {
    console.error('Error in mapper:', error);
    res.status(500).json({
      error: 'Failed to map AniList ID',
      message: error.message
    });
  }
});

app.get('/anicrush/search', async (req: Request, res: Response) => {
  try {
    const { keyword, page = 1, limit = 24 } = req.query;

    if (!keyword) {
      return res.status(400).json({ error: 'Search keyword is required' });
    }

    const headers = getCommonHeaders();

    const response = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/movie/list`,
      params: {
        keyword,
        page,
        limit
      },
      headers
    });

    res.json(response.data);
  } catch (error: any) {
    console.error('Error searching anime:', error);
    res.status(500).json({
      error: 'Failed to search anime',
      message: error.message
    });
  }
});

app.get('/anicrush/episodes', async (req: Request, res: Response) => {
  try {
    const { movieId } = req.query;

    if (!movieId) {
      return res.status(400).json({ error: 'Movie ID is required' });
    }

    const headers = getCommonHeaders();

    const response = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/list`,
      params: {
        _movieId: movieId
      },
      headers
    });

    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching episode list:', error);
    res.status(500).json({
      error: 'Failed to fetch episode list',
      message: error.message
    });
  }
});

app.get('/anicrush/servers/:movieId', async (req: Request, res: Response) => {
  try {
    const { movieId } = req.params;
    const { episode } = req.query;

    if (!movieId) {
      return res.status(400).json({ error: 'Movie ID is required' });
    }

    const headers = getCommonHeaders();

    const response = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/servers`,
      params: {
        _movieId: movieId,
        ep: episode || 1
      },
      headers
    });

    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching servers:', error);
    res.status(500).json({
      error: 'Failed to fetch servers',
      message: error.message
    });
  }
});

app.get('/anicrush/sources', async (req: Request, res: Response) => {
  try {
    const { movieId, episode, server, subOrDub } = req.query;

    if (!movieId) {
      return res.status(400).json({ error: 'Movie ID is required' });
    }

    const headers = getCommonHeaders();

    const episodeListResponse = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/list`,
      params: {
        _movieId: movieId
      },
      headers
    });

    if (!episodeListResponse.data || episodeListResponse.data.status === false) {
      return res.status(404).json({ error: 'Episode list not found' });
    }

    const serversResponse = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/servers`,
      params: {
        _movieId: movieId,
        ep: episode || 1
      },
      headers
    });

    if (!serversResponse.data || serversResponse.data.status === false) {
      return res.status(404).json({ error: 'Servers not found' });
    }

    const sourcesResponse = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/sources`,
      params: {
        _movieId: movieId,
        ep: episode || 1,
        sv: server || 4,
        sc: subOrDub || 'sub'
      },
      headers
    });

    res.json(sourcesResponse.data);
  } catch (error: any) {
    console.error('Error fetching anime sources:', error);
    res.status(500).json({
      error: 'Failed to fetch anime sources',
      message: error.message
    });
  }
});

app.get('/anicrush/hls/:movieId', async (req: Request, res: Response) => {
  try {
    const { movieId } = req.params;
    const { episode = 1, server = 4, subOrDub = 'sub' } = req.query;

    if (!movieId) {
      return res.status(400).json({ error: 'Movie ID is required' });
    }

    const headers = getCommonHeaders();

    const embedResponse = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/sources`,
      params: {
        _movieId: movieId,
        ep: episode,
        sv: server,
        sc: subOrDub
      },
      headers
    });

    if (!embedResponse.data || embedResponse.data.status === false) {
      return res.status(404).json({ error: 'Embed link not found' });
    }

    const embedUrl = embedResponse.data.result.link;
    
    const hlsData = await getHlsLink(embedUrl);
    res.json(hlsData);

  } catch (error: any) {
    console.error('Error fetching HLS link:', error);
    res.status(500).json({
      error: 'Failed to fetch HLS link',
      message: error.message
    });
  }
});

app.get('/anicrush/:anilistId/:episodeNum', async (req: Request, res: Response) => {
  try {
    const { anilistId, episodeNum } = req.params;
    const { server = 4, subOrDub = 'sub' } = req.query;

    if (!anilistId) {
      return res.status(400).json({ error: 'AniList ID is required' });
    }

    const mappedData = await mapAniListToAnicrush(anilistId);
    
    if (!mappedData || !mappedData.anicrush_id) {
      return res.status(404).json({ error: 'Anime not found on Anicrush' });
    }
    
    const movieId = mappedData.anicrush_id;
    const headers = getCommonHeaders();

    const embedResponse = await axios({
      method: 'GET',
      url: `https://api.anicrush.to/shared/v2/episode/sources`,
      params: {
        _movieId: movieId,
        ep: episodeNum || 1,
        sv: server,
        sc: subOrDub
      },
      headers
    });

    if (!embedResponse.data || embedResponse.data.status === false) {
      return res.status(404).json({ error: 'Embed link not found' });
    }

    const embedUrl = embedResponse.data.result.link;
    
    const hlsData = await getHlsLink(embedUrl);
    
    const episodeNumber = parseInt(episodeNum as string) || 1;
    
    const response = {
      ...hlsData,
      metadata: {
        title: mappedData.title?.english || mappedData.title?.romaji,
        anilistId: parseInt(anilistId),
        movieId: movieId,
        episode: episodeNumber,
        server: parseInt(server as string) || 4,
        subOrDub: subOrDub || 'sub'
      }
    };
    
    res.json(response);

  } catch (error: any) {
    console.error('Error fetching anime stream:', error);
    res.status(500).json({
      error: 'Failed to fetch anime stream',
      message: error.message
    });
  }
});

app.get('/flixhq/search', async (req: Request, res: Response) => {
  try {
    const { query, page = 1 } = req.query as { query?: string, page?: string };

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    console.log(`Searching FlixHQ for "${query}"`);
    const cacheKey = `flixhq:search:${query}:${page}`;
    const searchResults = await cacheFetch(cacheKey, async () => {
      return flixhq.search(query, parseInt(page as string));
    }, 60 * 60);
    
    res.json(searchResults);
  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/flixhq/info/:mediaId', async (req: Request, res: Response) => {
  try {
    const { mediaId } = req.params;

    console.log(`Fetching media info for ID: ${mediaId}`);
    const cacheKey = `flixhq:info:${mediaId}`;
    const mediaInfo = await cacheFetch(cacheKey, async () => {
      return flixhq.fetchMediaInfo(mediaId);
    }, 60 * 60 * 6);
    
    res.json(mediaInfo);
  } catch (error: any) {
    console.error('Media info error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/flixhq/sources/:episodeId', async (req: Request, res: Response) => {
  try {
    const { episodeId } = req.params;
    const { mediaId, server } = req.query as { mediaId?: string, server?: string };

    console.log(`Fetching sources for episode ID: ${episodeId}`);
    
    const cacheKey = `flixhq:sources:${episodeId}:${mediaId || ''}:${server || ''}`;
    const sources = await cacheFetch(cacheKey, async () => {
      return flixhq.fetchEpisodeSources(episodeId, mediaId || '', server);
    }, 60 * 30);
    
    if (!sources.sources || sources.sources.length === 0) {
      console.log('Warning: No sources found for this episode ID');
    } else {
      console.log(`Found ${sources.sources.length} sources for this episode.`);
    }

    res.json(sources);
  } catch (error: any) {
    console.error('Sources error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/movie/:tmdbId/:server?', async (req: Request, res: Response) => {
  try {
    const { tmdbId, server: serverName } = req.params;

    const tmdbDetails = await getTMDBDetails(tmdbId, 'movie') as TMDBMovieDetails;

    const searchQuery = tmdbDetails.title;
    const searchResults = await flixhq.search(searchQuery);

    let movie = findBestFlixHQMatch(searchResults, tmdbDetails, 'MOVIE');

    if (!movie) {
      return res.status(404).json({
        error: 'Movie not found on FlixHQ after multiple attempts'
      });
    }

    const movieInfo = await flixhq.fetchMediaInfo(movie.id);

    if (movieInfo.episodes && movieInfo.episodes.length > 0) {
      const episode = movieInfo.episodes[0];

      const embedLinks = await flixhq.fetchMovieEmbedLinks(episode.id, serverName || null);

      let resultSources: any[];
      if (Array.isArray(embedLinks.sources)) {
        resultSources = embedLinks.sources;
      } else if (embedLinks.url) {
        resultSources = [{
          server: embedLinks.server || serverName || 'unknown',
          url: embedLinks.url,
          isM3U8: embedLinks.isM3U8,
          quality: embedLinks.quality,
          subtitles: embedLinks.subtitles || []
        }];
      } else {
        resultSources = [];
      }

      return res.json({
        tmdbId: tmdbId,
        tmdbTitle: tmdbDetails.title,
        tmdbPosterPath: tmdbDetails.poster_path,
        tmdbBackdropPath: tmdbDetails.backdrop_path,
        tmdbPosterUrl: tmdbDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${POSTER_SIZE}${tmdbDetails.poster_path}` : null,
        tmdbBackdropUrl: tmdbDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${BACKDROP_SIZE}${tmdbDetails.backdrop_path}` : null,
        title: movieInfo.title,
        image: movieInfo.image,
        description: movieInfo.description || tmdbDetails.overview,
        sources: resultSources,
        requestedServer: serverName || 'all'
      });
    } else {
      return res.status(404).json({
        error: 'No sources found for this movie on FlixHQ',
        tmdbDetails: tmdbDetails
      });
    }
  } catch (error: any) {
    console.error('Movie endpoint error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.get('/tv/:tmdbId/:season/:episode/:server?', async (req: Request, res: Response) => {
  try {
    const { tmdbId, season, episode, server: serverName } = req.params;
    const seasonNum = parseInt(season);
    const episodeNum = parseInt(episode);

    const [tmdbDetails, episodeDetails] = await Promise.all([
      getTMDBDetails(tmdbId, 'tv') as Promise<TMDBTVDetails>,
      axios.get(
        `${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNum}/episode/${episodeNum}`,
        { params: { api_key: TMDB_API_KEY } }
      ).then(res => res.data as TMDBEpisodeDetails).catch(() => null)
    ]);

    if (!tmdbDetails) {
      return res.status(404).json({ error: 'TV show not found on TMDB' });
    }

    const searchQuery = tmdbDetails.name;
    const searchResults = await flixhq.search(searchQuery);

    let tvShow = findBestFlixHQMatch(searchResults, tmdbDetails, 'TVSERIES');

    if (!tvShow) {
      return res.status(404).json({
        error: 'TV show not found on FlixHQ after multiple attempts'
      });
    }

    const tvInfo = await flixhq.fetchMediaInfo(tvShow.id);

    const targetEpisode = tvInfo.episodes?.find(
      (ep: any) => ep.season === seasonNum && ep.number === episodeNum
    );

    if (!targetEpisode) {
      const availableSeasons: { [key: number]: number[] } = {};
      tvInfo.episodes?.forEach((ep: any) => {
        const season = ep.season || 0;
        const number = ep.number || 0;
        if (!availableSeasons[season]) {
          availableSeasons[season] = [];
        }
        availableSeasons[season].push(number);
      });

      return res.status(404).json({
        error: `Episode not found on FlixHQ for Season ${seasonNum}, Episode ${episodeNum}`,
        availableSeasons
      });
    }

    const embedLinks = await flixhq.fetchTvEpisodeEmbedLinks(targetEpisode.id, serverName || null);

    let resultSources: any[];
    if (Array.isArray(embedLinks.sources)) {
      resultSources = embedLinks.sources;
    } else if (embedLinks.url) {
      resultSources = [{
        server: embedLinks.server || serverName || 'unknown',
        url: embedLinks.url,
        isM3U8: embedLinks.isM3U8,
        quality: embedLinks.quality,
        subtitles: embedLinks.subtitles || []
      }];
    } else {
      resultSources = [];
    }

    return res.json({
      tmdbId: tmdbId,
      tmdbTitle: tmdbDetails.name,
      tmdbPosterPath: tmdbDetails.poster_path,
      tmdbBackdropPath: tmdbDetails.backdrop_path,
      tmdbPosterUrl: tmdbDetails.poster_path ? `${TMDB_IMAGE_BASE_URL}${POSTER_SIZE}${tmdbDetails.poster_path}` : null,
      tmdbBackdropUrl: tmdbDetails.backdrop_path ? `${TMDB_IMAGE_BASE_URL}${BACKDROP_SIZE}${tmdbDetails.backdrop_path}` : null,
      episodeName: episodeDetails?.name || targetEpisode.title,
      title: tvInfo.title,
      episode: targetEpisode.title,
      season: seasonNum,
      number: episodeNum,
      image: tvInfo.image,
      description: episodeDetails?.overview || tmdbDetails.overview,
      sources: resultSources,
      requestedServer: serverName || 'all'
    });
  } catch (error: any) {
    console.error('TV endpoint error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!process.env.REDIS_HOST) {
    console.warn('Redis not found. Cache disabled.');
  }
  
  if (!process.env.TMDB_API_KEY) {
    console.warn('TMDB API key not found. Using default key.');
  }
});

export default app;
