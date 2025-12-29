import { client } from './client.js';

const ENC_DEC_API_BASE = 'https://enc-dec.app/api';

interface DecryptedIframeData {
  url: string;
  skip: {
    intro: [number, number];
    outro: [number, number];
  };
}

/**
 * Encrypt token for AnimeKai API requests
 * @param text - Token to encrypt
 * @returns Encrypted token string
 */
export async function encryptToken(text: string): Promise<string> {
  try {
    const { data } = await client.get(`${ENC_DEC_API_BASE}/enc-kai`, {
      params: { text },
      timeout: 30000,
    });
    return data.result;
  } catch (error) {
    throw new Error(`Failed to encrypt token: ${(error as Error).message}`);
  }
}

/**
 * Decrypt iframe data from AnimeKai API
 * @param text - Encrypted iframe data
 * @returns Decrypted iframe data with URL and skip timestamps
 */
export async function decryptIframeData(text: string): Promise<DecryptedIframeData> {
  try {
    const { data } = await client.post(
      `${ENC_DEC_API_BASE}/dec-kai`,
      { text },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return data.result;
  } catch (error) {
    throw new Error(`Failed to decrypt iframe data: ${(error as Error).message}`);
  }
}

/**
 * Decrypt MegaUp player data
 * @param text - Encrypted player data
 * @param userAgent - User agent string for the request
 * @returns Decrypted player data with sources, tracks, and download URL
 */
export async function decryptMegaUpData(
  text: string,
  userAgent: string = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
): Promise<{
  sources: { file: string }[];
  tracks: { kind: string; file: string; label: string }[];
  download: string;
}> {
  try {
    const { data } = await client.post(
      `${ENC_DEC_API_BASE}/dec-mega`,
      { text, agent: userAgent },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return data.result;
  } catch (error) {
    throw new Error(`Failed to decrypt MegaUp data: ${(error as Error).message}`);
  }
}
