import axios from 'axios';
import { getEpisodesForAnime } from '../providers/animesama.js';


interface AniListTitle {
  romaji?: string;
  english?: string;
  native?: string;
  userPreferred?: string;
}

interface AniListDate {
  year?: number;
  month?: number;
  day?: number;
}

interface AniListMedia {
  id: number;
  title: AniListTitle;
  description?: string;
  episodes?: number;
  status: string;
  season?: string;
  seasonYear?: number;
  startDate?: AniListDate;
  endDate?: AniListDate;
  genres: string[];
  format: string;
  synonyms: string[];
  averageScore?: number;
}

interface MALTitle {
  default: string;
  english?: string;
  japanese?: string;
  synonyms?: string[];
}

interface MALMedia {
  id: number;
  title: string;
  alternative_titles?: MALTitle;
  start_date?: string;
  end_date?: string;
  synopsis?: string;
  mean?: number;
  num_episodes?: number;
  status?: string;
  genres?: Array<{ id: number; name: string }>;
  media_type?: string;
}

interface MALSearchResponse {
  data: Array<{ node: MALMedia }>;
}

interface TMDBMedia {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  release_date?: string;
  first_air_date?: string;
  overview: string;
  adult?: boolean;
  vote_average?: number;
  popularity?: number;
  media_type?: 'movie' | 'tv';
  number_of_seasons?: number;
  seasons?: TMDBSeason[];
}

interface TMDBSeason {
  id: number;
  name: string;
  overview: string;
  season_number: number;
  episode_count: number;
  air_date?: string;
}

interface CacheItem<T = unknown> {
  data: T;
  expiry: number;
}

export interface MappingResult {
  anilist?: {
    id: number;
    title: AniListTitle;
    format: string;
    episodes?: number;
    status: string;
    year?: number;
    score?: number;
  };
  mal?: {
    id: number;
    title: string;
    alternativeTitles?: MALTitle;
    mediaType?: string;
    episodes?: number;
    status?: string;
    year?: number;
    score?: number;
  };
  tmdb?: {
    id: number;
    title: string;
    mediaType: string;
    seasonNumber?: number;
    seasonName?: string;
    splitCourPart?: 1 | 2;
    releaseDate?: string;
    overview: string;
    year?: number;
    score?: number;
  };
  animepahe?: {
    id: string;
    slug: string;
    episodes: number;
  };
  hianime?: {
    id: string;
    slug: string;
    episodes: number;
  };
  animekai?: {
    id: string;
    url: string;
    episodes: number;
  };
  animesama?: {
    slug: string;
    seasonSlug: string | null;
    seasons: number;
  };
}


export class AnimeMapper {
  private readonly anilistUrl = 'https://graphql.anilist.co';
  private readonly malBaseUrl = 'https://api.myanimelist.net/v2';
  private readonly tmdbBaseUrl = 'https://api.themoviedb.org/3';
  private readonly tmdbApiKey: string;
  private readonly malClientId: string;
  private readonly cache: Map<string, CacheItem> = new Map();
  private readonly cacheExpiry = 30 * 60 * 1000; // 30 minutes

  constructor(tmdbApiKey: string, malClientId?: string) {
    this.tmdbApiKey = tmdbApiKey;
    this.malClientId = malClientId || '';
  }



  async mapFromAniList(anilistId: string | number): Promise<MappingResult> {
    const animeInfo = await this.getAniListInfo(Number(anilistId));
    if (!animeInfo) throw new Error(`AniList ID ${anilistId} not found`);

    // Fetch database mappings
    const malMatch = await this.findMALMatch(animeInfo);
    const tmdbMatch = await this.findTMDBMatchWithMAL(animeInfo, malMatch);

    // Fetch provider data in parallel
    const [animepaheData, hianimeData, animekaiData, animesamaData] = await Promise.allSettled([
      this.fetchAnimePaheData(anilistId),
      this.fetchHiAnimeData(anilistId),
      this.fetchAnimeKaiData(anilistId),
      this.fetchAnimeSamaData(anilistId)
    ]);

    return {
      anilist: {
        id: animeInfo.id,
        title: animeInfo.title,
        format: animeInfo.format,
        episodes: animeInfo.episodes,
        status: animeInfo.status,
        year: animeInfo.startDate?.year || animeInfo.seasonYear,
        score: animeInfo.averageScore
      },
      tmdb: tmdbMatch || undefined,
      mal: malMatch || undefined,
      animepahe: animepaheData.status === 'fulfilled' ? animepaheData.value ?? undefined : undefined,
      hianime: hianimeData.status === 'fulfilled' ? hianimeData.value ?? undefined : undefined,
      animekai: animekaiData.status === 'fulfilled' ? animekaiData.value ?? undefined : undefined,
      animesama: animesamaData.status === 'fulfilled' ? animesamaData.value ?? undefined : undefined
    };
  }

  async mapFromMAL(malId: string | number): Promise<MappingResult> {
    const animeInfo = await this.getMALInfo(Number(malId));
    if (!animeInfo) throw new Error(`MAL ID ${malId} not found`);

    const [anilistMatch, tmdbMatch] = await Promise.all([
      this.findAniListMatchFromMAL(animeInfo),
      this.findTMDBMatchFromMAL(animeInfo)
    ]);

    return {
      mal: {
        id: animeInfo.id,
        title: animeInfo.title,
        alternativeTitles: animeInfo.alternative_titles,
        mediaType: animeInfo.media_type,
        episodes: animeInfo.num_episodes,
        status: animeInfo.status,
        year: this.extractYear(animeInfo.start_date) || undefined,
        score: animeInfo.mean
      },
      anilist: anilistMatch || undefined,
      tmdb: tmdbMatch || undefined
    };
  }

  async mapFromTMDB(tmdbId: string | number, mediaType: 'tv' | 'movie' = 'tv'): Promise<MappingResult> {
    const tmdbInfo = await this.getTMDBInfo(Number(tmdbId), mediaType);
    if (!tmdbInfo) throw new Error(`TMDB ID ${tmdbId} not found`);

    const [anilistMatch, malMatch] = await Promise.all([
      this.findAniListMatch(tmdbInfo, mediaType),
      this.findMALMatchFromTMDB(tmdbInfo, mediaType)
    ]);

    return {
      tmdb: {
        id: tmdbInfo.id,
        title: tmdbInfo.title || tmdbInfo.name || '',
        mediaType: mediaType,
        releaseDate: tmdbInfo.release_date || tmdbInfo.first_air_date,
        overview: tmdbInfo.overview,
        year: this.extractYear(tmdbInfo.release_date || tmdbInfo.first_air_date) || undefined,
        score: tmdbInfo.vote_average
      },
      anilist: anilistMatch || undefined,
      mal: malMatch || undefined
    };
  }

  async crossReference(title: string): Promise<{
    bestMatches: MappingResult;
    allResults: {
      anilist: AniListMedia[];
      mal: MALMedia[];
      tmdb: TMDBMedia[];
    };
  }> {
    const [anilistResults, malResults, tmdbResults] = await Promise.all([
      this.searchAniList(title),
      this.searchMAL(title),
      this.searchTMDB(title, 'multi')
    ]);

    let bestMatches: MappingResult = {};

    if (anilistResults.length > 0) {
      bestMatches = await this.mapFromAniList(anilistResults[0].id);
    } else if (malResults.length > 0) {
      bestMatches = await this.mapFromMAL(malResults[0].id);
    } else if (tmdbResults.length > 0) {
      const mediaType = tmdbResults[0].media_type === 'movie' ? 'movie' : 'tv';
      bestMatches = await this.mapFromTMDB(tmdbResults[0].id, mediaType);
    }

    return {
      bestMatches,
      allResults: {
        anilist: anilistResults,
        mal: malResults,
        tmdb: tmdbResults
      }
    };
  }


  private async getAniListInfo(id: number): Promise<AniListMedia | null> {
    const cacheKey = `anilist_${id}`;
    const cached = this.getFromCache<AniListMedia>(cacheKey);
    if (cached) return cached;

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          title { romaji english native userPreferred }
          description
          episodes
          status
          season
          seasonYear
          startDate { year month day }
          endDate { year month day }
          genres
          format
          synonyms
          averageScore
        }
      }
    `;

    try {
      const response = await axios.post(this.anilistUrl, {
        query,
        variables: { id }
      });
      const data = response.data.data.Media;
      this.setCache(cacheKey, data);
      return data;
    } catch {
      return null;
    }
  }

  private async getMALInfo(id: number): Promise<MALMedia | null> {
    if (!this.malClientId) return null;

    const cacheKey = `mal_${id}`;
    const cached = this.getFromCache<MALMedia>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.malBaseUrl}/anime/${id}?fields=id,title,alternative_titles,start_date,end_date,synopsis,mean,num_episodes,status,genres,media_type`,
        { headers: { 'X-MAL-CLIENT-ID': this.malClientId } }
      );
      this.setCache(cacheKey, response.data);
      return response.data;
    } catch {
      return null;
    }
  }

  private async getTMDBInfo(id: number, mediaType: 'tv' | 'movie'): Promise<TMDBMedia | null> {
    const cacheKey = `tmdb_${mediaType}_${id}`;
    const cached = this.getFromCache<TMDBMedia>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.tmdbBaseUrl}/${mediaType}/${id}?api_key=${this.tmdbApiKey}&language=en-US`
      );
      const data = response.data;
      
      if (mediaType === 'tv' && data.number_of_seasons) {
        data.seasons = await this.getTMDBSeasons(id);
      }
      
      this.setCache(cacheKey, data);
      return data;
    } catch {
      return null;
    }
  }

  private async getTMDBSeasons(tvId: number): Promise<TMDBSeason[] | undefined> {
    const cacheKey = `tmdb_seasons_${tvId}`;
    const cached = this.getFromCache<TMDBSeason[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.tmdbBaseUrl}/tv/${tvId}?api_key=${this.tmdbApiKey}&language=en-US`
      );
      const seasons = response.data.seasons?.filter((s: TMDBSeason) => s.season_number > 0) || [];
      this.setCache(cacheKey, seasons);
      return seasons;
    } catch {
      return undefined;
    }
  }



  private async searchAniList(query: string): Promise<AniListMedia[]> {
    const cacheKey = `anilist_search_${query}`;
    const cached = this.getFromCache<AniListMedia[]>(cacheKey);
    if (cached) return cached;

    const gqlQuery = `
      query ($search: String) {
        Page(page: 1, perPage: 20) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            title { romaji english native userPreferred }
            episodes
            status
            season
            seasonYear
            startDate { year }
            format
            synonyms
            averageScore
          }
        }
      }
    `;

    try {
      const response = await axios.post(this.anilistUrl, {
        query: gqlQuery,
        variables: { search: query }
      });
      const data = response.data.data.Page.media;
      this.setCache(cacheKey, data);
      return data;
    } catch {
      return [];
    }
  }

  private async searchMAL(query: string, limit = 20): Promise<MALMedia[]> {
    if (!this.malClientId) return [];

    const cacheKey = `mal_search_${query}`;
    const cached = this.getFromCache<MALMedia[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.malBaseUrl}/anime?q=${encodeURIComponent(query)}&limit=${limit}&fields=id,title,alternative_titles,start_date,num_episodes,media_type,mean,status`,
        { headers: { 'X-MAL-CLIENT-ID': this.malClientId } }
      );
      const data = (response.data as MALSearchResponse).data.map(item => item.node);
      this.setCache(cacheKey, data);
      return data;
    } catch {
      return [];
    }
  }

  private async searchTMDB(query: string, mediaType: 'multi' | 'tv' | 'movie' = 'multi'): Promise<TMDBMedia[]> {
    const cacheKey = `tmdb_search_${mediaType}_${query}`;
    const cached = this.getFromCache<TMDBMedia[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.tmdbBaseUrl}/search/${mediaType}?api_key=${this.tmdbApiKey}&query=${encodeURIComponent(query)}&language=en-US`
      );
      const data = response.data.results;
      this.setCache(cacheKey, data);
      return data;
    } catch {
      return [];
    }
  }


  private async detectTMDBSeason(tmdbId: number, animeInfo: AniListMedia, animeYear: number | undefined): Promise<{ seasonNumber: number; seasonName: string; splitCourPart?: 1 | 2 } | null> {
    try {
      const seasons = await this.getTMDBSeasons(tmdbId);
      if (!seasons || seasons.length === 0) return null;

      const animeDescription = animeInfo.description || '';
      const normalizedAnimeDesc = this.normalizeDescription(animeDescription);
      
      const animeStartDate = animeInfo.startDate;
      const animeEndDate = animeInfo.endDate;

      if (animeStartDate?.year && animeStartDate?.month) {
        let bestMatch: TMDBSeason | null = null;
        let bestScore = 0;
        let isSplitCourPart2 = false;
        
        for (const season of seasons) {
          if (!season.air_date) continue;
          
          const seasonDate = this.parseDate(season.air_date);
          if (!seasonDate) continue;
          
          let score = 0;
          let splitCourDetected = false;
          
          const monthsDiff = this.monthsBetween(
            { year: animeStartDate.year, month: animeStartDate.month },
            { year: seasonDate.year, month: seasonDate.month }
          );
          
          if (monthsDiff === 0) {
            score += 200;
          } else if (Math.abs(monthsDiff) === 1) {
            score += 150;
          } else if (Math.abs(monthsDiff) <= 3) {
            score += 100; 
          } else if (Math.abs(monthsDiff) <= 6) {
            score += 50;
          } else {
            continue;
          }
          

          if (animeInfo.episodes && season.episode_count) {
            const episodeDiff = Math.abs(season.episode_count - animeInfo.episodes);
            if (episodeDiff === 0) {
              score += 50; // Exact episode match
            } else if (episodeDiff <= 2) {
              score += 30; // Very close (±2 episodes)
            } else if (episodeDiff <= 5) {
              score += 10; // Somewhat close (±5 episodes)
            }
            
            // Split-cour detection: Check if this could be Part 2
            // If start date is 3-6 months after season start, and episodes are roughly half
            if (Math.abs(monthsDiff) >= 3 && Math.abs(monthsDiff) <= 6) {
              const ratio = animeInfo.episodes / season.episode_count;
              if (ratio >= 0.3 && ratio <= 0.7) {
                score += 20; // Bonus for likely split-cour Part 2
                splitCourDetected = true;
                console.log(`[DEBUG] Possible split-cour Part 2 detected: ${monthsDiff} months gap, ${animeInfo.episodes}/${season.episode_count} episodes`);
              }
            }
          }
          
          // Description similarity (helps differentiate between seasons)
          if (normalizedAnimeDesc && season.overview) {
            const normalizedSeasonDesc = this.normalizeDescription(season.overview);
            const descSimilarity = this.calculateDescriptionSimilarity(normalizedAnimeDesc, normalizedSeasonDesc);
            
            if (descSimilarity > 0.3) {
              score += Math.floor(descSimilarity * 20); // Up to +20 points
            }
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = season;
            isSplitCourPart2 = splitCourDetected;
          }
        }
        
        if (bestMatch && bestScore >= 50) {
          console.log(`[DEBUG] Detected TMDB Season ${bestMatch.season_number} (${bestMatch.name}) via DATE - Score: ${bestScore} (Start: ${animeStartDate.year}-${animeStartDate.month}, Episodes: ${animeInfo.episodes})${isSplitCourPart2 ? ' [SPLIT-COUR PART 2]' : ''}`);
          return {
            seasonNumber: bestMatch.season_number,
            seasonName: bestMatch.name,
            splitCourPart: isSplitCourPart2 ? 2 : 1
          };
        }
      }

      // FALLBACK: Match by year and episode count (when no month data)
      if (animeYear && animeInfo.episodes) {
        let bestMatch: TMDBSeason | null = null;
        let bestScore = 0;
        
        for (const season of seasons) {
          const seasonYear = season.air_date ? parseInt(season.air_date.substring(0, 4)) : null;
          if (!seasonYear) continue;
          
          let score = 0;
          
          // Year matching (highest priority for fallback)
          const yearDiff = Math.abs(seasonYear - animeYear);
          if (yearDiff === 0) {
            score += 100; // Exact year match
          } else if (yearDiff === 1) {
            score += 50; // Off by 1 year
          } else {
            continue; // More than 1 year off - skip this season
          }
          
          // Episode count matching
          if (season.episode_count) {
            const episodeDiff = Math.abs(season.episode_count - animeInfo.episodes);
            if (episodeDiff === 0) {
              score += 50; // Exact episode match
            } else if (episodeDiff <= 2) {
              score += 30; // Very close (±2 episodes)
            } else if (episodeDiff <= 5) {
              score += 10; // Somewhat close (±5 episodes)
            }
          }
          
          // Description similarity
          if (normalizedAnimeDesc && season.overview) {
            const normalizedSeasonDesc = this.normalizeDescription(season.overview);
            const descSimilarity = this.calculateDescriptionSimilarity(normalizedAnimeDesc, normalizedSeasonDesc);
            
            if (descSimilarity > 0.3) {
              score += Math.floor(descSimilarity * 20);
            }
          }
          
          if (score > bestScore) {
            bestScore = score;
            bestMatch = season;
          }
        }
        
        // Return if we have a confident match (year match is minimum)
        if (bestMatch && bestScore >= 50) {
          console.log(`[DEBUG] Detected TMDB Season ${bestMatch.season_number} (${bestMatch.name}) via YEAR - Score: ${bestScore} (Year: ${animeYear}, Episodes: ${animeInfo.episodes})`);
          return {
            seasonNumber: bestMatch.season_number,
            seasonName: bestMatch.name
            // No splitCourPart when using year-only matching (not enough precision)
          };
        }
      }
      
      // LAST RESORT: Year-only matching if no episode count available
      if (animeYear && !animeInfo.episodes) {
        for (const season of seasons) {
          const seasonYear = season.air_date ? parseInt(season.air_date.substring(0, 4)) : null;
          if (seasonYear && seasonYear === animeYear) {
            console.log(`[DEBUG] Detected TMDB Season ${season.season_number} (${season.name}) - Year match only: ${animeYear}`);
            return {
              seasonNumber: season.season_number,
              seasonName: season.name
            };
          }
        }
      }

      // If no match found, don't guess
      console.log(`[DEBUG] Could not detect TMDB season for ${animeStartDate ? `date ${animeStartDate.year}-${animeStartDate.month}` : `year ${animeYear}`}, episodes ${animeInfo.episodes}`);
      return null;
    } catch (error) {
      console.error('[DEBUG] Error detecting TMDB season:', error);
      return null;
    }
  }

  // Parse TMDB date string (YYYY-MM-DD) to date object
  private parseDate(dateString: string): { year: number; month: number; day: number } | null {
    if (!dateString) return null;
    const parts = dateString.split('-');
    if (parts.length !== 3) return null;
    
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);
    
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
    return { year, month, day };
  }

  // Calculate months between two dates
  private monthsBetween(date1: { year: number; month: number }, date2: { year: number; month: number }): number {
    return (date2.year - date1.year) * 12 + (date2.month - date1.month);
  }

  // Normalize description for comparison (remove HTML, extra whitespace, etc.)
  private normalizeDescription(desc: string): string {
    if (!desc) return '';
    return desc
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/\s+/g, ' ') // Normalize whitespace
      .toLowerCase()
      .trim();
  }

  // Calculate similarity between two descriptions using word overlap
  private calculateDescriptionSimilarity(desc1: string, desc2: string): number {
    if (!desc1 || !desc2) return 0;

    // Extract significant words (longer than 4 characters)
    const words1 = desc1.split(' ').filter(w => w.length > 4);
    const words2 = desc2.split(' ').filter(w => w.length > 4);
    
    if (words1.length === 0 || words2.length === 0) return 0;

    // Count matching words
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    let matches = 0;
    
    for (const word of set1) {
      if (set2.has(word)) {
        matches++;
      }
    }

    // Calculate Jaccard similarity
    const union = new Set([...set1, ...set2]).size;
    return matches / union;
  }

  // Enhanced TMDB matching using MAL data for better title matching
  private async findTMDBMatchWithMAL(animeInfo: AniListMedia, malMatch: MappingResult['mal'] | null): Promise<MappingResult['tmdb'] | null> {
    // Collect all possible titles from both AniList and MAL
    const titles = this.extractTitles(animeInfo);
    const searchTitles: string[] = [...titles];

    // Add MAL English title and synonyms if available
    if (malMatch?.alternativeTitles) {
      if (malMatch.alternativeTitles.english) {
        searchTitles.push(malMatch.alternativeTitles.english);
      }
      if (malMatch.alternativeTitles.synonyms) {
        searchTitles.push(...malMatch.alternativeTitles.synonyms);
      }
    }

    // For OVAs/Specials/Sequels, also try base series titles (strip suffixes)
    if (animeInfo.format === 'OVA' || animeInfo.format === 'SPECIAL' || this.hasSequelIndicators(animeInfo.title)) {
      const baseTitles = searchTitles.map(title => this.stripOVASuffixes(title)).filter(t => t);
      searchTitles.push(...baseTitles);
    }

    // Remove duplicates
    const uniqueTitles = [...new Set(searchTitles)];
    console.log(`[DEBUG] TMDB search titles for "${animeInfo.title.english || animeInfo.title.romaji}": ${uniqueTitles.slice(0, 5).join(', ')}`);

    // Try each title variant
    for (const title of uniqueTitles) {
      for (const type of ['tv', 'movie', 'multi'] as const) {
        const results = await this.searchTMDB(title, type);
        if (results.length > 0) {
          console.log(`[DEBUG] TMDB search "${title}" (${type}) returned ${results.length} results, top result: "${results[0].title || results[0].name}"`);
        }
        const match = await this.findBestTMDBMatchFromResults(animeInfo, results, type);
        if (match) {
          console.log(`[DEBUG] TMDB match found: ${match.title} (ID: ${match.id})`);
          return match;
        }
      }
    }
    console.log('[DEBUG] No TMDB match found');
    return null;
  }

  // Check if title has sequel indicators
  private hasSequelIndicators(title: AniListTitle): boolean {
    const allTitles = [
      title.english,
      title.romaji,
      title.userPreferred
    ].filter(Boolean).join(' ');
    
    return /after\s*story|second\s*season|2nd\s*season|season\s*\d+|part\s*\d+|final\s*season/i.test(allTitles);
  }

  // Strip OVA/Special/Season suffixes to find base series
  private stripOVASuffixes(title: string): string {
    if (!title) return '';
    
    return title
      // Remove OVA/Special/Movie suffixes
      .replace(/\s*:?\s*OVA\s*\d*\s*$/i, '')
      .replace(/\s*OVA\s*$/i, '')
      .replace(/\s*Special\s*$/i, '')
      .replace(/\s*Movie\s*$/i, '')
      // Remove "Climax" and similar finale indicators
      .replace(/\s*:?\s*Climax!?\s*$/i, '')
      .replace(/\s*:?\s*Final Season\s*$/i, '')
      .replace(/\s*:?\s*Finale\s*$/i, '')
      // Remove season/part indicators
      .replace(/\s*Season\s*\d+\s*$/i, '')
      .replace(/\s*Part\s*\d+\s*$/i, '')
      .replace(/\s*S\d+\s*$/i, '')
      // Remove "Kan" (completion/finale in Japanese)
      .replace(/\s*:?\s*Kan:?.*$/i, '')
      // Remove sequel indicators
      .replace(/\s*:?\s*After Story\s*$/i, '')
      .replace(/\s*:?\s*Second Season\s*$/i, '')
      .replace(/\s*:?\s*2nd Season\s*$/i, '')
      .replace(/\s*:?\s*Third Season\s*$/i, '')
      .replace(/\s*:?\s*3rd Season\s*$/i, '')
      .replace(/\s*:?\s*Continuation\s*$/i, '')
      // Remove subtitle after last colon (but keep main title)
      .replace(/:\s*[^:]+$/, '')
      .trim();
  }

  private async findTMDBMatch(animeInfo: AniListMedia): Promise<MappingResult['tmdb'] | null> {
    const titles = this.extractTitles(animeInfo);

    for (const title of titles) {
      for (const type of ['tv', 'movie', 'multi'] as const) {
        const results = await this.searchTMDB(title, type);
        const match = this.findBestTMDBMatchFromResults(animeInfo, results, type);
        if (match) return match;
      }
    }
    return null;
  }

  private async findMALMatch(animeInfo: AniListMedia): Promise<MappingResult['mal'] | null> {
    if (!this.malClientId) {
      console.log('[DEBUG] MAL Client ID not configured');
      return null;
    }
    
    const titles = this.extractTitles(animeInfo);
    console.log('[DEBUG] Searching MAL with titles:', titles.slice(0, 3));
    
    for (const title of titles) {
      const results = await this.searchMAL(title);
      console.log(`[DEBUG] MAL search for "${title}" returned ${results.length} results`);
      
      const match = this.findBestMALMatchFromResults(animeInfo, results);
      if (match) {
        console.log('[DEBUG] Found MAL match:', match.id, match.title);
        return match;
      }
    }
    console.log('[DEBUG] No MAL match found');
    return null;
  }

  private async findAniListMatchFromMAL(malInfo: MALMedia): Promise<MappingResult['anilist'] | null> {
    const titles = this.extractMALTitles(malInfo);
    for (const title of titles) {
      const results = await this.searchAniList(title);
      const match = this.findBestAniListMatchFromMALResults(malInfo, results);
      if (match) return match;
    }
    return null;
  }

  private async findTMDBMatchFromMAL(malInfo: MALMedia): Promise<MappingResult['tmdb'] | null> {
    const titles = this.extractMALTitles(malInfo);
    for (const title of titles) {
      for (const type of ['tv', 'movie'] as const) {
        const results = await this.searchTMDB(title, type);
        const match = this.findBestTMDBMatchFromMALResults(malInfo, results, type);
        if (match) return match;
      }
    }
    return null;
  }

  private async findMALMatchFromTMDB(tmdbInfo: TMDBMedia, mediaType: 'tv' | 'movie'): Promise<MappingResult['mal'] | null> {
    const title = tmdbInfo.title || tmdbInfo.name || '';
    const results = await this.searchMAL(title);
    return this.findBestMALMatchFromTMDBResults(tmdbInfo, results, mediaType);
  }

  private async findAniListMatch(tmdbInfo: TMDBMedia, mediaType: 'tv' | 'movie'): Promise<MappingResult['anilist'] | null> {
    const title = tmdbInfo.title || tmdbInfo.name || '';
    let results = await this.searchAniList(title);
    let match = this.findBestAniListMatchFromResults(tmdbInfo, results, mediaType);
    if (match) return match;

    if (tmdbInfo.original_title && tmdbInfo.original_title !== title) {
      results = await this.searchAniList(tmdbInfo.original_title);
      match = this.findBestAniListMatchFromResults(tmdbInfo, results, mediaType);
    }
    return match;
  }

  // --------------------------------------------------------------------------
  // MATCHING RESULT PROCESSORS
  // --------------------------------------------------------------------------

  private async findBestTMDBMatchFromResults(animeInfo: AniListMedia, results: TMDBMedia[], searchType: 'tv' | 'movie' | 'multi'): Promise<MappingResult['tmdb'] | null> {
    if (!results?.length) return null;

    const animeYear = animeInfo.startDate?.year || animeInfo.seasonYear;
    const animeTitles = this.extractTitles(animeInfo);
    let bestMatch: MappingResult['tmdb'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      if (result.adult) continue;
      const mediaType = searchType === 'multi' ? (result.media_type === 'movie' ? 'movie' : 'tv') : searchType;
      const score = this.calculateTMDBMatchScore(animeInfo, result, animeTitles, animeYear, mediaType);
      
      console.log(`[DEBUG] TMDB candidate: "${result.title || result.name}" | Score: ${score.toFixed(3)} | Year: ${this.extractYear(result.release_date || result.first_air_date)} | Type: ${mediaType}`);

      // Lower threshold for sequels (they often have different titles)
      const isSequel = this.hasSequelIndicators(animeInfo.title);
      const threshold = isSequel ? 0.4 : 0.6;

      if (score > bestScore && score > threshold) {
        bestScore = score;
        
        // Detect season number for TV shows
        let seasonNumber: number | undefined;
        let seasonName: string | undefined;
        let splitCourPart: 1 | 2 | undefined;
        
        if (mediaType === 'tv') {
          const detectedSeason = await this.detectTMDBSeason(result.id, animeInfo, animeYear);
          seasonNumber = detectedSeason?.seasonNumber;
          seasonName = detectedSeason?.seasonName;
          splitCourPart = detectedSeason?.splitCourPart;
        }
        
        bestMatch = {
          id: result.id,
          title: result.title || result.name || '',
          mediaType,
          seasonNumber,
          seasonName,
          splitCourPart,
          releaseDate: result.release_date || result.first_air_date,
          overview: result.overview,
          score: bestScore,
          year: this.extractYear(result.release_date || result.first_air_date) || undefined
        };
      }
    }
    return bestMatch;
  }

  private findBestMALMatchFromResults(animeInfo: AniListMedia, results: MALMedia[]): MappingResult['mal'] | null {
    if (!results?.length) return null;

    const animeYear = animeInfo.startDate?.year || animeInfo.seasonYear;
    const animeTitles = this.extractTitles(animeInfo);
    let bestMatch: MappingResult['mal'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      const score = this.calculateMALMatchScore(animeInfo, result, animeTitles, animeYear);
      console.log(`[DEBUG] MAL candidate: "${result.title}" | Score: ${score.toFixed(3)} | Year: ${this.extractYear(result.start_date)} | Episodes: ${result.num_episodes}`);
      
      if (score > bestScore && score > 0.5) {  // Lowered from 0.6 to 0.5
        bestScore = score;
        bestMatch = {
          id: result.id,
          title: result.title,
          alternativeTitles: result.alternative_titles,
          mediaType: result.media_type,
          episodes: result.num_episodes,
          status: result.status,
          year: this.extractYear(result.start_date) || undefined,
          score: bestScore
        };
      }
    }
    return bestMatch;
  }

  private findBestAniListMatchFromMALResults(malInfo: MALMedia, results: AniListMedia[]): MappingResult['anilist'] | null {
    if (!results?.length) return null;

    const malTitles = this.extractMALTitles(malInfo);
    const malYear = this.extractYear(malInfo.start_date);
    let bestMatch: MappingResult['anilist'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      const score = this.calculateAniListMatchScoreFromMAL(malInfo, result, malTitles, malYear);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestMatch = {
          id: result.id,
          title: result.title,
          format: result.format,
          episodes: result.episodes,
          status: result.status,
          year: result.startDate?.year || result.seasonYear,
          score: bestScore
        };
      }
    }
    return bestMatch;
  }

  private findBestTMDBMatchFromMALResults(malInfo: MALMedia, results: TMDBMedia[], mediaType: 'tv' | 'movie'): MappingResult['tmdb'] | null {
    if (!results?.length) return null;

    const malTitles = this.extractMALTitles(malInfo);
    const malYear = this.extractYear(malInfo.start_date);
    let bestMatch: MappingResult['tmdb'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      if (result.adult) continue;
      const score = this.calculateTMDBMatchScoreFromMAL(malInfo, result, malTitles, malYear, mediaType);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestMatch = {
          id: result.id,
          title: result.title || result.name || '',
          mediaType,
          releaseDate: result.release_date || result.first_air_date,
          overview: result.overview,
          score: bestScore,
          year: this.extractYear(result.release_date || result.first_air_date) || undefined
        };
      }
    }
    return bestMatch;
  }

  private findBestMALMatchFromTMDBResults(tmdbInfo: TMDBMedia, results: MALMedia[], mediaType: 'tv' | 'movie'): MappingResult['mal'] | null {
    if (!results?.length) return null;

    const tmdbTitle = tmdbInfo.title || tmdbInfo.name || '';
    const tmdbYear = this.extractYear(tmdbInfo.release_date || tmdbInfo.first_air_date);
    let bestMatch: MappingResult['mal'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      const score = this.calculateMALMatchScoreFromTMDB(tmdbInfo, result, tmdbTitle, tmdbYear, mediaType);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestMatch = {
          id: result.id,
          title: result.title,
          alternativeTitles: result.alternative_titles,
          mediaType: result.media_type,
          episodes: result.num_episodes,
          status: result.status,
          year: this.extractYear(result.start_date) || undefined,
          score: bestScore
        };
      }
    }
    return bestMatch;
  }

  private findBestAniListMatchFromResults(tmdbInfo: TMDBMedia, results: AniListMedia[], mediaType: 'tv' | 'movie'): MappingResult['anilist'] | null {
    if (!results?.length) return null;

    const tmdbTitle = tmdbInfo.title || tmdbInfo.name || '';
    const tmdbYear = this.extractYear(tmdbInfo.release_date || tmdbInfo.first_air_date);
    let bestMatch: MappingResult['anilist'] | null = null;
    let bestScore = 0;

    for (const result of results) {
      const score = this.calculateAniListMatchScore(tmdbInfo, result, tmdbTitle, tmdbYear, mediaType);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestMatch = {
          id: result.id,
          title: result.title,
          format: result.format,
          episodes: result.episodes,
          status: result.status,
          year: result.startDate?.year || result.seasonYear,
          score: bestScore
        };
      }
    }
    return bestMatch;
  }

  // --------------------------------------------------------------------------
  // SCORING ALGORITHMS
  // --------------------------------------------------------------------------

  private calculateTMDBMatchScore(animeInfo: AniListMedia, tmdbResult: TMDBMedia, animeTitles: string[], animeYear: number | undefined, mediaType: string): number {
    let score = 0;
    const tmdbTitle = this.normalizeTitle(tmdbResult.title || tmdbResult.name || '');
    const tmdbYear = this.extractYear(tmdbResult.release_date || tmdbResult.first_air_date);

    // Title similarity
    let titleScore = 0;
    for (const title of animeTitles) {
      const normalizedAnimeTitle = this.normalizeTitle(title);
      const similarity = this.calculateTitleSimilarity(normalizedAnimeTitle, tmdbTitle);
      titleScore = Math.max(titleScore, similarity);
      
      // Also try with base title (for sequels)
      const baseTitle = this.normalizeTitle(this.stripOVASuffixes(title));
      if (baseTitle !== normalizedAnimeTitle) {
        const baseSimilarity = this.calculateTitleSimilarity(baseTitle, tmdbTitle);
        // Give slightly lower weight to base title matches
        titleScore = Math.max(titleScore, baseSimilarity * 0.9);
      }
    }
    score += titleScore * 0.6;

    // Year matching
    if (animeYear && tmdbYear) {
      score += animeYear === tmdbYear ? 0.2 : Math.abs(animeYear - tmdbYear) === 1 ? 0.1 : 0;
    }

    // Format matching
    if ((animeInfo.format === 'MOVIE' && mediaType === 'movie') ||
        (['TV', 'TV_SHORT', 'ONA', 'OVA'].includes(animeInfo.format) && mediaType === 'tv')) {
      score += 0.1;
    }

    // Popularity/quality bonuses
    if (tmdbResult.vote_average && tmdbResult.vote_average > 7) score += 0.05;
    if (tmdbResult.popularity && tmdbResult.popularity > 10) score += 0.05;

    return score;
  }

  private calculateMALMatchScore(animeInfo: AniListMedia, malResult: MALMedia, animeTitles: string[], animeYear: number | undefined): number {
    let score = 0;
    const malTitles = this.extractMALTitles(malResult);

    let titleScore = 0;
    for (const animeTitle of animeTitles) {
      for (const malTitle of malTitles) {
        titleScore = Math.max(titleScore, this.calculateTitleSimilarity(this.normalizeTitle(animeTitle), this.normalizeTitle(malTitle)));
      }
    }
    score += titleScore * 0.6;

    const malYear = this.extractYear(malResult.start_date);
    if (animeYear && malYear) {
      score += animeYear === malYear ? 0.2 : Math.abs(animeYear - malYear) === 1 ? 0.1 : 0;
    } else if (!malYear && animeYear) {
      // If MAL doesn't have year set (TBA/upcoming), give partial credit
      score += 0.05;
    }

    if (animeInfo.episodes && malResult.num_episodes) {
      score += animeInfo.episodes === malResult.num_episodes ? 0.1 : Math.abs(animeInfo.episodes - malResult.num_episodes) <= 2 ? 0.05 : 0;
    }

    if (malResult.mean && malResult.mean > 7) score += 0.05;

    return score;
  }

  private calculateAniListMatchScoreFromMAL(malInfo: MALMedia, anilistResult: AniListMedia, malTitles: string[], malYear: number | null): number {
    let score = 0;
    const anilistTitles = this.extractTitles(anilistResult);

    let titleScore = 0;
    for (const malTitle of malTitles) {
      for (const anilistTitle of anilistTitles) {
        titleScore = Math.max(titleScore, this.calculateTitleSimilarity(this.normalizeTitle(malTitle), this.normalizeTitle(anilistTitle)));
      }
    }
    score += titleScore * 0.6;

    const anilistYear = anilistResult.startDate?.year || anilistResult.seasonYear;
    if (malYear && anilistYear) {
      score += malYear === anilistYear ? 0.2 : Math.abs(malYear - anilistYear) === 1 ? 0.1 : 0;
    }

    if (malInfo.num_episodes && anilistResult.episodes) {
      score += malInfo.num_episodes === anilistResult.episodes ? 0.1 : Math.abs(malInfo.num_episodes - anilistResult.episodes) <= 2 ? 0.05 : 0;
    }

    if (anilistResult.averageScore && anilistResult.averageScore > 70) score += 0.05;

    return score;
  }

  private calculateTMDBMatchScoreFromMAL(malInfo: MALMedia, tmdbResult: TMDBMedia, malTitles: string[], malYear: number | null, mediaType: 'tv' | 'movie'): number {
    let score = 0;
    const tmdbTitle = this.normalizeTitle(tmdbResult.title || tmdbResult.name || '');

    let titleScore = 0;
    for (const malTitle of malTitles) {
      titleScore = Math.max(titleScore, this.calculateTitleSimilarity(this.normalizeTitle(malTitle), tmdbTitle));
    }
    score += titleScore * 0.6;

    const tmdbYear = this.extractYear(tmdbResult.release_date || tmdbResult.first_air_date);
    if (malYear && tmdbYear) {
      score += malYear === tmdbYear ? 0.2 : Math.abs(malYear - tmdbYear) === 1 ? 0.1 : 0;
    }

    if (malInfo.media_type) {
      if ((malInfo.media_type === 'movie' && mediaType === 'movie') ||
          (['tv', 'ona', 'ova', 'special'].includes(malInfo.media_type.toLowerCase()) && mediaType === 'tv')) {
        score += 0.1;
      }
    }

    if (tmdbResult.vote_average && tmdbResult.vote_average > 7) score += 0.05;

    return score;
  }

  private calculateMALMatchScoreFromTMDB(tmdbInfo: TMDBMedia, malResult: MALMedia, tmdbTitle: string, tmdbYear: number | null, mediaType: 'tv' | 'movie'): number {
    let score = 0;
    const malTitles = this.extractMALTitles(malResult);

    let titleScore = 0;
    const normalizedTmdbTitle = this.normalizeTitle(tmdbTitle);
    for (const malTitle of malTitles) {
      titleScore = Math.max(titleScore, this.calculateTitleSimilarity(normalizedTmdbTitle, this.normalizeTitle(malTitle)));
    }
    score += titleScore * 0.6;

    const malYear = this.extractYear(malResult.start_date);
    if (tmdbYear && malYear) {
      score += tmdbYear === malYear ? 0.2 : Math.abs(tmdbYear - malYear) === 1 ? 0.1 : 0;
    }

    if (malResult.media_type) {
      if ((malResult.media_type === 'movie' && mediaType === 'movie') ||
          (['tv', 'ona', 'ova', 'special'].includes(malResult.media_type.toLowerCase()) && mediaType === 'tv')) {
        score += 0.1;
      }
    }

    if (malResult.mean && malResult.mean > 7) score += 0.1;

    return score;
  }

  private calculateAniListMatchScore(tmdbInfo: TMDBMedia, anilistResult: AniListMedia, tmdbTitle: string, tmdbYear: number | null, mediaType: 'tv' | 'movie'): number {
    let score = 0;
    const anilistTitles = this.extractTitles(anilistResult);

    let titleScore = 0;
    const normalizedTmdbTitle = this.normalizeTitle(tmdbTitle);
    for (const title of anilistTitles) {
      titleScore = Math.max(titleScore, this.calculateTitleSimilarity(normalizedTmdbTitle, this.normalizeTitle(title)));
    }
    score += titleScore * 0.6;

    const anilistYear = anilistResult.startDate?.year || anilistResult.seasonYear;
    if (tmdbYear && anilistYear) {
      score += tmdbYear === anilistYear ? 0.2 : Math.abs(tmdbYear - anilistYear) === 1 ? 0.1 : 0;
    }

    if ((anilistResult.format === 'MOVIE' && mediaType === 'movie') ||
        (['TV', 'TV_SHORT', 'ONA', 'OVA'].includes(anilistResult.format) && mediaType === 'tv')) {
      score += 0.1;
    }

    if (anilistResult.averageScore && anilistResult.averageScore > 70) score += 0.1;

    return score;
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  private extractTitles(animeInfo: AniListMedia): string[] {
    const titles: string[] = [];
    if (animeInfo.title) {
      if (animeInfo.title.english) titles.push(animeInfo.title.english);
      if (animeInfo.title.romaji) titles.push(animeInfo.title.romaji);
      if (animeInfo.title.userPreferred) titles.push(animeInfo.title.userPreferred);
      if (animeInfo.title.native) titles.push(animeInfo.title.native);
    }
    if (animeInfo.synonyms) titles.push(...animeInfo.synonyms);
    return [...new Set(titles)].filter(t => t?.trim());
  }

  private extractMALTitles(malInfo: MALMedia): string[] {
    const titles: string[] = [malInfo.title];
    if (malInfo.alternative_titles) {
      if (malInfo.alternative_titles.english) titles.push(malInfo.alternative_titles.english);
      if (malInfo.alternative_titles.japanese) titles.push(malInfo.alternative_titles.japanese);
      if (malInfo.alternative_titles.synonyms) titles.push(...malInfo.alternative_titles.synonyms);
    }
    return [...new Set(titles)].filter(t => t?.trim());
  }

  private calculateTitleSimilarity(title1: string, title2: string): number {
    if (!title1 || !title2) return 0;
    if (title1 === title2) return 1;

    const words1 = title1.split(' ').filter(w => w.length > 2);
    const words2 = title2.split(' ').filter(w => w.length > 2);
    if (!words1.length || !words2.length) return 0;

    const exactMatches = words1.filter(w => words2.includes(w)).length;
    let partialMatches = 0;

    for (const w1 of words1) {
      for (const w2 of words2) {
        if (w1.length > 3 && w2.length > 3) {
          const sim = this.getLevenshteinSimilarity(w1, w2);
          if (sim > 0.7) partialMatches += sim * 0.5;
        }
      }
    }

    return Math.min((exactMatches + partialMatches) / Math.max(words1.length, words2.length), 1);
  }

  private getLevenshteinSimilarity(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(0));
    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }

    const distance = matrix[str2.length][str1.length];
    return 1 - (distance / Math.max(str1.length, str2.length));
  }

  private normalizeTitle(title: string): string {
    return title?.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim() || '';
  }

  private extractYear(dateString: string | undefined): number | null {
    if (!dateString) return null;
    const year = parseInt(dateString.substring(0, 4));
    return isNaN(year) ? null : year;
  }

  private getFromCache<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item || Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.data as T;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiry: Date.now() + this.cacheExpiry });
  }

  // --------------------------------------------------------------------------
  // PROVIDER DATA FETCHERS
  // --------------------------------------------------------------------------

  private async fetchAnimePaheData(anilistId: string | number): Promise<MappingResult['animepahe'] | null> {
    try {
      const response = await axios.get(`http://localhost:3000/animepahe/map/${anilistId}`, {
        timeout: 5000,
        validateStatus: (status) => status === 200
      });
      const data = response.data;
      
      if (data.animepahe) {
        return {
          id: data.animepahe.id,
          slug: data.animepahe.id.split('-')[0],
          episodes: data.animepahe.episodes?.length || 0
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchHiAnimeData(anilistId: string | number): Promise<MappingResult['hianime'] | null> {
    try {
      const response = await axios.get(`http://localhost:3000/hianime/${anilistId}`, {
        timeout: 5000,
        validateStatus: (status) => status === 200
      });
      const data = response.data;
      
      if (data.hianimeId) {
        return {
          id: data.hianimeId,
          slug: data.hianimeId,
          episodes: data.totalEpisodes || 0
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchAnimeKaiData(anilistId: string | number): Promise<MappingResult['animekai'] | null> {
    try {
      const response = await axios.get(`http://localhost:3000/animekai/map/${anilistId}`, {
        timeout: 5000,
        validateStatus: (status) => status === 200
      });
      const data = response.data;
      
      if (data.animekai) {
        // Extract slug from URL (e.g., "https://anikai.to/watch/anime-slug" -> "anime-slug")
        const urlPath = data.animekai.id || data.animekai.url || '';
        const slug = urlPath.split('/watch/')[1] || urlPath.split('/').pop() || urlPath;
        
        return {
          id: slug,
          url: data.animekai.url,
          episodes: data.animekai.episodes || 0
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchAnimeSamaData(anilistId: string | number): Promise<MappingResult['animesama'] | null> {
    try {
      // Call the provider directly to avoid circular dependency
      const data = await getEpisodesForAnime(anilistId);
      
      if (data.animesamaSlug) {
        return {
          slug: data.animesamaSlug,
          seasonSlug: data.seasonSlug || null,
          seasons: data.totalSeasons || 0
        };
      }
      return null;
    } catch (error) {
      console.error('[DEBUG] Error fetching AnimeSama data:', error);
      return null;
    }
  }
}
