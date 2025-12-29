import { load } from 'cheerio';
import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL, ANILIST_QUERY, HIANIME_URL, ANIZIP_URL } from '../constants/api-constants.js';

const DEBUG = process.env.DEBUG === 'true';
const REQUEST_TIMEOUT = 10000;
const MAX_RETRIES = 3;

const animeInfoCache = new Map();
const searchCache = new Map();
const wordVariationsCache = new Map();

const TITLE_REPLACEMENTS = {
  'season': ['s', 'sz'],
  's': ['season', 'sz'],
  'sz': ['season', 's'],
  'two': ['2', 'ii'],
  'three': ['3', 'iii'],
  'four': ['4', 'iv'],
  'five': ['5', 'v'],
  'six': ['6', 'vi'],
  'part': ['pt', 'p'],
  'episode': ['ep'],
  'chapters': ['ch'],
  'chapter': ['ch'],
  'first': ['1', 'i'],
  'second': ['2', 'ii'],
  'third': ['3', 'iii'],
  'fourth': ['4', 'iv'],
  'fifth': ['5', 'v'],
  'sixth': ['6', 'vi']
};

const SEQUEL_PATTERNS = {
  '2nd season': ['second season', 's2', 'season 2', 'season two', 'ii'],
  '3rd season': ['third season', 's3', 'season 3', 'season three', 'iii'],
  '4th season': ['fourth season', 's4', 'season 4', 'season four', 'iv'],
  'part 2': ['part two', 'p2', 'pt 2', 'cour 2'],
  'part 3': ['part three', 'p3', 'pt 3', 'cour 3'],
  'final season': ['last season', 'end', 'finale', 'final'],
  '2nd cour': ['second cour', 'cour 2'],
  '3rd cour': ['third cour', 'cour 3']
};

function debugLog(...args: any[]) {
  if (DEBUG) console.log('[DEBUG]', new Date().toISOString(), ...args);
}

function errorLog(...args: any[]) {
  console.error('[ERROR]', new Date().toISOString(), ...args);
}

const fetchWithTimeout = async (promise: Promise<any>, timeoutMs = REQUEST_TIMEOUT) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
  );
  return Promise.race([promise, timeout]);
};

async function fetchWithRetry(fetchFn: () => Promise<any>, maxRetries = MAX_RETRIES) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchWithTimeout(fetchFn());
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Retry ${i + 1}/${maxRetries} failed:`, errorMessage);
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

const normalizeText = (text: string) => {
  return text.toLowerCase()
    .replace(/&/g, 'and')
    .replace(/½/g, '0.5')
    .replace(/×/g, 'x')
    .replace(/['']/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const extractYears = (title: string, jname: string | null = null): string[] => {
  const years = new Set<string>();

  const titleYear = title?.match(/\((\d{4})\)/)?.[1];
  if (titleYear) years.add(titleYear);

  const jnameYear = jname?.match(/\((\d{4})\)/)?.[1];
  if (jnameYear) years.add(jnameYear);

  return [...years];
};

const extractSeasonNumber = (title: string) => {
  const patterns = [
    /season\s*(\d+)/i,
    /\ss(\d+)(?:\s|$)/i,
    /part\s*(\d+)/i,
    /cour\s*(\d+)/i,
    /\sp(\d+)(?:\s|$)/i
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return parseInt(match[1]);
  }
  return null;
};

const parseDuration = (durationText: string) => {
  if (!durationText) return null;
  const match = durationText.match(/(\d+)m/);
  return match ? parseInt(match[1]) : null;
};

const levenshteinDistance = (a: string, b: string) => {
  const matrix = Array(b.length + 1).fill(null).map(() =>
    Array(a.length + 1).fill(null)
  );

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  return matrix[b.length][a.length];
};

const getWordVariations = (word: string) => {
  const cacheKey = word.toLowerCase();
  if (wordVariationsCache.has(cacheKey)) {
    return wordVariationsCache.get(cacheKey);
  }

  const variations = new Set([word]);
  const normalized = normalizeText(word);
  variations.add(normalized);

  const withoutNumbers = word.replace(/\d+/g, '').trim();
  if (withoutNumbers !== word) variations.add(withoutNumbers);

  for (const [key, values] of Object.entries(TITLE_REPLACEMENTS)) {
    if (normalized === key) {
      values.forEach(v => variations.add(v));
    } else if (values.includes(normalized)) {
      variations.add(key);
      values.forEach(v => variations.add(v));
    }
  }

  for (const [key, values] of Object.entries(SEQUEL_PATTERNS)) {
    const normalizedKey = normalizeText(key);
    if (normalized === normalizedKey) {
      values.forEach(v => variations.add(v));
    } else if (values.includes(normalized)) {
      variations.add(normalizedKey);
      values.forEach(v => variations.add(v));
    }
  }

  const result = [...variations];
  wordVariationsCache.set(cacheKey, result);
  return result;
};

const ENHANCED_ANILIST_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      synonyms
      episodes
      format
      season
      seasonYear
      duration
      studios {
        nodes {
          name
        }
      }
    }
  }
`;

async function getAnimeInfo(anilistId: number) {
  if (animeInfoCache.has(anilistId)) {
    debugLog(`Cache hit for Anilist ID: ${anilistId}`);
    return animeInfoCache.get(anilistId);
  }

  try {
    const response = await fetchWithRetry(() =>
      client.post(ANILIST_URL, {
        query: ENHANCED_ANILIST_QUERY,
        variables: { id: anilistId }
      })
    );

    const animeData = response.data.data.Media;
    if (!animeData) return null;

    const allTitles = new Set([
      ...(animeData.synonyms || []),
      animeData.title.english,
      animeData.title.romaji
    ].filter(Boolean)
     .filter(t => !(/[\u4E00-\u9FFF]/.test(t))));

    const result = {
      id: animeData.id,
      title: animeData.title,
      episodes: animeData.episodes,
      synonyms: [...allTitles],
      format: animeData.format,
      season: animeData.season,
      seasonYear: animeData.seasonYear,
      duration: animeData.duration,
      studios: animeData.studios?.nodes?.map((s: any) => s.name) || []
    };

    animeInfoCache.set(anilistId, result);
    debugLog(`Fetched anime info for ${result.title.english || result.title.romaji}`);
    return result;
  } catch (error) {
    errorLog('Error fetching anime info:', error);
    return null;
  }
}

const calculateTitleScore = (searchTitle: string, hianimeTitle: string, searchYears: string[] = [], resultYears: string[] = []): number => {
  const normalizedSearch = normalizeText(searchTitle);
  const normalizedTitle = normalizeText(hianimeTitle);

  if (normalizedSearch === normalizedTitle) {
    return 1;
  }

  const distance = levenshteinDistance(normalizedSearch, normalizedTitle);
  if (distance <= 2 && normalizedSearch.length > 5) {
    return 0.95;
  }

  const searchWords = normalizedSearch.split(' ');
  const titleWords = normalizedTitle.split(' ');

  const searchVariations = searchWords.map((w: string) => getWordVariations(w));
  const titleVariations = titleWords.map((w: string) => getWordVariations(w));

  let matches = 0;
  let partialMatches = 0;

  for (let i = 0; i < searchVariations.length; i++) {
    let bestWordMatch = 0;

    for (let j = 0; j < titleVariations.length; j++) {
      for (const searchVar of searchVariations[i]) {
        for (const titleVar of titleVariations[j]) {
          if (searchVar === titleVar) {
            bestWordMatch = 1;
            break;
          }

          if (searchVar.includes(titleVar) || titleVar.includes(searchVar)) {
            const matchLength = Math.min(searchVar.length, titleVar.length);
            const maxLength = Math.max(searchVar.length, titleVar.length);
            bestWordMatch = Math.max(bestWordMatch, matchLength / maxLength);
          }
        }
        if (bestWordMatch === 1) break;
      }
      if (bestWordMatch === 1) break;
    }

    if (bestWordMatch === 1) {
      matches++;
    } else if (bestWordMatch > 0) {
      partialMatches += bestWordMatch;
    }
  }

  const wordMatchScore = (matches + (partialMatches * 0.5)) / searchWords.length;
  const similarity = stringSimilarity.stringSimilarity(normalizedSearch, normalizedTitle);

  return (wordMatchScore * 0.7) + (similarity * 0.3);
};

async function searchAnime(title: string, animeInfo: any) {
  const cacheKey = `${title}_${animeInfo.id}`;
  if (searchCache.has(cacheKey)) {
    debugLog(`Cache hit for search: ${title}`);
    return searchCache.get(cacheKey);
  }

  try {
    let bestMatch: { score: number; id: string | null; method: string } = { score: 0, id: null, method: 'none' };
    let seriesMatches: Array<{
      title: string;
      id: string;
      score: number;
      isMovie: boolean;
      isTV: boolean;
      isOVA: boolean;
      isSpecial: boolean;
      episodes: number;
      duration: number | null;
      jname: string | undefined;
      years: string[];
      seasonNum: number | null;
    }> = [];

    const titleYears = extractYears(title);
    if (animeInfo.seasonYear) titleYears.push(animeInfo.seasonYear.toString());

    const searchSeasonNum = extractSeasonNumber(title);

    const titlesToTry = [
      animeInfo.title.english,
      animeInfo.title.romaji,
      ...animeInfo.synonyms
    ].filter(Boolean)
     .filter((t, i, arr) => arr.indexOf(t) === i);

    debugLog(`Searching for: ${title} (${titlesToTry.length} variations)`);

    for (const searchTitle of titlesToTry) {

      const duplicatedQuery = `${searchTitle} ${searchTitle}`;
      const searchUrl = `${HIANIME_URL}/search?keyword=${encodeURIComponent(duplicatedQuery)}`;

      const response = await fetchWithRetry(() => client.get(searchUrl));
      const $ = load(response.data);

      $('.film_list-wrap > .flw-item').each((_, item) => {
        const el = $(item).find('.film-detail .film-name a');
        const hianimeTitle = el.text().trim();
        const hianimeId = el.attr('href')?.split('/').pop()?.split('?')[0];
        const jname = el.attr('data-jname')?.trim();

        if (!hianimeId) return;

        const normalizedHianime = normalizeText(hianimeTitle);
        const normalizedSearch = normalizeText(searchTitle);
        const searchWords = normalizedSearch.split(' ');
        const hianimeWords = normalizedHianime.split(' ');

        if (searchWords.length === 1 && hianimeWords.length > 1) {
          const searchWord = searchWords[0];

          const hasExactWordMatch = hianimeWords.some(word => word === searchWord);
          const isOnlySubstring = !hasExactWordMatch && normalizedHianime.includes(searchWord);

          if (isOnlySubstring || (hasExactWordMatch && hianimeWords.length > searchWords.length + 2)) {
            debugLog(`Filtering out potential false positive: "${hianimeTitle}" for search "${searchTitle}"`);
            return;
          }
        }

        const formatText = $(item).find('.fd-infor .fdi-item').first().text().trim();
        const isTV = formatText === 'TV';
        const isMovie = formatText === 'Movie';
        const isOVA = formatText === 'OVA';
        const isSpecial = formatText === 'Special';

        const episodesText = $(item).find('.tick-item.tick-eps').text().trim();
        const episodesCount = episodesText ? parseInt(episodesText, 10) : 0;

        const durationText = $(item).find('.tick-item.tick-dur').text().trim();
        const duration = parseDuration(durationText);

        const resultYears = extractYears(hianimeTitle, jname);
        const resultSeasonNum = extractSeasonNumber(hianimeTitle);

        let score = calculateTitleScore(searchTitle, hianimeTitle, titleYears, resultYears);

        const searchWordCount = normalizeText(searchTitle).split(' ').length;
        const resultWordCount = normalizeText(hianimeTitle).split(' ').length;

        if (searchWordCount === 1 && resultWordCount > 1) {

          const significantWords = ['strike', 'wars', 'hunters', 'slayer', 'quest'];
          const hasSignificantExtras = significantWords.some((word: string) =>
            normalizeText(hianimeTitle).includes(word)
          );

          if (hasSignificantExtras) {
            score *= 0.5;
            debugLog(`Penalizing compound title: "${hianimeTitle}" (score reduced to ${score.toFixed(3)})`);
          }
        }

        if (animeInfo.format === 'TV' && isTV) {
          score += 0.15;
        }
        if (animeInfo.format === 'MOVIE' && isMovie) {
          score += 0.15;
        }
        if (animeInfo.format === 'OVA' && isOVA) {
          score += 0.1;
        }
        if (animeInfo.format === 'SPECIAL' && isSpecial) {
          score += 0.1;
        }

        if (animeInfo.episodes && episodesCount === animeInfo.episodes) {
          score += 0.2;
        } else if (animeInfo.episodes && Math.abs(episodesCount - animeInfo.episodes) <= 2) {
          score += 0.1;
        }

        if (titleYears.length > 0 && resultYears.length > 0) {
          if (titleYears.some(y => resultYears.includes(y))) {
            score += 0.25;
          } else {

            score -= 0.3;
          }
        }

        if (searchSeasonNum && resultSeasonNum) {
          if (searchSeasonNum === resultSeasonNum) {
            score += 0.2;
          } else {

            score -= 0.4;
          }
        }

        if (animeInfo.format === 'MOVIE' && animeInfo.duration && duration) {
          const durationDiff = Math.abs(animeInfo.duration - duration);
          if (durationDiff < 10) {
            score += 0.2;
          } else if (durationDiff > 30) {
            score -= 0.15;
          }
        }

        if (isMovie && animeInfo.format === 'TV' && animeInfo.episodes > 1) {
          score -= 0.3;
        }

        if (isTV && animeInfo.format === 'MOVIE') {
          score -= 0.3;
        }

        if (isTV && animeInfo.episodes > 24 && episodesCount > 24) {
          score += 0.1;
        }

        debugLog(`Match candidate: ${hianimeTitle} | Score: ${score.toFixed(3)} | Format: ${formatText} | Episodes: ${episodesCount}`);

        if (score > 0.5) {
          seriesMatches.push({
            title: hianimeTitle,
            id: hianimeId,
            score,
            isMovie,
            isTV,
            isOVA,
            isSpecial,
            episodes: episodesCount,
            duration,
            jname,
            years: resultYears,
            seasonNum: resultSeasonNum
          });
        }

        if (score > bestMatch.score) {
          bestMatch = {
          score,
          id: hianimeId as string,
          method: 'title_match'
          };
        }
      });

      if (bestMatch.score > 0.9) {
        debugLog(`Excellent match found with score ${bestMatch.score}`);
        break;
      }
    }

    if (seriesMatches.length > 0) {
      seriesMatches.sort((a, b) => b.score - a.score);

      const exactTitleMatches = seriesMatches.filter(m => {
        const normalizedMatch = normalizeText(m.title);
        const normalizedSearch = normalizeText(title);
        return normalizedMatch === normalizedSearch ||
               titlesToTry.some(t => normalizeText(t) === normalizedMatch);
      });

      if (exactTitleMatches.length > 0) {
        const best = exactTitleMatches[0];
        debugLog(`Selected by exact title match: ${best.title}`);
        bestMatch = { score: best.score, id: best.id, method: 'exact_title_match' };
      }

      else {
        const exactMatches = seriesMatches.filter(m =>
          m.episodes === animeInfo.episodes &&
          ((animeInfo.format === 'TV' && m.isTV) ||
           (animeInfo.format === 'MOVIE' && m.isMovie) ||
           (animeInfo.format === 'OVA' && m.isOVA))
        );

      if (exactMatches.length > 0) {
        const best = exactMatches[0];
        debugLog(`Selected by exact episode+format match: ${best.title}`);
        bestMatch = { score: best.score, id: best.id, method: 'exact_match' };
      }

      else if (titleYears.length > 0) {
        const yearMatches = seriesMatches.filter(m =>
          m.years.some(y => titleYears.includes(y))
        );

        if (yearMatches.length > 0) {
          const best = yearMatches[0];
          debugLog(`Selected by year match: ${best.title} (${best.years.join(', ')})`);
          bestMatch = { score: best.score, id: best.id, method: 'year_match' };
        }
      }

      else if (searchSeasonNum) {
        const seasonMatches = seriesMatches.filter(m =>
          m.seasonNum === searchSeasonNum
        );

        if (seasonMatches.length > 0) {
          const best = seasonMatches[0];
          debugLog(`Selected by season number match: ${best.title}`);
          bestMatch = { score: best.score, id: best.id, method: 'season_match' };
        }
      }

      else if (animeInfo.format === 'TV') {
        const tvMatches = seriesMatches.filter(m => m.isTV);
        const topScore = seriesMatches[0].score;

        if (tvMatches.length > 0 && topScore - tvMatches[0].score < 0.2) {
          const best = tvMatches[0];
          debugLog(`Selected by TV format priority: ${best.title}`);
          bestMatch = { score: best.score, id: best.id, method: 'format_priority' };
        }
      }

      if (bestMatch.method === 'none' || (seriesMatches[0] && seriesMatches[0].score > bestMatch.score)) {
        const best = seriesMatches[0];
        debugLog(`Selected by highest score: ${best.title} (${best.score.toFixed(3)})`);
        bestMatch = { score: best.score, id: best.id, method: 'highest_score' };
      }
      }
    }

    if (bestMatch.score < 0.6) {
      debugLog('Low confidence match, trying alternative search');
      const baseTitle = title.replace(/\([^)]*\)/g, '')
                            .replace(/season \d+/gi, '')
                            .replace(/part \d+/gi, '')
                            .trim();

      if (baseTitle !== title && baseTitle.length > 3) {
        const altResult = await searchAnimeAlternative(baseTitle, animeInfo, titleYears, searchSeasonNum);
        if (altResult && altResult.score > bestMatch.score) {
          debugLog(`Better match found via alternative search: ${altResult.score}`);
          bestMatch = altResult;
        }
      }
    }

    const result = bestMatch.score > 0.4 ? bestMatch : { score: 0, id: null, method: 'none' };
    searchCache.set(cacheKey, result);

    debugLog(`Final match: ${result.id || 'none'} | Score: ${result.score.toFixed(3)} | Method: ${result.method}`);
    return result;
  } catch (error) {
    errorLog('Error searching Hianime:', error);
    return { score: 0, id: null, method: 'error' };
  }
}

async function searchAnimeAlternative(baseTitle: string, animeInfo: any, originalYears: string[], originalSeasonNum: number | null): Promise<{ score: number; id: string | null; method: string } | null> {
  try {

    const duplicatedQuery = `${baseTitle} ${baseTitle}`;
    const searchUrl = `${HIANIME_URL}/search?keyword=${encodeURIComponent(duplicatedQuery)}`;
    const response = await fetchWithRetry(() => client.get(searchUrl));
    const $ = load(response.data);

    let bestMatch: { score: number; id: string | null; method: string } = { score: 0, id: null, method: 'alternative' };

    $('.film_list-wrap > .flw-item').each((_, item) => {
      const el = $(item).find('.film-detail .film-name a');
      const hianimeTitle = el.text().trim();
      const hianimeId = el.attr('href')?.split('/').pop()?.split('?')[0];
      const jname = el.attr('data-jname')?.trim();

      if (!hianimeId) return;

      const formatText = $(item).find('.fd-infor .fdi-item').first().text().trim();
      const episodesText = $(item).find('.tick-item.tick-eps').text().trim();
      const episodesCount = episodesText ? parseInt(episodesText, 10) : 0;

      const resultYears = extractYears(hianimeTitle, jname);
      const resultSeasonNum = extractSeasonNumber(hianimeTitle);

      let score = calculateTitleScore(baseTitle, hianimeTitle, originalYears, resultYears);

      if (animeInfo.format === 'TV' && formatText === 'TV') score += 0.15;
      if (animeInfo.episodes && episodesCount === animeInfo.episodes) score += 0.2;
      if (originalYears.length > 0 && resultYears.some(y => originalYears.includes(y))) score += 0.25;
      if (originalSeasonNum && resultSeasonNum === originalSeasonNum) score += 0.2;

      if (score > bestMatch.score) {
        bestMatch = { score, id: hianimeId as string, method: 'alternative' };
      }
    });

    return bestMatch.score > 0.5 ? bestMatch : null;
  } catch (error) {
    debugLog('Error in alternative search:', error);
    return null;
  }
}

async function getEpisodeIds(animeId: string, anilistId: number) {
  try {
    const episodeUrl = `${HIANIME_URL}/ajax/v2/episode/list/${animeId.split('-').pop()}`;
    const anizipUrl = `${ANIZIP_URL}?anilist_id=${anilistId}`;

    const [episodeResponse, anizipResponse] = await Promise.all([
      fetchWithRetry(() =>
        client.get(episodeUrl, {
          headers: {
            'Referer': `${HIANIME_URL}/watch/${animeId}`,
            'X-Requested-With': 'XMLHttpRequest'
          }
        })
      ),
      fetchWithRetry(() => client.get(anizipUrl))
    ]);

    if (!episodeResponse.data.html) {
      return { totalEpisodes: 0, episodes: [] };
    }

    const $ = load(episodeResponse.data.html);
    const episodes: Array<{
      episodeId: string;
      title: any;
      number: number;
      image: any;
      overview: any;
      airDate: any;
      runtime: any;
    }> = [];
    const anizipData = anizipResponse.data;

    const episodeMetadata = new Map<number, any>(
      Object.entries(anizipData?.episodes || {})
        .map(([num, data]) => [parseInt(num), data])
    );

    $('#detail-ss-list div.ss-list a').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href) return;

      const fullPath = href.split('/').pop();
      const episodeNumber = i + 1;
      const anizipEpisode: any = episodeMetadata.get(episodeNumber);

      if (fullPath) {
        episodes.push({
          episodeId: `${animeId}?ep=${fullPath.split('?ep=')[1]}`,
          title: anizipEpisode?.title?.en ||
                 anizipEpisode?.title?.ja ||
                 $el.attr('title') ||
                 `Episode ${episodeNumber}`,
          number: episodeNumber,
          image: anizipEpisode?.image || null,
          overview: anizipEpisode?.overview || null,
          airDate: anizipEpisode?.airDate || null,
          runtime: anizipEpisode?.runtime || null
        });
      }
    });

    debugLog(`Fetched ${episodes.length} episodes for ${animeId}`);

    return {
      totalEpisodes: episodes.length,
      episodes,
      titles: anizipData?.titles || null,
      images: anizipData?.images || null,
      mappings: anizipData?.mappings || null
    };
  } catch (error) {
    errorLog('Error fetching episodes:', error);
    return { totalEpisodes: 0, episodes: [] };
  }
}

export async function getEpisodesForAnime(anilistId: number | string) {

  const id = typeof anilistId === 'string' ? parseInt(anilistId, 10) : anilistId;

  if (!id || isNaN(id) || id <= 0) {
    throw new Error(`Invalid anilistId: received ${anilistId}, must be a positive number`);
  }

  anilistId = id;

  try {
    debugLog(`Starting search for Anilist ID: ${anilistId}`);

    const animeInfo = await getAnimeInfo(anilistId);
    if (!animeInfo) {
      throw new Error('Could not fetch anime info from Anilist');
    }

    const title = animeInfo.title.english || animeInfo.title.romaji;
    if (!title) {
      throw new Error('No English or romaji title found');
    }

    const searchResult = await searchAnime(title, animeInfo);
    if (!searchResult.id) {
      throw new Error('Could not find anime on Hianime');
    }

    const episodes = await getEpisodeIds(searchResult.id, anilistId);
    if (!episodes || episodes.totalEpisodes === 0) {
      throw new Error('Could not fetch episodes');
    }

    debugLog(`Successfully mapped anime: ${title}`);

    return {
      anilistId,
      hianimeId: searchResult.id,
      title,
      matchConfidence: searchResult.score,
      matchMethod: searchResult.method,
      animeInfo: {
        format: animeInfo.format,
        episodes: animeInfo.episodes,
        seasonYear: animeInfo.seasonYear,
        studios: animeInfo.studios
      },
      ...episodes
    };
  } catch (error) {
    errorLog('Error in getEpisodesForAnime:', error);
    throw error;
  }
}

export default {
  getEpisodesForAnime
};
