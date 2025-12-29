import { getEpisodesForAnime } from '../providers/animesama.js';
import { AnimeMapper } from './cross-mapper.js';

export async function mapAnilistToAnimeSama(anilistId: string | number) {
  try {

    const mapper = new AnimeMapper(
      process.env.TMDB_API_KEY || '',
      process.env.MAL_CLIENT_ID || ''
    );

    console.log('[AnimeSama Mapper] Fetching cross-mapper data for enhanced matching...');
    const crossMapperData = await mapper.mapFromAniList(Number(anilistId));

    const tmdbData = crossMapperData.tmdb ? {
      seasonNumber: crossMapperData.tmdb.seasonNumber,
      seasonName: crossMapperData.tmdb.seasonName,
      splitCourPart: crossMapperData.tmdb.splitCourPart,
      releaseDate: crossMapperData.tmdb.releaseDate,
      year: crossMapperData.tmdb.year,
    } : undefined;

    if (tmdbData?.seasonNumber) {
      console.log(`[AnimeSama Mapper] Using TMDB data: Season ${tmdbData.seasonNumber}${tmdbData.splitCourPart ? ` Part ${tmdbData.splitCourPart}` : ''}`);
    } else {
      console.log('[AnimeSama Mapper] No TMDB data available, using fallback matching');
    }

    const animesamaResult = await getEpisodesForAnime(Number(anilistId));

    return {
      ...animesamaResult,
      crossMapperData: {
        anilist: crossMapperData.anilist,
        mal: crossMapperData.mal,
        tmdb: crossMapperData.tmdb,
      },
    };
  } catch (error) {
    console.error('Error mapping Anilist to AnimeSama:', error);
    throw error;
  }
}

export default mapAnilistToAnimeSama;
