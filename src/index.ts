import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { ANIME } from '@consumet/extensions';
import { AnimeKai } from './providers/animekai.js';
import { mapAnilistToAnimePahe, mapAnilistToHiAnime, mapAnilistToAnimeKai, mapAnilistToAnimeSama } from './mappers/index.js';
import { AniList } from './providers/anilist.js';
import { AnimePahe } from './providers/animepahe.js';
import { getEpisodeServers, getEpisodeSources } from './providers/hianime-servers.js';
import { cache } from './utils/cache.js';
import { AnimeMapper } from './mappers/cross-mapper.js';
import { getEpisodeHLS } from './providers/animesama-sources.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export for Vercel serverless
export default app;
