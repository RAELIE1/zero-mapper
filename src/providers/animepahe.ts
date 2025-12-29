import axios, { AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { KwikExtractor } from '../utils/kwik-extractor';

interface SearchResultItem {
  id: string;
  title: string;
  name: string;
  type: string;
  episodes: {
    sub: number | null;
    dub: string;
  };
  status: string;
  season: string;
  year: number;
  score: number;
  poster: string;
  session: string;
}

interface ApiSearchResponse {
  data?: Array<{
    id: number;
    title: string;
    type?: string;
    episodes?: number;
    status?: string;
    season?: string;
    year?: number;
    score?: number;
    poster: string;
    session: string;
  }>;
}

interface Episode {
  title: string;
  episodeId: string;
  number: number;
  image: string;
}

interface AnimeDetails {
  type: string;
  status: string;
  season: string;
  year: number;
  score: number;
}

interface ApiEpisodeResponse {
  current_page: number;
  last_page: number;
  total: number;
  data: Array<{
    episode: number;
    session: string;
    snapshot: string;
    anime_id: number;
  }>;
}

interface EpisodesResult {
  title: string;
  session: string;
  totalEpisodes: number;
  details: AnimeDetails;
  episodes: Episode[];
}

interface VideoLink {
  quality: string;
  url: string;
  referer: string;
}

interface EpisodeSourcesResult {
  sources: Array<{ url: string }>;
  multiSrc: VideoLink[];
}

interface ScrapeOptions {
  category?: string;
  lang?: string;
}

export class AnimePahe {
  private baseUrl: string;
  public sourceName: string;
  public isMulti: boolean;

  constructor() {
    this.baseUrl = "https://animepahe.si";
    this.sourceName = 'AnimePahe';
    this.isMulti = false;
  }

  async scrapeSearchResults(query: string): Promise<SearchResultItem[]> {
    try {
      const response: AxiosResponse<ApiSearchResponse> = await axios.get(
        `${this.baseUrl}/api?m=search&l=8&q=${query}`,
        {
          headers: {
            'Cookie': "__ddg1_=;__ddg2_=;",
          }
        }
      );
      
      const jsonResult = response.data;
      const searchResults: SearchResultItem[] = [];

      if (!jsonResult.data || !jsonResult.data.length) {
        return searchResults;
      }

      for (const item of jsonResult.data) {
        searchResults.push({
          id: `${item.id}-${item.title}`,
          title: item.title,
          name: item.title,
          type: item.type || 'TV',
          episodes: { 
            sub: item.episodes || null, 
            dub: '??' 
          },
          status: item.status || 'Unknown',
          season: item.season || 'Unknown',
          year: item.year || 0,
          score: item.score || 0,
          poster: item.poster,
          session: item.session,
        });
      }

      return searchResults;
    } catch (error) {
      console.error('Error searching AnimePahe:', (error as Error).message);
      throw new Error('Failed to search AnimePahe');
    }
  }

  async scrapeEpisodes(url: string): Promise<EpisodesResult> {
    try {
      const title = url.split('-')[1];
      const id = url.split('-')[0];
      
      const session = await this._getSession(title, id);
      const epUrl = `${this.baseUrl}/api?m=release&id=${session}&sort=episode_desc&page=1`;
      
      const response: AxiosResponse<ApiEpisodeResponse> = await axios.get(epUrl, {
        headers: {
          'Cookie': "__ddg1_=;__ddg2_=;",
        }
      });
      
      return await this._recursiveFetchEpisodes(epUrl, JSON.stringify(response.data), session);
    } catch (error) {
      console.error('Error fetching episodes:', (error as Error).message);
      throw new Error('Failed to fetch episodes');
    }
  }

  private async _recursiveFetchEpisodes(
    url: string, 
    responseData: string, 
    session: string
  ): Promise<EpisodesResult> {
    try {
      const jsonResult: ApiEpisodeResponse = JSON.parse(responseData);
      const page = jsonResult.current_page;
      const hasNextPage = page < jsonResult.last_page;
      let animeTitle = 'Could not fetch title';
      let episodes: Episode[] = [];
      let animeDetails: AnimeDetails = {
        type: 'TV',
        status: 'Unknown',
        season: 'Unknown',
        year: 0,
        score: 0
      };

      for (const item of jsonResult.data) {
        episodes.push({
          title: `Episode ${item.episode}`,
          episodeId: `${session}/${item.session}`,
          number: item.episode,
          image: item.snapshot,
        });
      }

      if (hasNextPage) {
        const newUrl = `${url.split("&page=")[0]}&page=${page + 1}`;
        const newResponse: AxiosResponse<ApiEpisodeResponse> = await axios.get(newUrl, {
          headers: {
            'Cookie': "__ddg1_=;__ddg2_=;",
          }
        });
        
        const moreEpisodes = await this._recursiveFetchEpisodes(
          newUrl, 
          JSON.stringify(newResponse.data), 
          session
        );
        episodes = [...episodes, ...moreEpisodes.episodes];
        animeTitle = moreEpisodes.title;
        animeDetails = moreEpisodes.details || animeDetails;
      } else {
        const detailUrl = `https://animepahe.si/a/${jsonResult.data[0].anime_id}`;
        const newResponse: AxiosResponse<string> = await axios.get(detailUrl, {
          headers: {
            'Cookie': "__ddg1_=;__ddg2_=;",
          }
        });
        
        if (newResponse.status === 200) {
          const $ = cheerio.load(newResponse.data);
          animeTitle = $('.title-wrapper span').text().trim() || 'Could not fetch title';
          
          // Try to extract additional information
          try {
            // Parse type
            const typeText = $('.col-sm-4.anime-info p:contains("Type")').text();
            if (typeText) {
              animeDetails.type = typeText.replace('Type:', '').trim();
            }
            
            // Parse status
            const statusText = $('.col-sm-4.anime-info p:contains("Status")').text();
            if (statusText) {
              animeDetails.status = statusText.replace('Status:', '').trim();
            }
            
            // Parse season and year
            const seasonText = $('.col-sm-4.anime-info p:contains("Season")').text();
            if (seasonText) {
              const seasonMatch = seasonText.match(/Season:\s+(\w+)\s+(\d{4})/);
              if (seasonMatch) {
                animeDetails.season = seasonMatch[1];
                animeDetails.year = parseInt(seasonMatch[2]);
              }
            }
            
            // Parse score
            const scoreText = $('.col-sm-4.anime-info p:contains("Score")').text();
            if (scoreText) {
              const scoreMatch = scoreText.match(/Score:\s+([\d.]+)/);
              if (scoreMatch) {
                animeDetails.score = parseFloat(scoreMatch[1]);
              }
            }
          } catch (err) {
            console.error('Error parsing anime details:', (err as Error).message);
          }
        }
      }

      // Always sort episodes by number in ascending order, regardless of how the API returns them
      const sortedEpisodes = [...episodes].sort((a, b) => a.number - b.number);

      return {
        title: animeTitle,
        session: session,
        totalEpisodes: jsonResult.total,
        details: animeDetails,
        episodes: sortedEpisodes, // Return sorted episodes, always in ascending order
      };
    } catch (error) {
      console.error('Error recursively fetching episodes:', (error as Error).message);
      throw new Error('Failed to fetch episodes recursively');
    }
  }

  async scrapeEpisodesSrcs(
    episodeUrl: string, 
    { category, lang }: ScrapeOptions = {}
  ): Promise<EpisodeSourcesResult> {
    try {
      const response: AxiosResponse<string> = await axios.get(
        `${this.baseUrl}/play/${episodeUrl}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': "__ddg1_=;__ddg2_=;",
            'Referer': this.baseUrl,
          }
        }
      );
      
      const $ = cheerio.load(response.data);
      const buttons = $('#resolutionMenu > button');
      const kwikLinks: Array<{ quality: string; url: string }> = [];

      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const kwikLink = $(btn).attr('data-src');
        const quality = $(btn).text();
        
        if (kwikLink) {
          kwikLinks.push({
            quality: quality,
            url: kwikLink,
          });
        }
      }

      // Extract m3u8 URLs from kwik.cx links
      const videoLinks: VideoLink[] = [];
      
      for (const { quality, url } of kwikLinks) {
        const m3u8Url = await KwikExtractor.extract(url);
        
        if (m3u8Url) {
          videoLinks.push({
            quality: quality,
            url: m3u8Url,
            referer: "https://kwik.cx",
          });
        }
      }

      const result: EpisodeSourcesResult = {
        sources: videoLinks.length > 0 ? [{ url: videoLinks[0].url }] : [],
        multiSrc: videoLinks,
      };
      
      return result;
    } catch (error) {
      console.error('Error fetching episode sources:', (error as Error).message);
      throw new Error('Failed to fetch episode sources');
    }
  }

  private async _getSession(title: string, animeId: string): Promise<string> {
    try {
      const response: AxiosResponse<ApiSearchResponse> = await axios.get(
        `${this.baseUrl}/api?m=search&q=${title}`,
        {
          headers: {
            'Cookie': "__ddg1_=;__ddg2_=;",
          }
        }
      );
      
      const resBody = response.data;
      if (!resBody.data || resBody.data.length === 0) {
        throw new Error(`No results found for title: ${title}`);
      }
      
      // First try: Direct ID match if provided and valid
      if (animeId) {
        const animeIdMatch = resBody.data.find(
          anime => String(anime.id) === String(animeId)
        );
        if (animeIdMatch) {
          return animeIdMatch.session;
        }
      }
      
      // Second try: Normalize titles and find best match
      const normalizeTitle = (t: string): string => 
        t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      
      const normalizedSearchTitle = normalizeTitle(title);
      
      let bestMatch: typeof resBody.data[0] | null = null;
      let highestSimilarity = 0;
      
      for (const anime of resBody.data) {
        const normalizedAnimeTitle = normalizeTitle(anime.title);
        // Calculate simple similarity (more sophisticated than exact match)
        let similarity = 0;
        
        // Exact match
        if (normalizedAnimeTitle === normalizedSearchTitle) {
          similarity = 1;
        } 
        // Contains match
        else if (normalizedAnimeTitle.includes(normalizedSearchTitle) || 
                normalizedSearchTitle.includes(normalizedAnimeTitle)) {
          const lengthRatio = Math.min(normalizedAnimeTitle.length, normalizedSearchTitle.length) / 
                             Math.max(normalizedAnimeTitle.length, normalizedSearchTitle.length);
          similarity = 0.8 * lengthRatio;
        }
        // Word match
        else {
          const searchWords = normalizedSearchTitle.split(' ');
          const animeWords = normalizedAnimeTitle.split(' ');
          const commonWords = searchWords.filter(word => animeWords.includes(word));
          similarity = commonWords.length / Math.max(searchWords.length, animeWords.length);
        }
        
        if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
          bestMatch = anime;
        }
      }
      
      if (bestMatch && highestSimilarity > 0.5) {
        return bestMatch.session;
      }
      
      // Default to first result if no good match found
      return resBody.data[0].session;
    } catch (error) {
      console.error('Error getting session:', (error as Error).message);
      throw new Error('Failed to get session');
    }
  }
}

export default AnimePahe;