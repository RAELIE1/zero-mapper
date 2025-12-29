import * as stringSimilarity from 'string-similarity-js';
import { client } from '../utils/client.js';
import { ANILIST_URL } from '../constants/api-constants.js';

// Type Definitions
interface AnilistTitle {
  romaji: string;
  english: string | null;
  native: string;
}

interface AnilistRelation {
  relationType: string;
  node: {
    id: number;
    title: {
      romaji: string;
      english: string | null;
    };
    format: string;
    episodes: number | null;
  };
}

interface AnimeInfo {
  id: number;
  title: AnilistTitle;
  fullTitle: string;
  baseTitle: string;
  episodes: number | null;
  synonyms: string[];
  format: string;
  season: string | null;
  seasonYear: number | null;
  duration: number | null;
  relations: AnilistRelation[];
}

interface SearchResult {
  score: number;
  slug: string | null;
  method: 'none' | 'franchise_mapping' | 'base_title_match' | 'error' | 'direct_slug_fallback';
}

interface SeasonInfo {
  season: number | null;
  part: number | null;
}

interface AnimeSamaSeason {
  name: string;
  seasonSlug: string;
  language: string;
  episodeCount: number;
}

interface SeasonMatchResult {
  seasons: AnimeSamaSeason[];
  bestSeasonMatch: string | null;
}

interface EpisodeResult {
  anilistId: number;
  animesamaSlug: string;
  seasonSlug: string | null;
  title: string;
  baseTitle: string;
  matchConfidence: number;
  matchMethod: string;
  animeInfo: {
    format: string;
    episodes: number | null;
    seasonYear: number | null;
    seasonInfo: SeasonInfo;
  };
  seasons: AnimeSamaSeason[];
  totalSeasons: number;
  catalogueUrl: string;
  episodeUrl: string | null;
}

// Configuration
const DEBUG = process.env.DEBUG === 'true';
const REQUEST_TIMEOUT = 10000;
const MAX_RETRIES = 3;
const ANIMESAMA_URL = 'https://anime-sama.tv';
const ANIMESAMA_SEARCH_URL = 'https://anime-sama.tv/template-php/defaut/fetch.php';

// Caches
const animeInfoCache = new Map<number, AnimeInfo>();
const searchCache = new Map<string, SearchResult>();
const wordVariationsCache = new Map<string, string[]>();



// Title replacements for French context
const TITLE_REPLACEMENTS: Record<string, string[]> = {
  'saison': ['season', 's', 'sz'],
  'season': ['saison', 's', 'sz'],
  's': ['season', 'saison', 'sz'],
  'sz': ['season', 'saison', 's'],
  'film': ['movie'],
  'movie': ['film'],
  'two': ['2', 'ii', 'deux'],
  'three': ['3', 'iii', 'trois'],
  'four': ['4', 'iv', 'quatre'],
  'five': ['5', 'v', 'cinq'],
  'six': ['6', 'vi', 'six'],
  'part': ['partie', 'pt', 'p'],
  'partie': ['part', 'pt', 'p'],
};

const SEQUEL_PATTERNS: Record<string, string[]> = {
  '2ème saison': ['2nd season', 'second season', 's2', 'season 2', 'saison 2', 'ii'],
  '3ème saison': ['3rd season', 'third season', 's3', 'season 3', 'saison 3', 'iii'],
  '4ème saison': ['4th season', 'fourth season', 's4', 'season 4', 'saison 4', 'iv'],
  'partie 2': ['part 2', 'part two', 'p2', 'pt 2'],
  'partie 3': ['part 3', 'part three', 'p3', 'pt 3'],
};

// Logging utilities
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log('[AnimeSama DEBUG]', new Date().toISOString(), ...args);
}

function errorLog(...args: unknown[]): void {
  console.error('[AnimeSama ERROR]', new Date().toISOString(), ...args);
}

// Utility functions
const fetchWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT
): Promise<T> => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
  );
  return Promise.race([promise, timeout]);
};

async function fetchWithRetry<T>(
  fetchFn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchWithTimeout(fetchFn());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Retry ${i + 1}/${maxRetries} failed:`, errorMessage);
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
  throw new Error('Max retries exceeded');
}

// Text normalization - removes year info for base title matching
const normalizeText = (text: string, removeYear: boolean = false): string => {
  let normalized = text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/½/g, '0.5')
    .replace(/×/g, 'x')
    .replace(/['']/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (removeYear) {
    normalized = normalized.replace(/\b(19|20)\d{2}\b/g, '').trim();
  }

  return normalized;
};

// Extract years from titles
const extractYears = (title: string, altTitle: string | null = null): string[] => {
  const years = new Set<string>();
  const titleYear = title?.match(/\((\d{4})\)|(\b(?:19|20)\d{2}\b)/)?.[1] || 
                    title?.match(/(\b(?:19|20)\d{2}\b)/)?.[1];
  if (titleYear) years.add(titleYear);

  const altYear = altTitle?.match(/\((\d{4})\)|(\b(?:19|20)\d{2}\b)/)?.[1] || 
                  altTitle?.match(/(\b(?:19|20)\d{2}\b)/)?.[1];
  if (altYear) years.add(altYear);

  return [...years];
};

// Extract season/part numbers from title
const extractSeasonInfo = (title: string): SeasonInfo => {
  const seasonPatterns = [
    /saison\s*(\d+)/i,
    /season\s*(\d+)/i,
    /\bs(\d+)\b/i,
  ];

  const partPatterns = [
    /part(?:ie)?\s*(\d+)/i,
    /\bp(?:t)?\s*(\d+)\b/i,
    /cour\s*(\d+)/i,
  ];

  let season: number | null = null;
  let part: number | null = null;

  for (const pattern of seasonPatterns) {
    const match = title.match(pattern);
    if (match) {
      season = parseInt(match[1]);
      break;
    }
  }

  for (const pattern of partPatterns) {
    const match = title.match(pattern);
    if (match) {
      part = parseInt(match[1]);
      break;
    }
  }

  return { season, part };
};

// Extract base title (remove sequel markers, subtitles)
function extractBaseTitle(title: string): string {
  let base = title;

  // Remove sequel numbers (II, III, 2nd Season, Season 2, etc.)
  base = base.replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X)$/i, '');
  base = base.replace(/\s+Season\s+\d+/i, '');
  base = base.replace(/\s+\d+(st|nd|rd|th)\s+Season/i, '');
  base = base.replace(/\s+Saison\s+\d+/i, '');
  base = base.replace(/\s+Part\s+\d+/i, '');
  base = base.replace(/\s+Partie\s+\d+/i, '');
  base = base.replace(/\s+Cour\s+\d+/i, '');

  // Remove OVAs/OAVs/Specials from the end
  base = base.replace(/\s+(OVAs?|OAVs?|Specials?)$/i, '');

  // Remove subtitle after colon
  const colonMatch = base.match(/^([^:]+):\s*(.+)$/);
  if (colonMatch) {
    const beforeColon = colonMatch[1].trim();
    const wordCount = beforeColon.split(/\s+/).length;
    if (wordCount >= 2 || /^.+\s+(II|III|IV|Season|Saison|Part)$/i.test(beforeColon)) {
      base = beforeColon;
    }
  }

  // Remove subtitle after dash
  const dashMatch = base.match(/^(.+?)\s*[-—]\s*([A-Z][^-]+)$/);
  if (dashMatch) {
    const beforeDash = dashMatch[1].trim();
    const afterDash = dashMatch[2].trim();
    if (/^[A-Z]/.test(afterDash) && afterDash.split(/\s+/).length >= 2) {
      base = beforeDash;
    }
  }

  // Remove parenthetical info (year, etc.)
  base = base.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

  return base;
}

// Get word variations with caching
const getWordVariations = (word: string): string[] => {
  const cacheKey = word.toLowerCase();
  if (wordVariationsCache.has(cacheKey)) {
    return wordVariationsCache.get(cacheKey)!;
  }

  const variations = new Set<string>([word]);
  const normalized = normalizeText(word);
  variations.add(normalized);

  const withoutNumbers = word.replace(/\d+/g, '').trim();
  if (withoutNumbers !== word) variations.add(withoutNumbers);

  // Check title replacements
  for (const [key, values] of Object.entries(TITLE_REPLACEMENTS)) {
    if (normalized === key) {
      values.forEach(v => variations.add(v));
    } else if (values.includes(normalized)) {
      variations.add(key);
      values.forEach(v => variations.add(v));
    }
  }

  // Check sequel patterns
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

// Enhanced Anilist query - gets relations to find base series
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
      relations {
        edges {
          relationType
          node {
            id
            title {
              romaji
              english
            }
            format
            episodes
          }
        }
      }
    }
  }
`;

// Fetch anime info from Anilist with caching
async function getAnimeInfo(anilistId: number): Promise<AnimeInfo | null> {
  if (animeInfoCache.has(anilistId)) {
    debugLog(`Cache hit for Anilist ID: ${anilistId}`);
    return animeInfoCache.get(anilistId)!;
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

    // Get all possible titles and synonyms (excluding Chinese/Japanese/etc)
    const allTitles = new Set<string>(
      [
        ...(animeData.synonyms || []),
        animeData.title.english,
        animeData.title.romaji
      ]
        .filter(Boolean)
        .filter(t => !(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u0590-\u05FF\u0E00-\u0E7F\u0600-\u06FF\u0400-\u04FF\uAC00-\uD7AF]/.test(t)))
    );

    // Get full title
    const fullTitle = animeData.title.english || animeData.title.romaji;

    // Extract base title using enhanced function
    const baseTitle = extractBaseTitle(fullTitle);

    const result: AnimeInfo = {
      id: animeData.id,
      title: animeData.title,
      fullTitle,
      baseTitle,
      episodes: animeData.episodes,
      synonyms: [...allTitles],
      format: animeData.format,
      season: animeData.season,
      seasonYear: animeData.seasonYear,
      duration: animeData.duration,
      relations: animeData.relations?.edges || [],
    };

    animeInfoCache.set(anilistId, result);
    debugLog(`Fetched anime info for ${result.fullTitle}`);
    debugLog(`  Base title: ${result.baseTitle}`);

    return result;
  } catch (error) {
    errorLog('Error fetching anime info:', error);
    return null;
  }
}

// Helper function for word matching
function calculateWordMatchScore(searchWords: string[], targetWords: string[]): number {
  let matches = 0;
  let partialMatches = 0;

  for (const searchWord of searchWords) {
    const searchVariations = getWordVariations(searchWord);
    let bestMatch = 0;

    for (const targetWord of targetWords) {
      const targetVariations = getWordVariations(targetWord);

      for (const searchVar of searchVariations) {
        for (const targetVar of targetVariations) {
          if (searchVar === targetVar) {
            bestMatch = 1;
            break;
          }
          if (searchVar.includes(targetVar) || targetVar.includes(searchVar)) {
            const matchLength = Math.min(searchVar.length, targetVar.length);
            const maxLength = Math.max(searchVar.length, targetVar.length);
            bestMatch = Math.max(bestMatch, matchLength / maxLength);
          }
        }
        if (bestMatch === 1) break;
      }
      if (bestMatch === 1) break;
    }

    if (bestMatch === 1) {
      matches++;
    } else if (bestMatch > 0) {
      partialMatches += bestMatch;
    }
  }

  return (matches + (partialMatches * 0.5)) / searchWords.length;
}

// Enhanced calculateTitleScore for AnimeSama
const calculateTitleScore = (
  searchTitle: string,
  animesamaTitle: string,
  animesamaSubtitle: string | null,
  searchYears: string[] = [],
  resultYears: string[] = []
): number => {
  // Normalize WITHOUT removing years first
  const normalizedSearch = normalizeText(searchTitle);
  const normalizedTitle = normalizeText(animesamaTitle);

  // Quick exact match check on main title
  if (normalizedSearch === normalizedTitle) {
    return 1;
  }

  // Parse ALL alternative titles from subtitle
  const subtitleTitles = animesamaSubtitle
    ? animesamaSubtitle.split(',').map(t => normalizeText(t.trim()))
    : [];

  // Check each subtitle title for exact match
  for (const subtitleTitle of subtitleTitles) {
    if (normalizedSearch === subtitleTitle) {
      return 0.98;
    }
  }

  // Now try base title matching (without years/seasons)
  const baseSearch = normalizeText(searchTitle, true);
  const baseTitle = normalizeText(animesamaTitle, true);

  if (baseSearch === baseTitle) {
    return 0.95;
  }

  // Check base title against subtitles
  for (const subtitleTitle of subtitleTitles) {
    const baseSubtitle = normalizeText(subtitleTitle, true);
    if (baseSearch === baseSubtitle) {
      return 0.92;
    }
  }

  // Word-based matching
  const searchWords = baseSearch.split(' ');
  const titleWords = baseTitle.split(' ');

  // Calculate best score across main title + all subtitles
  let bestScore = 0;

  // Score against main title
  const titleScore = calculateWordMatchScore(searchWords, titleWords);
  bestScore = Math.max(bestScore, titleScore);

  // Score against each subtitle
  for (const subtitleTitle of subtitleTitles) {
    const subtitleWords = subtitleTitle.split(' ');
    const subtitleScore = calculateWordMatchScore(searchWords, subtitleWords);
    bestScore = Math.max(bestScore, subtitleScore);
  }

  // String similarity as fallback
  const titleSimilarity = stringSimilarity.stringSimilarity(baseSearch, baseTitle);
  let maxSubtitleSimilarity = 0;

  for (const subtitleTitle of subtitleTitles) {
    const similarity = stringSimilarity.stringSimilarity(baseSearch, subtitleTitle);
    maxSubtitleSimilarity = Math.max(maxSubtitleSimilarity, similarity);
  }

  const similarity = Math.max(titleSimilarity, maxSubtitleSimilarity);

  return (bestScore * 0.7) + (similarity * 0.3);
};

/**
 * Generate AnimeSama slug from title
 * AnimeSama uses lowercase, hyphenated slugs
 * Example: "The Quintessential Quintuplets" -> "the-quintessential-quintuplets"
 * Example: "Fate/Zero" -> "fate-zero"
 * Example: "Re:Zero" -> "re-zero" or "rezero"
 */
function generateAnimeSamaSlug(title: string): string {
  return title
    .toLowerCase()
    // Remove special characters
    .replace(/[∬∽★☆＊※]/g, '')
    // Replace & with and
    .replace(/&/g, 'and')
    // Remove apostrophes
    .replace(/['']/g, '')
    // CRITICAL: Replace / and : with hyphens (for "Fate/Zero", "Re:Zero")
    .replace(/[\/\:]/g, '-')
    // Replace spaces and special chars with hyphens
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    // Remove multiple consecutive hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    .trim();
}

/**
 * Generate multiple slug variations for better matching
 * Returns an array of possible slugs to try
 */
function generateSlugVariations(title: string): string[] {
  const slugs = new Set<string>();
  
  // Main slug with / and : converted to hyphens
  slugs.add(generateAnimeSamaSlug(title));
  
  // For titles with special chars like "Fate/Zero" or "Re:Zero"
  if (title.includes('/') || title.includes(':')) {
    // Try removing the special char entirely: "fatezero", "rezero"
    const compact = title
      .toLowerCase()
      .replace(/[\/:]/g, '') // Remove entirely
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .trim();
    
    if (compact) slugs.add(compact);
    
    // CRITICAL: For franchise pages, try just the base name before the special char
    // "Fate/Zero" -> "fate", "Re:Zero" -> "re"
    const beforeSpecialChar = title.split(/[\/:]/)[ 0].trim();
    if (beforeSpecialChar && beforeSpecialChar.length > 1) {
      const baseSlug = generateAnimeSamaSlug(beforeSpecialChar);
      if (baseSlug) slugs.add(baseSlug);
    }
  }
  
  return [...slugs];
}

/**
 * Try direct URL access when search fails
 * Returns the slug if the anime page exists, null otherwise
 */
async function tryDirectSlugAccess(titles: string[]): Promise<string | null> {
  console.log('[DEBUG] Attempting direct slug access as fallback...');
  
  for (const title of titles) {
    const slugVariations = generateSlugVariations(title);
    
    for (const slug of slugVariations) {
      console.log(`[DEBUG] Trying direct access with slug: ${slug}`);
      
      try {
        // Try accessing the catalogue page directly
        const response = await fetchWithRetry(() =>
          client.get(`${ANIMESAMA_URL}/catalogue/${slug}/`, {
            headers: {
              'Referer': `${ANIMESAMA_URL}/catalogue/`,
              'Accept': 'text/html',
            },
            validateStatus: (status: number) => status === 200 || status === 404,
          })
        );
        
        // If we get a 200 response and the page contains panneauAnime, it's valid
        if (response.status === 200 && response.data.includes('panneauAnime')) {
          console.log(`[DEBUG] ✓ Direct access successful! Found anime at slug: ${slug}`);
          return slug;
        }
      } catch (error) {
        console.log(`[DEBUG] Direct access failed for slug: ${slug}`);
      }
    }
  }
  
  return null;
}

// Generate compact title variations
function generateCompactVariations(title: string): string[] {
  const variations = new Set<string>();

  if (DEBUG) console.log(`[DEBUG] generateCompactVariations input: "${title}"`);

  // Pattern 1: "Word:Word" -> "WordWord"
  const colonPattern = /^([A-Za-z0-9]+):([A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*)/;
  const colonMatch = title.match(colonPattern);

  if (colonMatch) {
    const part1 = colonMatch[1];
    const part2 = colonMatch[2].replace(/\s+/g, '');
    const compact = part1 + part2;

    if (DEBUG) console.log(`[DEBUG]   Colon pattern match: ${part1} + ${part2} = ${compact}`);

    variations.add(compact);

    const normalized = compact.charAt(0).toUpperCase() + compact.slice(1).toLowerCase();
    if (normalized !== compact) {
      variations.add(normalized);
    }

    const withSpace = part1 + ' ' + part2;
    if (withSpace !== title) {
      variations.add(withSpace);
    }
  }

  // Pattern 2: Extract part before dash
  const dashMatch = title.match(/^(.+?)\s*[-‐‑‒–—―−]\s*(.+)$/);
  if (dashMatch) {
    const beforeDash = dashMatch[1].trim();

    if (DEBUG) console.log(`[DEBUG]   Dash match, beforeDash: "${beforeDash}"`);

    if (beforeDash && beforeDash.length > 2) {
      variations.add(beforeDash);

      const beforeDashColonMatch = beforeDash.match(colonPattern);
      if (beforeDashColonMatch) {
        const part1 = beforeDashColonMatch[1];
        const part2 = beforeDashColonMatch[2].replace(/\s+/g, '');
        const compact = part1 + part2;

        if (DEBUG) console.log(`[DEBUG]   Colon in beforeDash: ${part1} + ${part2} = ${compact}`);

        variations.add(compact);

        const normalized = compact.charAt(0).toUpperCase() + compact.slice(1).toLowerCase();
        if (normalized !== compact) {
          variations.add(normalized);
        }

        const withSpace = part1 + ' ' + part2;
        if (withSpace !== beforeDash) {
          variations.add(withSpace);
        }
      }

      const compactBefore = beforeDash
        .replace(/[×x]/gi, '')
        .replace(/[-–—:]/g, '')
        .replace(/\s+/g, '')
        .trim();

      if (compactBefore && compactBefore.length > 2) {
        if (DEBUG) console.log(`[DEBUG]   Compact version: "${compactBefore}"`);
        variations.add(compactBefore);
      }
    }
  }

  const filtered = [...variations].filter(v => v.length >= 3);
  if (DEBUG) console.log(`[DEBUG]   Generated variations:`, filtered);

  return filtered;
}

// Search anime on AnimeSama using BASE title
async function searchAnime(baseTitle: string, animeInfo: AnimeInfo): Promise<SearchResult> {
  const cacheKey = `${baseTitle}_${animeInfo.id}`;

  if (searchCache.has(cacheKey)) {
    console.log(`[DEBUG] Cache hit for search: ${baseTitle}`);
    return searchCache.get(cacheKey)!;
  }

  try {
    let bestMatch: SearchResult = {
      score: 0,
      slug: null,
      method: 'none'
    };



    // Generate comprehensive list of titles to search
    const searchTitlesSet = new Set<string>();

    // 1. Base title
    searchTitlesSet.add(baseTitle);

    // 2. Full title
    searchTitlesSet.add(animeInfo.fullTitle);

    // 3. All synonyms
    for (const synonym of animeInfo.synonyms) {
      searchTitlesSet.add(synonym);
      searchTitlesSet.add(extractBaseTitle(synonym));
    }

    // 4. Simplified versions
    for (const title of [...searchTitlesSet]) {
      const simplified = title
        .replace(/[×x]/gi, ' ')
        .replace(/[-–—]/g, ' ')
        .replace(/:/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (simplified !== title) {
        searchTitlesSet.add(simplified);
      }
    }

    // 5. Generate compact variations
    const allTitlesToCompact = [...searchTitlesSet];
    for (const title of allTitlesToCompact) {
      const compactVars = generateCompactVariations(title);
      compactVars.forEach(v => searchTitlesSet.add(v));
    }

    const searchTitles = [...searchTitlesSet].filter(Boolean);

    console.log(`[DEBUG] Searching for: ${baseTitle} (${searchTitles.length} variations)`);
    console.log(`[DEBUG] Base titles to try:`, searchTitles);

    for (const searchTitle of searchTitles) {
      const formData = new URLSearchParams();
      formData.append('query', searchTitle);

      const response = await fetchWithRetry(() =>
        client.post(ANIMESAMA_SEARCH_URL, formData.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${ANIMESAMA_URL}/catalogue/`,
            'Origin': ANIMESAMA_URL,
            'Accept': '*/*',
          }
        })
      );

      const html = response.data;

      if (!html || html.trim().length === 0) {
        console.log(`[DEBUG] No results for: ${searchTitle}`);
        continue;
      }

      console.log(`[DEBUG] Got search results for: ${searchTitle}`);
      console.log(`[DEBUG] HTML length: ${html.length}`);
      if (html.length < 1000) console.log(`[DEBUG] HTML content:`, html);

      console.log(`[DEBUG] Trying to match with regex...`);

      // Updated regex to handle the actual HTML structure with div wrappers and whitespace
      const animeRegex = /<a\s+href="https:\/\/anime-sama\.(?:tv|si)\/catalogue\/([^\/"]+)\/?"[^>]*class="asn-search-result"[^>]*>([\s\S]*?)<\/a>/g;
      
      let match;
      let matchCount = 0;

      while ((match = animeRegex.exec(html)) !== null) {
        matchCount++;
        const slug = match[1];
        const content = match[2];
        
        // Extract title from h3
        const titleMatch = content.match(/<h3[^>]*class="asn-search-result-title"[^>]*>([^<]+)<\/h3>/);
        if (!titleMatch) continue;
        const animesamaTitle = titleMatch[1].trim();
        
        // Extract subtitle from p (optional)
        const subtitleMatch = content.match(/<p[^>]*class="asn-search-result-subtitle"[^>]*>([^<]+)<\/p>/);
        const animesamaSubtitle = subtitleMatch ? subtitleMatch[1].trim() : null;
        
        console.log(`[DEBUG] Regex match ${matchCount}:`, { 
          slug, 
          title: animesamaTitle, 
          subtitle: animesamaSubtitle 
        });

        console.log(`[DEBUG] Found: ${animesamaTitle}${animesamaSubtitle ? ` (${animesamaSubtitle})` : ''} -> ${slug}`);

        const score = calculateTitleScore(
          searchTitle,
          animesamaTitle,
          animesamaSubtitle,
          [],
          []
        );

        console.log(`[DEBUG] Match: ${animesamaTitle} | Score: ${score.toFixed(3)}`);

        if (score > bestMatch.score) {
          bestMatch = {
            score,
            slug,
            method: 'base_title_match'
          };
        }
      }

      // Stop if we found an excellent match
      if (bestMatch.score > 0.85) {
        console.log(`[DEBUG] Excellent match found with score ${bestMatch.score}`);
        break;
      }
    }

    // FALLBACK: If search returns no results, try direct slug access
    if (bestMatch.score === 0 || bestMatch.slug === null) {
      console.log('[DEBUG] Search returned no results, trying direct slug fallback...');
      
      const titlesToTry = [
        animeInfo.fullTitle,
        baseTitle,
        ...animeInfo.synonyms.slice(0, 30), // Try first 10 synonyms (increased from 5)
      ].filter(Boolean);
      
      const directSlug = await tryDirectSlugAccess(titlesToTry);
      
      if (directSlug) {
        const result = {
          score: 0.85,
          slug: directSlug,
          method: 'direct_slug_fallback' as const
        };
        searchCache.set(cacheKey, result);
        console.log(`[DEBUG] Direct slug fallback successful: ${directSlug}`);
        return result;
      }
    }


    const threshold = (animeInfo.format === 'OVA' || animeInfo.format === 'SPECIAL') ? 0.2 : 0.3;

    const result = bestMatch.score > threshold ? bestMatch : { 
      score: 0, 
      slug: null, 
      method: 'none' as const 
    };

    searchCache.set(cacheKey, result);

    console.log(`[DEBUG] Final match: ${result.slug || 'none'} | Score: ${result.score.toFixed(3)} | Threshold: ${threshold}`);

    return result;
  } catch (error) {
    errorLog('Error searching AnimeSama:', error);
    return { score: 0, slug: null, method: 'error' };
  }
}

// Get available seasons from AnimeSama
async function getAvailableSeasonsWithMatch(
  slug: string,
  targetEpisodes: number,
  seasonInfo: SeasonInfo,
  fullTitle: string
): Promise<SeasonMatchResult> {
  try {
    const catalogueUrl = `${ANIMESAMA_URL}/catalogue/${slug}/`;

    const response = await fetchWithRetry(() =>
      client.get(catalogueUrl, {
        headers: {
          'Referer': `${ANIMESAMA_URL}/catalogue/`,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      })
    );

    const html = response.data;
    const seasons: AnimeSamaSeason[] = [];

    // Extract all panneauAnime calls
    const animeRegex = /panneauAnime\("([^"]+)",\s*"([^"]+)"\)/g;
    let match;

    while ((match = animeRegex.exec(html)) !== null) {
      const name = match[1];
      const relativeUrl = match[2];

      // Parse the URL to extract season and language
      const urlMatch = relativeUrl.match(/^([^/]+)\/([^/]+)\/?$/);
      if (urlMatch) {
        const seasonSlug = urlMatch[1];
        const language = urlMatch[2];

        // Get episode count for this season
        const episodeCount = await getEpisodeCount(slug, seasonSlug, language);

        if (episodeCount > 0) {
          seasons.push({
            name,
            seasonSlug,
            language: language.toUpperCase(),
            episodeCount
          });
        }
      }
    }

    console.log(`[DEBUG] Found ${seasons.length} seasons on AnimeSama`);
    seasons.forEach(s => 
      console.log(`[DEBUG]   - ${s.name} (${s.seasonSlug}/${s.language}): ${s.episodeCount} eps`)
    );

    // Find best matching season
    const bestSeasonMatch = findBestSeason(seasons, targetEpisodes, seasonInfo, fullTitle);

    console.log(`[DEBUG] Best season match: ${bestSeasonMatch || 'none'}`);

    return { seasons, bestSeasonMatch };
  } catch (error) {
    errorLog('Error fetching available seasons:', error);
    return { seasons: [], bestSeasonMatch: null };
  }
}

// Improved season matching logic
function findBestSeason(
  seasons: AnimeSamaSeason[],
  targetEpisodes: number,
  seasonInfo: SeasonInfo,
  fullTitle: string
): string | null {
  if (seasons.length === 0) return null;

  // Filter out OVAs, Films, and Kai versions for initial matching
  const mainSeasons = targetEpisodes && targetEpisodes > 5
    ? seasons.filter(s =>
        !s.seasonSlug.includes('film') &&
        !s.seasonSlug.includes('oav') &&
        !s.seasonSlug.includes('kai')
      )
    : seasons;

  const seasonsToSearch = mainSeasons.length > 0 ? mainSeasons : seasons;

  // Priority 1: Match by season and part numbers from title
  if (seasonInfo.season !== null) {
    // Try exact match with part
    if (seasonInfo.part !== null) {
      const exactMatch = seasonsToSearch.find(s => {
        const match = s.seasonSlug.match(/saison(\d+)(?:-(\d+))?/);
        if (!match) return false;

        const slugSeason = parseInt(match[1]);
        const slugPart = match[2] ? parseInt(match[2]) : null;

        return slugSeason === seasonInfo.season && slugPart === seasonInfo.part;
      });

      if (exactMatch) {
        console.log(`[DEBUG] Found exact season+part match: ${exactMatch.seasonSlug}`);
        return exactMatch.seasonSlug;
      }
    }

    // Try season match without part
    const seasonMatch = seasonsToSearch.find(s => {
      const match = s.seasonSlug.match(/saison(\d+)(?:-(\d+))?/);
      if (!match) return false;

      const slugSeason = parseInt(match[1]);
      const slugPart = match[2] ? parseInt(match[2]) : null;

      return slugSeason === seasonInfo.season && !slugPart;
    });

    if (seasonMatch) {
      console.log(`[DEBUG] Found season match: ${seasonMatch.seasonSlug}`);
      return seasonMatch.seasonSlug;
    }
  }

  // Priority 2: Match by part number only
  if (seasonInfo.part !== null && seasonInfo.season === null) {
    const partMatch = seasonsToSearch.find(s => {
      const match = s.seasonSlug.match(/saison(\d+)-(\d+)/);
      if (!match) return false;

      const slugPart = parseInt(match[2]);
      return slugPart === seasonInfo.part;
    });

    if (partMatch) {
      console.log(`[DEBUG] Found part match: ${partMatch.seasonSlug}`);
      return partMatch.seasonSlug;
    }
  }

  // Priority 3: Title-based matching for sequels
  const titleMatch = fullTitle.match(/\b(II|III|IV|V|VI|2|3|4|5|6)\b/i);
  if (titleMatch) {
    const romanToNumber: Record<string, number> = {
      'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6,
      '2': 2, '3': 3, '4': 4, '5': 5, '6': 6
    };

    const expectedSeason = romanToNumber[titleMatch[1].toUpperCase()];

    if (expectedSeason) {
      const titleSeasonMatch = seasonsToSearch.find(s => {
        const match = s.seasonSlug.match(/saison(\d+)(?:-(\d+))?/);
        if (!match) return false;
        return parseInt(match[1]) === expectedSeason;
      });

      if (titleSeasonMatch) {
        console.log(`[DEBUG] Found title-based season match: ${titleSeasonMatch.seasonSlug}`);
        return titleSeasonMatch.seasonSlug;
      }
    }
  }

  // Priority 4: Episode count matching
  if (targetEpisodes) {
    // Find exact match
    const exactEpisodeMatch = seasonsToSearch.find(
      s => s.episodeCount === targetEpisodes
    );

    if (exactEpisodeMatch) {
      console.log(`[DEBUG] Found exact episode count match: ${exactEpisodeMatch.seasonSlug}`);
      return exactEpisodeMatch.seasonSlug;
    }

    // Find closest match (within 3 episodes difference)
    let closestMatch: AnimeSamaSeason | null = null;
    let smallestDiff = 3;

    for (const season of seasonsToSearch) {
      const diff = Math.abs(season.episodeCount - targetEpisodes);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        closestMatch = season;
      }
    }

    if (closestMatch) {
      console.log(`[DEBUG] Found close episode count match: ${closestMatch.seasonSlug} (diff: ${smallestDiff})`);
      return closestMatch.seasonSlug;
    }
  }

  // Priority 5: Default to first main season
  console.log(`[DEBUG] Defaulting to first available season: ${seasonsToSearch[0].seasonSlug}`);
  return seasonsToSearch[0].seasonSlug;
}

// Get episode count from episodes.js
async function getEpisodeCount(
  slug: string,
  season: string,
  language: string
): Promise<number> {
  try {
    const episodesUrl = `${ANIMESAMA_URL}/catalogue/${slug}/${season}/${language}/`;

    const pageResponse = await fetchWithRetry(() =>
      client.get(episodesUrl, {
        headers: {
          'Referer': `${ANIMESAMA_URL}/catalogue/${slug}/`,
        }
      })
    );

    const episodesJsMatch = pageResponse.data.match(/src\s*=\s*['"]([^'"]*episodes\.js[^'">\s]*)/);

    if (!episodesJsMatch) {
      debugLog(`No episodes.js found for ${season}/${language}`);
      return 0;
    }

    const episodesJsUrl = new URL(episodesJsMatch[1], episodesUrl).href;

    const jsResponse = await fetchWithRetry(() =>
      client.get(episodesJsUrl, {
        headers: {
          'Referer': episodesUrl,
          'Accept': '*/*',
        }
      })
    );

    const episodesJs = jsResponse.data;

    // Count episodes from any eps variable
    const epsRegex = /var eps\d+\s*=\s*\[([\s\S]*?)\];/g;
    let maxEpisodes = 0;
    let match;

    while ((match = epsRegex.exec(episodesJs)) !== null) {
      const urlsString = match[1];
      const urls = urlsString
        .split(',')
        .map(u => u.trim().replace(/^['"]|['"]$/g, ''))
        .filter(u => u.length > 0);

      maxEpisodes = Math.max(maxEpisodes, urls.length);
    }

    return maxEpisodes;
  } catch (error) {
    debugLog(`Error counting episodes for ${season}/${language}:`, error);
    return 0;
  }
}

// Main function
export async function getEpisodesForAnime(
  anilistId: string | number
): Promise<EpisodeResult> {
  // Input validation
  const id = typeof anilistId === 'string' ? parseInt(anilistId, 10) : anilistId;

  if (!id || isNaN(id) || id <= 0) {
    throw new Error(`Invalid anilistId: received ${anilistId}, must be a positive number`);
  }

  try {
    console.log(`[DEBUG] Starting search for Anilist ID: ${id}`);

    const animeInfo = await getAnimeInfo(id);

    if (!animeInfo) {
      throw new Error('Could not fetch anime info from Anilist');
    }

    const fullTitle = animeInfo.fullTitle;
    console.log(`[DEBUG] Full title: ${fullTitle}`);
    console.log(`[DEBUG] Base title: ${animeInfo.baseTitle}`);
    console.log(`[DEBUG] Episodes: ${animeInfo.episodes}`);

    // Extract season info from title
    const seasonInfo = extractSeasonInfo(fullTitle);
    console.log(`[DEBUG] Season info:`, seasonInfo);

    // Search using base title
    const searchResult = await searchAnime(animeInfo.baseTitle, animeInfo);

    if (!searchResult.slug) {
      throw new Error('Could not find anime on AnimeSama');
    }

    // Get seasons and find best match
    const { seasons, bestSeasonMatch } = await getAvailableSeasonsWithMatch(
      searchResult.slug,
      animeInfo.episodes || 0,
      seasonInfo,
      fullTitle
    );

    console.log(`[DEBUG] Successfully mapped anime: ${fullTitle}`);

    return {
      anilistId: id,
      animesamaSlug: searchResult.slug,
      seasonSlug: bestSeasonMatch,
      title: fullTitle,
      baseTitle: animeInfo.baseTitle,
      matchConfidence: searchResult.score,
      matchMethod: searchResult.method,
      animeInfo: {
        format: animeInfo.format,
        episodes: animeInfo.episodes,
        seasonYear: animeInfo.seasonYear,
        seasonInfo,
      },
      seasons: seasons,
      totalSeasons: seasons.length,
      catalogueUrl: `${ANIMESAMA_URL}/catalogue/${searchResult.slug}/`,
      episodeUrl: bestSeasonMatch
        ? `${ANIMESAMA_URL}/catalogue/${searchResult.slug}/${bestSeasonMatch}/vostfr/`
        : null,
    };
  } catch (error) {
    errorLog('Error in getEpisodesForAnime:', error);
    throw error;
  }
}

export default {
  getEpisodesForAnime
};