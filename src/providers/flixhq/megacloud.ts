import axios from 'axios';
import * as crypto from 'crypto';

const MAIN_URL = "https://videostr.net";
const KEY_URL = "https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json";
const DECODE_URL = "https://script.google.com/macros/s/AKfycbxHbYHbrGMXYD2-bC-C43D3njIbU-wGiYQuJL61H4vyy6YVXkybMNNEPJNPPuZrD1gRVA/exec";
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

async function decryptWithGoogleScript(
  encryptedData: string,
  nonce: string,
  secret: string
): Promise<string> {
  try {
    const params = new URLSearchParams({
      encrypted_data: encryptedData,
      nonce: nonce,
      secret: secret,
    });

    const { data } = await axios.get(`${DECODE_URL}?${params.toString()}`);
    
    const fileMatch = data.match(/\"file\":\"(.*?)\"/)?.[1];
    if (!fileMatch) {
      throw new Error('Video URL not found in decrypted response');
    }
    
    return fileMatch;
  } catch (error: any) {
    console.error('Google Apps Script decryption failed:', error.message);
    throw error;
  }
}

function extractNonce(html: string): string | null {
  const match1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  if (match1) {
    return match1[0];
  }

  const match2 = html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);
  if (match2) {
    return match2[1] + match2[2] + match2[3];
  }

  return null;
}

export type track = {
  file: string;
  label?: string;
  kind: string;
  default?: boolean;
};

export type unencryptedSrc = {
  file: string;
  type: string;
};

export type extractedSrc = {
  sources: string | unencryptedSrc[];
  tracks: track[];
  t: number;
  server: number;
  encrypted?: boolean;
};

type ExtractedData = Pick<extractedSrc, "tracks" | "t" | "server"> & {
  sources: { file: string; type: string }[];
};

export class MegaCloud {
  static async extract(url: string, referer: string = ''): Promise<{ sources: any[], tracks?: track[] }> {
    try {
      const embedUrl = new URL(url);
      const instance = new MegaCloud();
      const result = await instance.extract2(embedUrl);
      return {
        sources: result.sources,
        tracks: result.tracks,
      };
    } catch (err: any) {
      console.error("MegaCloud extraction error:", err.message);
      return { sources: [] };
    }
  }

  async extract2(embedIframeURL: URL): Promise<ExtractedData> {
    const extractedData: ExtractedData = {
      sources: [],
      tracks: [],
      t: 0,
      server: 0,
    };

    try {
      const { data: html } = await axios.get<string>(embedIframeURL.href, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: embedIframeURL.href,
        },
      });
      
      const fileIdMatch = html.match(/data-id="([^"]+)"/);
      const fileId = fileIdMatch?.[1];
      if (!fileId) {
        throw new Error('Could not find file ID in embed page');
      }

      const nonce = extractNonce(html);
      if (!nonce) {
        throw new Error('Could not extract nonce from embed page');
      }

      const apiUrl = `${MAIN_URL}/embed-1/v3/e-1/getSources?id=${fileId}&_k=${nonce}`;
      const headers: Record<string, string> = {
        Accept: '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: embedIframeURL.href,
        'User-Agent': USER_AGENT,
      };

      const { data } = await axios.get<extractedSrc>(apiUrl, { headers });
      if (!data) return extractedData;

      const isEncrypted = data.encrypted;
      
      if (isEncrypted && data.sources) {
        try {
          const { data: keyData } = await axios.get(KEY_URL);
          const secret = keyData?.vidstr;
          
          if (!secret) {
            throw new Error('No decryption key found');
          }

          const decryptedUrl = await decryptWithGoogleScript(
            data.sources as string,
            nonce,
            secret
          );

          extractedData.sources = [{
            file: decryptedUrl,
            type: 'hls'
          }];
        } catch (err: any) {
          console.error('MegaCloud decrypt error:', err.message);
        }
      } else if (Array.isArray(data.sources)) {
        extractedData.sources = data.sources.map(src => ({
          file: src.file,
          type: src.type || 'hls',
        }));
      } else if (typeof data.sources === 'string') {
        extractedData.sources = [{
          file: data.sources,
          type: 'hls'
        }];
      }

      extractedData.tracks = (data.tracks || []).filter(
        track => track.kind === 'captions' || track.kind === 'subtitles'
      );
      extractedData.t = data.t || 0;
      extractedData.server = data.server || 0;

      return extractedData;
    } catch (err: any) {
      console.error("Extraction error in extract2:", err.message);
      return extractedData;
    }
  }
}
