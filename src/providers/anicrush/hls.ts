import { handleEmbed } from './embedHandler.js';

export async function getHlsLink(embedUrl: string) {
    try {
        if (!embedUrl) {
            throw new Error('Embed URL is required');
        }

        const embedSources = await handleEmbed(embedUrl);

        if (!embedSources || !embedSources.sources || !embedSources.sources.length) {
            throw new Error('No sources found');
        }

        return {
            status: true,
            result: {
                sources: embedSources.sources,
                tracks: embedSources.tracks,
                t: embedSources.t,
                intro: embedSources.intro,
                outro: embedSources.outro,
                server: embedSources.server
            }
        };

    } catch (error: any) {
        console.error('Error getting HLS link:', error);
        return {
            status: false,
            error: error.message || 'Failed to get HLS link'
        };
    }
}
