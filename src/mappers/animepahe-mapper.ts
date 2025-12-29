import { AniList } from '../providers/anilist.js';
import { AnimePahe } from '../providers/animepahe.js';

interface AnimePaheEpisode {
  title: string;
  episodeId: string;
  number: number;
  image: string;
}

interface MappingResult {
  id: number;
  animepahe: {
    id: string;
    title: string;
    episodes: AnimePaheEpisode[];
    type: string;
    status: string;
    season: string;
    year: number;
    score: number;
    posterImage: string;
    session: string;
  } | null;
}

interface AnimeInfo {
  id: number;
  title: {
    romaji: string | null;
    english: string | null;
    userPreferred?: string | null;
  };
  startDate?: {
    year: number | null;
  };
  seasonYear?: number | null;
}

interface AnimePaheSearchResult {
  id: string;
  title?: string;
  name?: string;
  type: string;
  status: string;
  season: string;
  year: number;
  score: number;
  poster: string;
  session: string;
  episodes?: number | { sub: any; dub: string };
}

export async function mapAnilistToAnimePahe(anilistId: string | number): Promise<MappingResult> {
  const mapper = new AnimepaheMapper();
  return await mapper.mapAnilistToAnimePahe(anilistId);
}

export class AnimepaheMapper {
  private anilist: AniList;
  private animePahe: AnimePahe;

  constructor() {
    this.anilist = new AniList();
    this.animePahe = new AnimePahe();
  }

  async mapAnilistToAnimePahe(anilistId: string | number): Promise<MappingResult> {
    try {
      const animeInfo = await this.anilist.getAnimeInfo(parseInt(String(anilistId)));

      if (!animeInfo) {
        throw new Error(`Anime with id ${anilistId} not found on AniList`);
      }

      const bestMatch = await this.findAnimePaheMatch(animeInfo);

      if (!bestMatch) {
        return {
          id: animeInfo.id,
          animepahe: null
        };
      }

      const episodeData = await this.getAnimePaheEpisodes(bestMatch);

      return {
        id: animeInfo.id,
        animepahe: {
          id: bestMatch.id,
          title: bestMatch.title || bestMatch.name || '',
          episodes: episodeData.episodes,
          type: bestMatch.type,
          status: bestMatch.status,
          season: bestMatch.season,
          year: bestMatch.year,
          score: bestMatch.score,
          posterImage: bestMatch.poster,
          session: bestMatch.session
        }
      };
    } catch (error: any) {
      console.error('Error mapping AniList to AnimePahe:', error.message);
      throw new Error('Failed to map AniList to AnimePahe: ' + error.message);
    }
  }

  private async findAnimePaheMatch(animeInfo: AnimeInfo): Promise<AnimePaheSearchResult | null> {
    let bestTitle = animeInfo.title.romaji || animeInfo.title.english || animeInfo.title.userPreferred || '';

    const searchResults = await this.animePahe.scrapeSearchResults(bestTitle);

    if (searchResults && searchResults.length > 0) {
      const rawId = animeInfo.id.toString();
      for (const result of searchResults) {
        const resultId = (result.id || '').split('-')[0];
        if (resultId && resultId === rawId) {
          return result;
        }
      }

      const match = this.findBestMatchFromResults(animeInfo, searchResults);
      if (match) return match;
    }

    const genericTitle = this.getGenericTitle(animeInfo);

    if (genericTitle && genericTitle !== bestTitle) {
      const fallbackResults = await this.animePahe.scrapeSearchResults(genericTitle);

      if (fallbackResults && fallbackResults.length > 0) {
        return this.findBestMatchFromResults(animeInfo, fallbackResults);
      }
    }

    return null;
  }

  private findBestMatchFromResults(
    animeInfo: AnimeInfo,
    results: AnimePaheSearchResult[]
  ): AnimePaheSearchResult | null {
    if (!results || results.length === 0) return null;

    const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const anilistTitles = [
      animeInfo.title.romaji,
      animeInfo.title.english,
      animeInfo.title.userPreferred
    ].filter(Boolean).map(t => normalizeTitle(t!));

    const anilistYear =
      (animeInfo.startDate && animeInfo.startDate.year) ?
      animeInfo.startDate.year : animeInfo.seasonYear;

    const animeYear = anilistYear || this.extractYearFromTitle(animeInfo);

    let bestMatch: AnimePaheSearchResult | null = null;

    if (animeYear) {
      const yearMatches: AnimePaheSearchResult[] = [];
      for (const result of results) {
        const resultYear = result.year ? parseInt(String(result.year)) : this.extractYearFromTitle(result);
        if (resultYear === animeYear) {
          yearMatches.push(result);
        }
      }

      if (yearMatches.length > 0) {
        for (const match of yearMatches) {
          const resultTitle = normalizeTitle(match.title || match.name || '');

          for (const title of anilistTitles) {
            if (!title) continue;

            if (resultTitle === title ||
                (resultTitle.includes(title) && title.length > 7) ||
                (title.includes(resultTitle) && resultTitle.length > 7)) {
              return match;
            }
          }

          for (const title of anilistTitles) {
            if (!title) continue;

            const similarity = this.calculateTitleSimilarity(title, resultTitle);
            if (similarity > 0.5) {
              bestMatch = match;
              break;
            }
          }

          if (bestMatch) break;
        }

        if (bestMatch) return bestMatch;
        return yearMatches[0];
      }
    }

    for (const result of results) {
      const resultTitle = normalizeTitle(result.title || result.name || '');

      for (const title of anilistTitles) {
        if (!title) continue;

        if (resultTitle === title) {
          return result;
        }
      }
    }

    bestMatch = this.findBestSimilarityMatch(anilistTitles, results);
    if (bestMatch) return bestMatch;

    return results[0];
  }

  private findBestSimilarityMatch(
    titles: string[],
    results: AnimePaheSearchResult[]
  ): AnimePaheSearchResult | null {
    const normalizeTitle = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    let bestMatch: AnimePaheSearchResult | null = null;
    let highestSimilarity = 0;

    for (const result of results) {
      const resultTitle = normalizeTitle(result.title || result.name || '');

      for (const title of titles) {
        if (!title) continue;

        const similarity = this.calculateTitleSimilarity(title, resultTitle);
        if (similarity > highestSimilarity) {
          highestSimilarity = similarity;
          bestMatch = result;
        }
      }
    }

    return highestSimilarity > 0.6 ? bestMatch : null;
  }

  private async getAnimePaheEpisodes(match: AnimePaheSearchResult): Promise<{
    totalEpisodes: number;
    episodes: AnimePaheEpisode[]
  }> {
    try {
      const episodeData = await this.animePahe.scrapeEpisodes(match.id);
      return {
        totalEpisodes: episodeData.totalEpisodes || 0,
        episodes: episodeData.episodes || []
      };
    } catch (error: any) {
      console.error('Error getting AnimePahe episodes:', error.message);
      return { totalEpisodes: 0, episodes: [] };
    }
  }

  private calculateTitleSimilarity(title1: string, title2: string): number {
    if (!title1 || !title2) return 0;

    const norm1 = title1.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const norm2 = title2.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

    if (norm1 === norm2) return 1;

    const words1 = norm1.split(' ').filter(Boolean);
    const words2 = norm2.split(' ').filter(Boolean);

    const commonCount = words1.filter(w => words2.includes(w)).length;

    return commonCount * 2 / (words1.length + words2.length);
  }

  private extractYearFromTitle(item: any): number | null {
    if (!item) return null;

    let titleStr = '';
    if (typeof item === 'string') {
      titleStr = item;
    } else if (typeof item === 'object') {
      if (item.title) {
        if (typeof item.title === 'string') {
          titleStr = item.title;
        } else if (typeof item.title === 'object') {
          titleStr = item.title.userPreferred || item.title.english || item.title.romaji || '';
        }
      } else if (item.name) {
        titleStr = item.name;
      }
    }

    if (!titleStr) return null;

    const yearMatches = titleStr.match(/[\(\[](\d{4})[\)\]]/);

    if (yearMatches && yearMatches[1]) {
      const year = parseInt(yearMatches[1]);
      if (!isNaN(year) && year > 1950 && year <= new Date().getFullYear()) {
        return year;
      }
    }

    return null;
  }

  private getGenericTitle(animeInfo: AnimeInfo): string | null {
    if (!animeInfo || !animeInfo.title) return null;

    const title = animeInfo.title.english || animeInfo.title.romaji || animeInfo.title.userPreferred;
    if (!title) return null;

    return title.replace(/\([^)]*\d{4}[^)]*\)/g, '').replace(/\[[^\]]*\d{4}[^\]]*\]/g, '').trim();
  }
}

export default mapAnilistToAnimePahe;
