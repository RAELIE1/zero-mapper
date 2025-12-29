import axios, { AxiosResponse } from 'axios';
import { ANILIST_URL } from '../constants/api-constants.js';

interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
  userPreferred?: string | null;
}

interface AniListDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

interface AniListCoverImage {
  large: string | null;
  medium: string | null;
}

interface AniListAnimeInfo {
  id: number;
  title: AniListTitle;
  description: string | null;
  coverImage: AniListCoverImage;
  bannerImage: string | null;
  episodes: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: AniListDate;
  endDate: AniListDate;
  genres: string[];
  source: string | null;
  averageScore: number | null;
  synonyms: string[];
  isAdult: boolean;
  format: string | null;
  type: string;
}

interface AniListSearchResult {
  id: number;
  title: AniListTitle;
  description: string | null;
  coverImage: AniListCoverImage;
  episodes: number | null;
  status: string | null;
  genres: string[];
  averageScore: number | null;
}

export class AniList {
  private baseUrl: string;

  constructor() {
    this.baseUrl = ANILIST_URL;
  }

  async getAnimeInfo(id: number): Promise<AniListAnimeInfo> {
    try {
      const query = `
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id
            title {
              romaji
              english
              native
              userPreferred
            }
            description
            coverImage {
              large
              medium
            }
            bannerImage
            episodes
            status
            season
            seasonYear
            startDate {
              year
              month
              day
            }
            endDate {
              year
              month
              day
            }
            genres
            source
            averageScore
            synonyms
            isAdult
            format
            type
          }
        }
      `;

      const response: AxiosResponse = await axios.post(this.baseUrl, {
        query,
        variables: { id }
      });

      return response.data.data.Media;
    } catch (error: any) {
      console.error('Error fetching anime info from AniList:', error.message);
      throw new Error('Failed to fetch anime info from AniList');
    }
  }

  async searchAnime(query: string): Promise<AniListSearchResult[]> {
    try {
      const gqlQuery = `
        query ($search: String) {
          Page(page: 1, perPage: 10) {
            media(search: $search, type: ANIME) {
              id
              title {
                romaji
                english
                native
              }
              description
              coverImage {
                large
                medium
              }
              episodes
              status
              genres
              averageScore
            }
          }
        }
      `;

      const response: AxiosResponse = await axios.post(this.baseUrl, {
        query: gqlQuery,
        variables: { search: query }
      });

      return response.data.data.Page.media;
    } catch (error: any) {
      console.error('Error searching anime on AniList:', error.message);
      throw new Error('Failed to search anime on AniList');
    }
  }
}

export default AniList;
