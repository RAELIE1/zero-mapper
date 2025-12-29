import axios from 'axios';

interface KwikVideo {
  quality: string;
  url: string;
  isM3U8: boolean;
}

/**
 * Unpacks JavaScript packed with Dean Edwards' packer
 * @param packedCode - The packed JavaScript code
 * @returns Unpacked JavaScript code
 */
function unpackJs(packedCode: string): string {
  try {
    // Extract the packed function components
    const match = packedCode.match(/}\('(.*)',(\d+),(\d+),'(.*)'/);
    if (!match) return '';

    const payload = match[1].replace(/\\'/g, "'");
    const radix = parseInt(match[2]);
    const count = parseInt(match[3]);
    const symbols = match[4].split('|');

    // Unpacking function
    const unbase = (num: number): string => {
      return num.toString(radix > 36 ? radix : 36);
    };

    let result = payload;
    
    // Replace each symbol with its value
    for (let i = count - 1; i >= 0; i--) {
      if (symbols[i]) {
        const pattern = new RegExp('\\b' + unbase(i) + '\\b', 'g');
        result = result.replace(pattern, symbols[i]);
      }
    }

    return result;
  } catch (error) {
    console.error('Error unpacking JavaScript:', error);
    return '';
  }
}

export class KwikExtractor {
  /**
   * Extract m3u8 URL from kwik.cx embed page
   * @param kwikUrl - The kwik.cx embed URL
   * @returns The m3u8 video URL
   */
  static async extract(kwikUrl: string): Promise<string | null> {
    try {
      const { data } = await axios.get(kwikUrl, {
        headers: {
          'Referer': 'https://kwik.cx/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      // Method 1: Try to unpack the obfuscated JavaScript
      const evalMatches = data.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]+?\}\(\'[\s\S]+?\'\s*,\s*\d+\s*,\s*\d+\s*,\s*\'[\s\S]+?\'\.split\('\|'\)\s*,\s*\d+\s*,\s*\{\}\)\)/g);
      
      if (evalMatches && evalMatches.length > 0) {
        // Try each eval (usually the second one contains the video URL)
        for (const evalCode of evalMatches) {
          const unpacked = unpackJs(evalCode);
          
          // Look for the m3u8 URL in unpacked code
          const m3u8Match = unpacked.match(/https?:\/\/[^'"]+\.m3u8/);
          if (m3u8Match) {
            console.log('KwikExtractor: Found m3u8 URL via unpacking');
            return m3u8Match[0];
          }
        }
      }

      // Method 2: Direct m3u8 URL match (unobfuscated)
      const directMatch = data.match(/https:\/\/[^'"]+\.m3u8/);
      if (directMatch) {
        console.log('KwikExtractor: Found m3u8 URL directly');
        return directMatch[0];
      }

      // Method 3: Extract from preconnect + word list (fallback for older obfuscation)
      const preconnectMatch = data.match(/(?:preconnect|dns-prefetch).*?href=["']\/\/(vault-\d+\.[^'"]+)["']/);
      
      if (preconnectMatch) {
        const domain = preconnectMatch[1];
        
        if (evalMatches && evalMatches.length > 0) {
          const relevantEval = evalMatches.length > 1 ? evalMatches[1] : evalMatches[0];
          const wordListMatch = relevantEval.match(/'([^']+)'\.split\('\|'\)/);
          
          if (wordListMatch) {
            const words = wordListMatch[1].split('|');
            const hash = words.find((w: string) => w.match(/^[0-9a-f]{64}$/));
            
            if (hash) {
              const pathSegments: string[] = [];
              
              for (const word of words) {
                if (word === hash || word === 'https' || word === 'vault' || 
                    word === 'owocdn' || word === 'uwucdn' || word === 'top' || 
                    word === 'stream' || word === 'm3u8' || word === '' || word.length > 10) {
                  continue;
                }
                
                if (word.match(/^[a-z0-9]{2,4}$/i)) {
                  pathSegments.push(word);
                }
              }
              
              if (pathSegments.length >= 2) {
                const url = `https://${domain}/stream/${pathSegments[0]}/${pathSegments[1]}/${hash}.m3u8`;
                console.log('KwikExtractor: Constructed URL from word list');
                return url;
              }
            }
          }
        }
      }

      console.warn(`KwikExtractor: Could not extract m3u8 URL from ${kwikUrl}`);
      return null;
      
    } catch (err) {
      console.error(`KwikExtractor error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Extract m3u8 URLs from multiple kwik.cx links
   * @param kwikUrls - Array of kwik.cx embed URLs
   * @returns Array of video objects with quality and m3u8 URL
   */
  static async extractMultiple(kwikUrls: Array<{ quality: string; url: string }>): Promise<KwikVideo[]> {
    const results: KwikVideo[] = [];

    for (const { quality, url } of kwikUrls) {
      const m3u8Url = await this.extract(url);
      
      if (m3u8Url) {
        results.push({
          quality,
          url: m3u8Url,
          isM3U8: true,
        });
      }
    }

    return results;
  }
}

export default KwikExtractor;
