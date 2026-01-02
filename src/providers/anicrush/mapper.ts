import axios from 'axios';
import stringSimilarity from 'string-similarity';

export const getCommonHeaders = () => ({
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'x-site': 'anicrush',
    'Referer': 'https://anicrush.to/',
    'Origin': 'https://anicrush.to',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty'
});

const ANILIST_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title {
      romaji
      english
      native
    }
    synonyms
    format
    seasonYear
  }
}`;

function normalizeTitle(title: string): string {
    if (!title) return '';
    return title.toLowerCase()
        .replace(/[^a-z0-9\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\uff00-\uff9f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function getAniListDetails(anilistId: string) {
    try {
        const response = await axios({
            url: 'https://graphql.anilist.co',
            method: 'POST',
            data: {
                query: ANILIST_QUERY,
                variables: {
                    id: parseInt(anilistId)
                }
            }
        });

        if (!response.data?.data?.Media) {
            throw new Error('Anime not found on AniList');
        }

        return response.data.data.Media;
    } catch (error: any) {
        console.error('Error fetching from AniList:', error.message);
        throw new Error('Failed to fetch anime details from AniList');
    }
}

async function searchAnicrush(title: string) {
    if (!title) {
        throw new Error('Search title is required');
    }

    try {
        const headers = getCommonHeaders();
        const response = await axios({
            method: 'GET',
            url: 'https://api.anicrush.to/shared/v2/movie/list',
            params: {
                keyword: title,
                page: 1,
                limit: 24
            },
            headers
        });

        if (response.data?.status === false) {
            throw new Error(response.data.message || 'Search failed');
        }

        return response.data;
    } catch (error: any) {
        if (error.response) {
            console.error('Search API error:', error.response.data);
            throw new Error(error.response.data.message || 'Search request failed');
        } else if (error.request) {
            console.error('No response received:', error.request);
            throw new Error('No response from search API');
        } else {
            console.error('Search error:', error.message);
            throw new Error('Failed to search anime');
        }
    }
}

async function getEpisodeList(movieId: string) {
    if (!movieId) {
        throw new Error('Movie ID is required');
    }

    try {
        const headers = getCommonHeaders();
        const response = await axios({
            method: 'GET',
            url: 'https://api.anicrush.to/shared/v2/episode/list',
            params: {
                _movieId: movieId
            },
            headers
        });

        if (response.data?.status === false) {
            throw new Error(response.data.message || 'Failed to fetch episode list');
        }

        return response.data;
    } catch (error: any) {
        if (error.response) {
            console.error('Episode list API error:', error.response.data);
            throw new Error(error.response.data.message || 'Episode list request failed');
        } else if (error.request) {
            console.error('No response received:', error.request);
            throw new Error('No response from episode list API');
        } else {
            console.error('Episode list error:', error.message);
            throw new Error('Failed to fetch episode list');
        }
    }
}

function calculateTitleSimilarity(title1: string, title2: string): number {
    if (!title1 || !title2) return 0;
    return stringSimilarity.compareTwoStrings(
        title1.toLowerCase(), 
        title2.toLowerCase()
    ) * 100;
}

function extractSeasonNumber(title: string): number | null {
    if (!title) return null;
    const lower = title.toLowerCase();

    let match = lower.match(/(?:season|cour|part)\s*(\d{1,2})/i);
    if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (!Number.isNaN(num)) return num;
    }

    match = lower.match(/(\d{1,2})\s*$/);
    if (match && match[1]) {
        const num = parseInt(match[1], 10);
        if (!Number.isNaN(num) && num < 10) return num;
    }

    return null;
}

function findBestMatch(anilistData: any, anicrushResults: any) {
    if (!anicrushResults?.result?.movies?.length) return null;

    const anilistTitles = [
        anilistData.title.romaji,
        anilistData.title.english,
        anilistData.title.native,
        ...(anilistData.synonyms || [])
    ].filter(Boolean).map(normalizeTitle);

    const primaryAniListTitle = normalizeTitle(
        anilistData.title.romaji || anilistData.title.english || anilistData.title.native
    );
    const anilistSeason = extractSeasonNumber(primaryAniListTitle);

    let bestMatch = null;
    let highestScore = 0;

    const formatTypeMap: { [key: string]: string } = {
        TV: 'TV',
        TV_SHORT: 'TV',
        MOVIE: 'MOVIE',
        SPECIAL: 'SPECIAL',
        OVA: 'OVA',
        ONA: 'ONA',
        MUSIC: 'MUSIC'
    };
    const expectedType = formatTypeMap[anilistData.format] || null;

    for (const result of anicrushResults.result.movies) {
        let typePenalty = 0;
        if (expectedType && result.type && expectedType !== result.type) {
            typePenalty = 15;
        }

        const resultTitles = [result.name, result.name_english].filter(Boolean);

        for (const aTitle of anilistTitles) {
            for (const rTitle of resultTitles) {
                const similarity = calculateTitleSimilarity(aTitle, rTitle);
                let score = Math.max(0, similarity - typePenalty);

                if (anilistSeason !== null) {
                    const resultSeason = extractSeasonNumber(rTitle);
                    if (resultSeason !== null) {
                        if (resultSeason === anilistSeason) {
                            score += 25;
                        } else {
                            score -= 30;
                        }
                    }
                }
                
                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = result;
                }
            }
        }
    }

    return highestScore >= 60 ? bestMatch : null;
}

export async function mapAniListToAnicrush(anilistId: string) {
    try {
        const anilistData = await getAniListDetails(anilistId);

        const titlesToTry = [
            anilistData.title.romaji,
            anilistData.title.english,
            anilistData.title.native
        ].filter(Boolean);

        let bestMatch = null;
        for (const title of titlesToTry) {
            const searchResults = await searchAnicrush(title);
            bestMatch = findBestMatch(anilistData, searchResults);
            if (bestMatch) break;
        }

        if (!bestMatch) throw new Error('No matching anime found on anicrush');

        return {
            anilist_id: anilistId,
            anicrush_id: bestMatch.id,
            title: {
                romaji: anilistData.title.romaji,
                english: anilistData.title.english,
                native: anilistData.title.native,
                anicrush: bestMatch.name,
                anicrush_english: bestMatch.name_english
            },
            type: bestMatch.type,
            year: anilistData.seasonYear
        };
    } catch (error: any) {
        console.error('Mapper error:', error.message);
        throw error;
    }
}
