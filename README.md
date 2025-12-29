# Zero Mapper - Anime Mapping & Streaming API

A comprehensive Express API for mapping anime across multiple databases (AniList, MyAnimeList, TMDB) and fetching streaming sources from various anime providers.

> **Based on**: This project is built upon and extends [shafat-96/anime-mapper](https://github.com/shafat-96/anime-mapper), adding TMDB integration, MAL mapping, AnimeSama support, enhanced season detection, and a unified cross-platform mapping endpoint.

## What's New vs Original anime-mapper

This fork significantly extends the original anime-mapper with:

### Additional Database Support
- **TMDB Integration** - Map to The Movie Database with automatic season detection
- **MyAnimeList (MAL)** - Full MAL API integration with fuzzy matching
- **Unified `/map` Endpoint** - Single API call returns all database + provider IDs

### Enhanced Streaming Providers
- **AnimeSama** - French anime support (VOSTFR/VF) with multi-server video extraction
- **Improved HiAnime** - Server selection and category filtering (sub/dub/raw)
- **Enhanced AnimeKai** - Better episode detection and source extraction

### Advanced Matching Features
- **Split-Cour Detection** - Identifies multi-part seasons (Part 1/Part 2)
- **Smart Season Matching** - Uses air date, episode count, and description analysis
- **Title Normalization** - Handles OVA suffixes, sequel indicators, and French variations
- **Episode Count Validation** - Cross-validates episodes across all providers

### Performance & Caching
- **Intelligent Caching** - 5-15 minute cache with automatic expiry
- **Parallel Fetching** - Simultaneous provider requests for faster responses
- **TypeScript** - Full TypeScript implementation for type safety

### Bug Fixes & Improvements
- **Fixed AnimePahe Sources** - Resolved broken source extraction and episode fetching
- **Fixed AnimeKai Sources** - Repaired video source extraction with proper server handling
- **Fixed HiAnime Endpoints** - Corrected server selection and episode ID parsing
- **Improved Error Handling** - Better error messages and fallback mechanisms
- **Enhanced Video Extraction** - Fixed Kwik extractor and added multiple quality options
- **Circular Dependency Fix** - Resolved AnimeSama mapping infinite loop
- **URL Normalization** - Proper handling of provider URLs and slugs

#### Known Issues in Original anime-mapper (Now Fixed)
The original anime-mapper had several non-functional endpoints:
- `/animepahe/sources/:session/:episodeId` - Would fail to extract video sources
- `/animekai/sources/:episodeId` - Server extraction broken, sources unavailable
- `/hianime/sources/:animeId` - Episode ID parsing issues causing failures

All these endpoints have been **completely rebuilt and tested** in Zero Mapper.

### Quick Comparison

| Feature | Original anime-mapper | Zero Mapper |
|---------|----------------------|-------------|
| **Databases** | AniList only | AniList + MAL + TMDB |
| **Providers** | AnimePahe, HiAnime, AnimeKai | AnimePahe, HiAnime, AnimeKai, AnimeSama |
| **Unified Mapping** | Separate endpoints | Single `/map` endpoint |
| **Season Detection** | Basic year matching | Advanced (date + episodes + description) |
| **Split-Cour Detection** | Not supported | Automatic detection |
| **French Anime** | Not supported | AnimeSama integration |
| **TypeScript** | JavaScript only | Full TypeScript |
| **Caching** | Basic node-cache | Intelligent multi-tier caching |
| **Episode Validation** | No validation | Cross-provider validation |
| **AnimePahe Sources** | Broken/unreliable | Fixed and stable |
| **AnimeKai Sources** | Not working | Fixed with server selection |
| **HiAnime Endpoints** | Partial issues | Fully functional |

## Features

### Mapping & Cross-Referencing
- Map anime by AniList ID, MAL ID, or TMDB ID
- Cross-reference anime by title across all three platforms
- Intelligent matching algorithm with fuzzy title matching
- Split-cour detection for multi-part seasons
- Season detection for TMDB TV shows

### Streaming Sources
- **AnimePahe** - Episodes, sources, and HLS streaming with multiple quality options
- **HiAnime** - Episodes, sources, server information, and multi-server support
- **AnimeKai** - Episodes and streaming sources with sub/dub availability
- **AnimeSama** - French anime (VOSTFR/VF) with season information and multiple server types

### Unified `/map` Endpoint
- Single API call returns IDs from all 4 streaming providers plus database mappings
- Eliminates need for multiple sequential API requests
- Includes episode counts for cross-provider comparison

### Performance
- In-memory caching for faster responses (5-15 minute expiry)
- Optimized API calls with request batching
- Efficient data structures for quick lookups

## Prerequisites

- Node.js 18 or higher
- npm or yarn
- TMDB API Key (required)
- MAL Client ID (optional, but recommended)

## Installation

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the root directory:

```env
TMDB_API_KEY=your_tmdb_api_key_here
MAL_CLIENT_ID=your_mal_client_id_here
PORT=3000
```

### Getting API Keys

#### TMDB API Key (Required)
1. Create an account at https://www.themoviedb.org/
2. Go to Settings > API
3. Request an API key
4. Copy the API Key (v3 auth)
5. Add to `.env` as `TMDB_API_KEY`

#### MAL Client ID (Optional)
1. Create an account at https://myanimelist.net/
2. Go to https://myanimelist.net/apiconfig
3. Create a new client application
4. Copy the Client ID
5. Add to `.env` as `MAL_CLIENT_ID`

## Running the Server

### Development mode (with auto-reload)
```bash
npm run dev
```

### Production mode
```bash
npm run build
npm start
```

The server will start on `http://localhost:3000` (or the PORT specified in `.env`)

## API Documentation

### Cross-Platform Mapping

#### GET `/map`
Map anime across AniList, MyAnimeList, TMDB, and streaming providers (AnimePahe, HiAnime, AnimeKai, AnimeSama).

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | No | Search by anime title |
| `anilistId` | number | No | Map from AniList ID |
| `malId` | number | No | Map from MyAnimeList ID |
| `tmdbId` | number | No | Map from TMDB ID |
| `mediaType` | string | No | TMDB media type: `tv` or `movie` (required with tmdbId) |

**Examples:**
```bash
GET /map?title=Attack on Titan
GET /map?anilistId=16498
GET /map?malId=16498
GET /map?tmdbId=1429&mediaType=tv
```

**Response Example:**
```json
{
  "anilist": {
    "id": 21355,
    "title": {
      "romaji": "Re:Zero kara Hajimeru Isekai Seikatsu",
      "english": "Re:ZERO -Starting Life in Another World-",
      "native": "Re:ゼロから始める異世界生活"
    },
    "format": "TV",
    "episodes": 25,
    "status": "FINISHED",
    "year": 2016,
    "score": 81
  },
  "tmdb": {
    "id": 65942,
    "title": "Re:ZERO -Starting Life in Another World-",
    "mediaType": "tv",
    "seasonNumber": 1,
    "seasonName": "Season 1",
    "splitCourPart": 1,
    "releaseDate": "2016-04-04",
    "year": 2016
  },
  "mal": {
    "id": 31240,
    "title": "Re:Zero kara Hajimeru Isekai Seikatsu",
    "episodes": 25,
    "year": 2016
  },
  "animepahe": {
    "id": "888-Re:ZERO -Starting Life in Another World-",
    "slug": "888",
    "episodes": 25
  },
  "hianime": {
    "id": "rezero-starting-life-in-another-world-212",
    "slug": "rezero-starting-life-in-another-world-212",
    "episodes": 25
  },
  "animekai": {
    "id": "rezero-starting-life-in-another-world-k2np",
    "url": "https://anikai.to/watch/rezero-starting-life-in-another-world-k2np",
    "episodes": 27
  },
  "animesama": {
    "slug": "re-zero",
    "seasonSlug": "saison1",
    "seasons": 5
  }
}
```

**What This Endpoint Provides:**
- Complete mapping across all databases and streaming providers
- Direct access to streaming IDs without additional API calls
- Season detection for TMDB and AnimeSama
- Episode counts from all providers for comparison

---

### AnimePahe Endpoints

#### GET `/animepahe/map/:anilistId`
Map AniList ID to AnimePahe anime data with episode list.

#### GET `/animepahe/sources/:session/:episodeId`
Get streaming sources for a specific episode. Returns multiple quality options (360p, 720p, 1080p).

#### GET `/animepahe/hls/:anilistId/:episode`
Get HLS streaming sources directly by AniList ID and episode number.

**Parameters:**
- `:anilistId` - AniList anime ID
- `:episode` - Episode number

---

### HiAnime Endpoints

#### GET `/hianime/:anilistId`
Map AniList ID to HiAnime anime data with complete episode list.

#### GET `/hianime/sources/:animeId`
Get streaming sources for a specific episode.

**Query Parameters:**
| Parameter | Type | Default | Options | Description |
|-----------|------|---------|---------|-------------|
| `ep` | number | Required | - | Episode number |
| `server` | string | `hd-1` | `hd-1`, `hd-2`, `hd-3` | Server selection |
| `category` | string | `sub` | `sub`, `dub`, `raw` | Audio type |

**Example:**
```bash
GET /hianime/sources/rezero-212?ep=1&server=hd-1&category=sub
```

#### GET `/hianime/servers/:animeId`
Get available servers for a specific episode.

**Query Parameters:**
- `ep` - Episode number (required)

---

### AnimeKai Endpoints

#### GET `/animekai/map/:anilistId`
Map AniList ID to AnimeKai anime data with episode list.

**Response includes:**
- Anime slug (e.g., `rezero-starting-life-in-another-world-k2np`)
- Full watch URL
- Episode list with IDs
- Sub/Dub availability

**Note:** The `/map` endpoint returns just the slug in the `id` field for consistency with other providers. Use the `url` field to access the full watch page.

#### GET `/animekai/sources/:episodeId`
Get streaming sources for a specific episode.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `server` | string | auto | Server preference |
| `dub` | boolean | false | Set to `true` or `1` for dubbed version |

---

### AnimeSama Endpoints

#### GET `/animesama/map/:anilistId`
Map AniList ID to AnimeSama (French anime) with season information.

**Response includes:**
- Available seasons (VOSTFR/VF)
- Episode counts per season
- Season slugs for fetching sources

#### GET `/animesama/servers/:anilistId/:episode`
Get all available video servers for a specific episode.

**Query Parameters:**
| Parameter | Type | Default | Options | Description |
|-----------|------|---------|---------|-------------|
| `season` | string | `saison1` | `saison1`, `saison2`, etc. | Season slug |
| `category` | string | `sub` | `sub`, `dub` | Subbed (VOSTFR) or Dubbed (VF) |

**Response:**
```json
{
  "anilistId": 21355,
  "animesamaSlug": "re-zero",
  "seasonSlug": "saison1",
  "episode": 3,
  "category": "sub",
  "totalServers": 3,
  "servers": [
    {
      "name": "Player 1",
      "serverType": "sibnet",
      "url": "https://video.sibnet.ru/shell.php?videoid=4952093"
    },
    {
      "name": "Player 2",
      "serverType": "vidmoly",
      "url": "https://vidmoly.to/embed-nhuawa09l71a.html"
    },
    {
      "name": "Player 3",
      "serverType": "sendvid",
      "url": "https://sendvid.com/embed/5tnz579k"
    }
  ]
}
```

**Supported Server Types:**
- `vidmoly` - VidMoly (HLS/M3U8, multiple qualities)
- `sibnet` - Sibnet (Direct MP4)
- `sendvid` - SendVid (Direct video)
- `movearnpre` - MoveArnPre (HLS/M3U8)
- `lpayer` - Lpayer/Embed4Me (HLS/M3U8)
- `doodstream` - Doodstream
- `oneupload` - OneUpload

#### GET `/animesama/hls/:anilistId/:episode`
Get HLS streaming sources for a specific episode.

**Query Parameters:**
| Parameter | Type | Default | Options | Description |
|-----------|------|---------|---------|-------------|
| `season` | string | `saison1` | `saison1`, `saison2`, etc. | Season slug |
| `category` | string | `sub` | `sub`, `dub` | Subbed (VOSTFR) or Dubbed (VF) |
| `server` | string | `auto` | `auto`, `vidmoly`, `sibnet`, etc. | Server preference |

**Server Priority (auto mode):**
1. VidMoly (best quality, HLS)
2. MoveArnPre (good quality, HLS)
3. Sibnet (reliable, direct MP4)
4. SendVid (fallback)
5. Lpayer (fallback)

**Response:**
```json
{
  "anilistId": 21355,
  "animesamaSlug": "re-zero",
  "seasonSlug": "saison1",
  "episode": 3,
  "category": "sub",
  "server": "auto",
  "sources": [
    {
      "quality": "auto",
      "url": "https://prx-1329-ant-t.vmwesa.online/.../master.m3u8?...",
      "isM3U8": true
    },
    {
      "url": "https://prx-1329-ant-t.vmwesa.online/.../index-v1-a1.m3u8?...",
      "quality": "480p",
      "isM3U8": true
    },
    {
      "url": "https://prx-1329-ant-t.vmwesa.online/.../index-v1-a1.m3u8?...",
      "quality": "720p",
      "isM3U8": true
    }
  ],
  "headers": {
    "Referer": "https://vidmoly.net/embed-nhuawa09l71a.html",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  }
}
```

**Usage Workflow:**
1. Use `/animesama/map/:anilistId` to get available seasons
2. Use `/animesama/servers/:anilistId/:episode` to check available servers
3. Use `/animesama/hls/:anilistId/:episode` to fetch video sources

---

## Response Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad request (missing or invalid parameters) |
| `404` | Resource not found |
| `500` | Server error (API keys not configured, provider unavailable, etc.) |

## Caching Strategy

The API implements intelligent caching to optimize performance and reduce external API calls:

| Endpoint Type | Cache Duration | Rationale |
|--------------|----------------|-----------|
| Mapping endpoints | 5 minutes | Allows frequent updates to anime data |
| Source endpoints | 15 minutes | Balances content freshness with performance |
| Search results | 5 minutes | Dynamic content benefits from regular updates |

Cache is stored in-memory and automatically expires. The cache can be cleared by restarting the server.

## Advanced Features

### Split-Cour Detection
The API automatically detects split-cour anime (anime split into multiple parts with gaps between seasons) and marks them appropriately:
```json
{
  "tmdb": {
    "seasonNumber": 1,
    "splitCourPart": 2,
    "releaseDate": "2016-10-01"
  }
}
```

### Intelligent Season Matching
For TMDB TV shows, the API employs multiple methods to detect the correct season:
1. **Primary Method**: Start date and episode count matching
2. **Secondary Method**: Year and episode count matching
3. **Tertiary Method**: Description similarity analysis

### Fuzzy Title Matching
The matching algorithm handles various title variations:
- Different romanizations (e.g., "Shingeki no Kyojin" vs "Attack on Titan")
- Subtitle variations (e.g., "Season 2" vs "2nd Season" vs "Second Season")
- OVA and Special suffixes
- Sequel indicators ("After Story", "Climax", "Final", etc.)
- French title variations (for AnimeSama)

## Usage Examples

### Basic Workflow
```bash
# 1. Search for anime across all platforms
curl "http://localhost:3000/map?title=Re:Zero"

# 2. Get AnimePahe episodes
curl "http://localhost:3000/animepahe/map/21355"

# 3. Get streaming sources
curl "http://localhost:3000/animepahe/hls/21355/1"
```

### AnimeSama Workflow
```bash
# 1. Get anime mapping and available seasons
curl "http://localhost:3000/animesama/map/21355"

# 2. Check available servers for an episode
curl "http://localhost:3000/animesama/servers/21355/3?category=sub"

# 3. Get video sources (auto server selection)
curl "http://localhost:3000/animesama/hls/21355/3?category=sub"

# 4. Get video sources from specific server
curl "http://localhost:3000/animesama/hls/21355/3?category=dub&server=sibnet"
```

### HiAnime with Server Selection
```bash
# 1. Check available servers
curl "http://localhost:3000/hianime/servers/rezero-212?ep=1"

# 2. Get sources from specific server
curl "http://localhost:3000/hianime/sources/rezero-212?ep=1&server=hd-2&category=dub"
```

### Cross-Platform Comparison
```bash
# Map from AniList to view all platform IDs
curl "http://localhost:3000/map?anilistId=21355" | json_pp
```

## Error Handling

All endpoints return consistent error formats:
```json
{
  "error": "Detailed error description",
  "message": "User-friendly error message (optional)"
}
```

Common error scenarios:
- Missing required parameters (400)
- Anime not found on specified platform (404)
- External API unavailable (500)
- Invalid API keys configured (500)
- Rate limit exceeded (429)

## Testing

### Using curl
```bash
# Pretty-print JSON responses
curl "http://localhost:3000/map?title=Naruto" | json_pp

# Save response to file
curl "http://localhost:3000/hianime/21355" > response.json

# Include headers in output
curl -i "http://localhost:3000/animepahe/map/21355"

# Test with multiple parameters
curl "http://localhost:3000/animesama/hls/21355/1?category=dub&server=vidmoly"
```

### Using Postman or Thunder Client
Import the base URL `http://localhost:3000` and test endpoints with the examples provided above.

## Notes & Limitations

### API Requirements
- **AniList**: No authentication required, no rate limits
- **MAL**: Requires Client ID, subject to rate limiting
- **TMDB**: Requires API key, limited to 40 requests per 10 seconds
- **Streaming Providers**: May be region-locked or subject to availability changes

### Matching Accuracy
Fuzzy matching may not always achieve 100% accuracy, particularly for:
- Sequels with significantly different titles
- OVAs and special episodes
- Movies versus TV shows with similar names
- Non-English titles with multiple romanization schemes

### Cache Behavior
- Cached data may be up to 5-15 minutes old depending on endpoint type
- Cache is stored in-memory and cleared on server restart
- No persistent cache storage is implemented

### AnimeSama Specific
- Primarily serves French anime (VOSTFR/VF)
- Video availability may vary by episode and server
- Some servers may have anti-scraping measures
- VidMoly URLs are automatically converted from `.to` to `.net`


## Project Structure

```
zero-mapper/
├── src/
│   ├── mappers/              # Cross-platform mapping logic
│   │   ├── cross-mapper.ts   # Main mapper with TMDB/MAL/AniList
│   │   └── index.ts          # Mapper exports
│   ├── providers/            # External API integrations
│   │   ├── anilist.ts        # AniList GraphQL client
│   │   ├── animepahe.ts      # AnimePahe scraper
│   │   ├── hianime.ts        # HiAnime API client
│   │   ├── hianime-servers.ts # HiAnime server extraction
│   │   ├── animekai.ts       # AnimeKai scraper
│   │   ├── animesama.ts      # AnimeSama mapper
│   │   └── animesama-sources.ts # AnimeSama video extractors
│   ├── utils/                # Utility functions
│   │   ├── cache.ts          # Caching middleware
│   │   ├── client.ts         # HTTP client with error handling
│   │   └── kwik-extractor.ts # Video source extractor
│   ├── constants/            # API constants and configuration
│   └── index.ts              # Express server and route definitions
├── public/                   # Static frontend
│   ├── index.html            # API documentation page
│   └── assets/               # Images and styling
├── dist/                     # Compiled JavaScript (generated)
├── .env                      # Environment variables (not in git)
├── .gitignore               
├── package.json
├── tsconfig.json             # TypeScript configuration
└── README.md
```

## Development

### Building
```bash
npm run build
```

Compiles TypeScript to JavaScript in the `dist/` directory.

### Running Built Version
```bash
npm start
```

Runs the compiled JavaScript from `dist/`.

### Development Mode
```bash
npm run dev
```

Runs with ts-node for hot reloading during development.

## Contributing

Contributions are welcome. Please follow these guidelines:
1. Fork the repository
2. Create a feature branch
3. Make your changes with clear commit messages
4. Test thoroughly
5. Submit a pull request

## License

ISC

## Credits & Acknowledgments

### Original Project
This project is based on [**anime-mapper**](https://github.com/shafat-96/anime-mapper) by [**shafat-96**](https://github.com/shafat-96).

The original anime-mapper provided:
- Core mapping logic for AnimePahe, HiAnime, and AnimeKai
- Advanced string similarity algorithms for title matching
- Season/year matching for multi-season anime
- Foundation for streaming source extraction

### Additional Integrations
- **TMDB** - The Movie Database API for comprehensive TV show and movie data
- **MyAnimeList** - MAL API for alternative anime database mapping
- **AnimeSama** - French anime streaming provider with multi-server support
- **Consumet Extensions** - Used for AnimePahe integration
- **String Similarity JS** - Enhanced fuzzy matching for title variations

### Special Thanks
- [shafat-96](https://github.com/shafat-96) - For creating the original anime-mapper
- [Consumet](https://github.com/consumet) - For the AnimePahe provider extensions
- The anime community for testing and feedback

## Support

For issues, questions, or feature requests, please open an issue on the GitHub repository.

---

**Zero Mapper** - Comprehensive anime mapping and streaming API  
*Extended from anime-mapper by shafat-96*
