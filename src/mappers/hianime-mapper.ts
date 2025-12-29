import { getEpisodesForAnime } from '../providers/hianime.js';

export async function mapAnilistToHiAnime(anilistId: string | number) {
  try {
    const episodes = await getEpisodesForAnime(Number(anilistId));
    return episodes;
  } catch (error) {
    console.error('Error mapping Anilist to HiAnime:', error);
    throw error;
  }
}

export default mapAnilistToHiAnime;
