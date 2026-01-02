import * as cheerio from 'cheerio';
import axios from 'axios';
import { MovieParser, TvType, StreamingServers } from './models.js';
import { MegaCloud } from './megacloud.js';

interface SearchResult {
  currentPage: number;
  hasNextPage: boolean;
  results: Array<{
    id: string;
    title: string;
    url: string;
    image: string;
    releaseDate?: string;
    seasons?: number;
    type: TvType;
  }>;
}

interface MediaInfo {
  id: string;
  title: string;
  url: string;
  cover?: string;
  image?: string;
  description?: string;
  type?: TvType;
  duration?: string;
  rating?: number;
  releaseDate?: string;
  genres?: string[];
  casts?: string[];
  production?: string;
  country?: string;
  recommendations?: Array<{
    id: string;
    title: string;
    image: string;
    duration?: string | undefined;
    type: TvType;
  }>;
  episodes?: Array<{
    id: string;
    title: string;
    number?: number;
    season?: number;
    url: string;
  }>;
}

interface EpisodeSource {
  headers: { [key: string]: string };
  sources: Array<{
    file: string;
    type?: string;
  }>;
  tracks?: any[];
}

interface DirectSource {
  url: string;
  isM3U8: boolean;
  quality: string;
  subtitles: any[];
}

class FlixHQ extends MovieParser {
  client: any;

  constructor() {
    super();
    this.name = 'MyFlixHQ';
    this.baseUrl = 'https://myflixerz.to';
    this.logo = 'https://myflixerz.to/images/logo.png';
    this.classPath = 'MOVIES.MyFlixHQ';
    this.supportedTypes = new Set([TvType.MOVIE, TvType.TVSERIES]);
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
  }

  async search(query: string, page: number = 1): Promise<SearchResult> {
    const searchResult: SearchResult = {
      currentPage: page,
      hasNextPage: false,
      results: []
    };

    try {
      const { data } = await this.client.get(
        `${this.baseUrl}/search/${query.replace(/[\W_]+/g, '-')}?page=${page}`
      );

      const $ = cheerio.load(data);
      const navSelector = '.pagination';

      searchResult.hasNextPage =
        $(navSelector).length > 0 ? !$(navSelector).children().last().hasClass('active') : false;

      $('.flw-item').each((i: number, el: any) => {
        const releaseDate = $(el).find('.fd-infor .fdi-item:first-child').text();
        searchResult.results.push({
          id: $(el).find('.film-poster-ahref').attr('href')?.slice(1) || '',
          title: $(el).find('.film-name a').attr('title') || '',
          url: `${this.baseUrl}${$(el).find('.film-poster-ahref').attr('href')}`,
          image: $(el).find('.film-poster-img').attr('data-src') || '',
          releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
          seasons: releaseDate.includes('SS') ? parseInt(releaseDate.split('SS')[1]) : undefined,
          type:
            $(el).find('.fd-infor .fdi-type').text().toLowerCase() === 'movie'
              ? TvType.MOVIE
              : TvType.TVSERIES
        });
      });

      return searchResult;
    } catch (err: any) {
      throw new Error(err.message);
    }
  }

  async fetchMediaInfo(mediaId: string): Promise<MediaInfo> {
    if (!mediaId.startsWith(this.baseUrl)) {
      mediaId = `${this.baseUrl}/${mediaId}`;
    }

    const movieInfo: MediaInfo = {
      id: mediaId.split('to/').pop() || '',
      title: '',
      url: mediaId
    };

    try {
      const { data } = await this.client.get(mediaId);
      const $ = cheerio.load(data);
      const recommendationsArray: Array<{
        id: string;
        title: string;
        image: string;
        duration: string | undefined;
        type: TvType;
      }> = [];

      $('.film_list-wrap .flw-item').each((i: number, el: any) => {
        recommendationsArray.push({
          id: $(el).find('.film-poster > a').attr('href')?.slice(1) || '',
          title: $(el).find('.film-name > a').attr('title') || '',
          image: $(el).find('.film-poster > img').attr('data-src') || '',
          duration: $(el).find('.fd-infor .fdi-duration').text().trim() || undefined,
          type: $(el).find('.fd-infor .fdi-type').text().toLowerCase().includes('tv') ? TvType.TVSERIES : TvType.MOVIE
        });
      });

      const uid = $('.detail_page-watch').attr('data-id') || '';
      movieInfo.cover = $('.film-poster-img').attr('src');
      movieInfo.title = $('.heading-name').text().trim();
      movieInfo.image = $('.film-poster-img').attr('src');
      movieInfo.description = $('.description').text().trim();
      movieInfo.type = mediaId.includes('/movie/') ? TvType.MOVIE : TvType.TVSERIES;

      const durationText = $('.btn-quality').next('.btn-sm:contains("min")').text().trim();
      if (durationText) {
        movieInfo.duration = durationText;
      } else {
        movieInfo.duration = $('.row-line:contains("Duration")').text().replace('Duration:', '').trim();
      }

      const imdbText = $('.btn-imdb').text().trim();
      if (imdbText) {
        const ratingMatch = imdbText.match(/IMDB: (\d+\.\d+)/);
        movieInfo.rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
      }

      $('.elements .row-line').each((i: number, el: any) => {
        const typeText = $(el).find('.type strong').text().trim().toLowerCase();
        
        if (typeText.includes('released')) {
          movieInfo.releaseDate = $(el).text().replace(/Released:|\s+/g, ' ').trim();
        } 
        else if (typeText.includes('genre')) {
          movieInfo.genres = $(el).find('a')
            .map((i: number, genreEl: any) => $(genreEl).text().trim())
            .get()
            .filter(Boolean);
        } 
        else if (typeText.includes('cast')) {
          movieInfo.casts = $(el).find('a')
            .map((i: number, castEl: any) => $(castEl).text().trim())
            .get()
            .filter(Boolean);
        }
        else if (typeText.includes('production')) {
          movieInfo.production = $(el).find('a')
            .map((i: number, prodEl: any) => $(prodEl).text().trim())
            .get()
            .filter(Boolean)
            .join('');
        }
        else if (typeText.includes('country')) {
          movieInfo.country = $(el).find('a')
            .map((i: number, countryEl: any) => $(countryEl).text().trim())
            .get()
            .filter(Boolean)
            .join('');
        }
        else if (typeText.includes('duration')) {
          movieInfo.duration = $(el).text().replace('Duration:', '').trim();
        }
      });

      movieInfo.recommendations = recommendationsArray;

      if (movieInfo.type === TvType.TVSERIES) {
        const { data: seasonData } = await this.client.get(`${this.baseUrl}/ajax/season/list/${uid}`);
        const $$ = cheerio.load(seasonData);
        const seasonsIds = $$('.dropdown-menu a')
          .map((i: number, el: any) => $(el).attr('data-id'))
          .get();

        movieInfo.episodes = [];
        let season = 1;
        for (const id of seasonsIds) {
          const { data: episodeData } = await this.client.get(`${this.baseUrl}/ajax/season/episodes/${id}`);
          const $$$ = cheerio.load(episodeData);

          $$$('.nav > li').each((i: number, el: any) => {
            const episode = {
              id: $$$(el).find('a').attr('data-id') || '',
              title: $$$(el).find('a').attr('title') || '',
              number: parseInt($$$(el).find('a').attr('title')?.match(/Eps (\d+)/)?.[1] || '0'),
              season: season,
              url: `${this.baseUrl}/ajax/episode/servers/${$$$(el).find('a').attr('data-id')}`
            };
            movieInfo.episodes?.push(episode);
          });
          season++;
        }
      } else {
        movieInfo.episodes = [{
          id: uid,
          title: movieInfo.title,
          url: `${this.baseUrl}/ajax/movie/servers/${uid}`
        }];
      }

      return movieInfo;
    } catch (err: any) {
      throw new Error(err.message);
    }
  }

  async fetchEpisodeSources(episodeId: string, mediaId: string, server: string = StreamingServers.VidCloud): Promise<EpisodeSource> {
    if (episodeId.startsWith('http')) {
      const serverUrl = new URL(episodeId);
      try {
        const data = await new MegaCloud().extract2(serverUrl);
        return {
          headers: { Referer: serverUrl.href },
          sources: data.sources,
          tracks: data.tracks
        };
      } catch (err) {
        console.error('Error extracting with MegaCloud:', err);
        return {
          headers: { Referer: serverUrl.href },
          sources: []
        };
      }
    }

    try {
      const servers = await this.fetchEpisodeServers(episodeId, mediaId);
      const i = servers.findIndex(s => s.name === server);

      if (i === -1) {
        throw new Error(`Server ${server} not found`);
      }

      const { data } = await this.client.get(
        `${this.baseUrl}/ajax/sources/${servers[i].url.split('.').slice(-1).shift()}`
      );

      const serverUrl = new URL(data.link);
      return await this.fetchEpisodeSources(serverUrl.href, mediaId, server);
    } catch (err: any) {
      throw new Error(err.message);
    }
  }

  async fetchEpisodeServers(episodeId: string, mediaId: string): Promise<Array<{ name: string; url: string }>> {
    if (!episodeId.startsWith(this.baseUrl + '/ajax') && !mediaId.includes('movie'))
      episodeId = `${this.baseUrl}/ajax/episode/servers/${episodeId}`;
    else
      episodeId = `${this.baseUrl}/ajax/movie/servers/${episodeId}`;

    try {
      const { data } = await this.client.get(episodeId);
      const $ = cheerio.load(data);

      return $('.nav li').map((i: number, el: any) => ({
        name: $(el).find('a').attr('title')?.toLowerCase() || '',
        url: `${this.baseUrl}/${mediaId}.${$(el).find('a').attr('data-id')}`.replace(
          mediaId.includes('movie') ? /\/movie\// : /\/tv\//,
          mediaId.includes('movie') ? '/watch-movie/' : '/watch-tv/'
        )
      })).get();
    } catch (err: any) {
      throw new Error(err.message);
    }
  }

  async fetchMovieEmbedLinks(movieId: string, serverName: string | null = null): Promise<any> {
    try {
      const { data: serverData } = await this.client.get(`${this.baseUrl}/ajax/episode/list/${movieId}`);
      const $ = cheerio.load(serverData);

      if (serverName) {
        const serverElement = $('.nav-item a').filter((i: number, el: any) => {
          return $(el).find('span').text().toLowerCase() === serverName.toLowerCase();
        });

        if (serverElement.length === 0) {
          throw new Error(`Server "${serverName}" not found`);
        }

        const serverId = serverElement.attr('data-id');
        if (!serverId) {
          throw new Error(`No source ID found for server "${serverName}"`);
        }

        const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
        if (!sourceData || !sourceData.link) {
          throw new Error(`No source link found for server "${serverName}"`);
        }

        const embedUrl = sourceData.link;
        const directSource = await this.extractDirectLinks(embedUrl);
        
        return {
          id: movieId,
          server: serverName,
          ...directSource
        };
      }

      const sources: Array<any> = [];
      
      const serverElements = $('.nav-item a');
      for (let i = 0; i < serverElements.length; i++) {
        const el = serverElements[i];
        const serverName = $(el).find('span').text().toLowerCase();
        const serverId = $(el).attr('data-id');
        
        if (serverId) {
          try {
            const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
            
            if (sourceData && sourceData.link) {
              const embedUrl = sourceData.link;
              
              try {
                const directSource = await this.extractDirectLinks(embedUrl);
                if (directSource) {
                  sources.push({
                    server: serverName,
                    ...directSource
                  });
                }
              } catch (err) {
                console.error(`Failed to extract direct link from ${serverName}:`, err);
              }
            }
          } catch (err) {
            console.error(`Failed to fetch source data from server ${serverName}:`, err);
          }
        }
      }

      if (sources.length === 0) {
        return {
          id: movieId,
          sources: [{
            server: 'Unknown',
            url: '',
            isM3U8: false,
            quality: 'auto',
            subtitles: []
          }]
        };
      }
      
      return {
        id: movieId,
        sources: sources
      };
    } catch (err: any) {
      console.error('Error in fetchMovieEmbedLinks:', err);
      throw new Error(`Failed to fetch movie embed links: ${err.message}`);
    }
  }

  async fetchTvEpisodeEmbedLinks(episodeId: string, serverName: string | null = null): Promise<any> {
    try {
      const { data: serverData } = await this.client.get(`${this.baseUrl}/ajax/episode/servers/${episodeId}`);
      const $ = cheerio.load(serverData);

      if (serverName) {
        const serverElement = $('.nav-item a').filter((i: number, el: any) => {
          return $(el).find('span').text().toLowerCase() === serverName.toLowerCase();
        });

        if (serverElement.length === 0) {
          throw new Error(`Server "${serverName}" not found`);
        }

        const serverId = serverElement.attr('data-id');
        if (!serverId) {
          throw new Error(`No source ID found for server "${serverName}"`);
        }

        const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
        if (!sourceData || !sourceData.link) {
          throw new Error(`No source link found for server "${serverName}"`);
        }

        const embedUrl = sourceData.link;
        const directSource = await this.extractDirectLinks(embedUrl);
        
        return {
          id: episodeId,
          server: serverName,
          ...directSource
        };
      }

      const sources: Array<any> = [];
      
      const serverElements = $('.nav-item a');
      
      for (let i = 0; i < serverElements.length; i++) {
        const el = serverElements[i];
        const serverName = $(el).find('span').text().toLowerCase();
        const serverId = $(el).attr('data-id');
        
        if (serverId) {
          try {
            const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
            
            if (sourceData && sourceData.link) {
              const embedUrl = sourceData.link;
              
              try {
                const directSource = await this.extractDirectLinks(embedUrl);
                if (directSource) {
                  sources.push({
                    server: serverName,
                    ...directSource
                  });
                }
              } catch (err) {
                console.error(`Failed to extract direct link from ${serverName}:`, err);
              }
            }
          } catch (err) {
            console.error(`Failed to fetch source data from server ${serverName}:`, err);
          }
        }
      }

      if (sources.length === 0) {
        return {
          id: episodeId,
          sources: [{
            server: 'Unknown',
            url: '',
            isM3U8: false,
            quality: 'auto',
            subtitles: []
          }]
        };
      }
      
      return {
        id: episodeId,
        sources: sources
      };
    } catch (err: any) {
      console.error('Error in fetchTvEpisodeEmbedLinks:', err);
      throw new Error(`Failed to fetch episode embed links: ${err.message}`);
    }
  }

  async extractDirectLinks(embedUrl: string): Promise<DirectSource> {
    try {      
      const fallbackSource: DirectSource = {
        url: '',
        isM3U8: false,
        quality: 'auto',
        subtitles: []
      };
      
      try {
        const serverUrl = new URL(embedUrl);
        const data = await new MegaCloud().extract2(serverUrl);
        if (!data.sources || data.sources.length === 0) {
          return fallbackSource;
        }
        
        return {
          url: data.sources[0].file,
          isM3U8: data.sources[0].type === 'hls',
          quality: 'auto',
          subtitles: data.tracks || []
        };
      } catch (extractError: any) {
        return fallbackSource;
      }
    } catch (err: any) {
      throw new Error(`Failed to extract: ${err.message}`);
    }
  }
}

export default FlixHQ;
