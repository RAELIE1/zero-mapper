export enum TvType {
  MOVIE = 'MOVIE',
  TVSERIES = 'TVSERIES'
}

export enum StreamingServers {
  MixDrop = 'MixDrop',
  VidCloud = 'VidCloud',
  UpCloud = 'UpCloud'
}

export class MovieParser {
  name: string;
  baseUrl: string;
  logo: string;
  classPath: string;
  supportedTypes: Set<TvType>;
  proxyConfig: any | null;
  adapter: any | null;

  constructor() {
    this.name = '';
    this.baseUrl = '';
    this.logo = '';
    this.classPath = '';
    this.supportedTypes = new Set();
    this.proxyConfig = null;
    this.adapter = null;
  }

  async search(query: string, page: number = 1): Promise<any> {
    throw new Error('Method not implemented');
  }

  async fetchMediaInfo(mediaId: string): Promise<any> {
    throw new Error('Method not implemented');
  }

  async fetchEpisodeSources(episodeId: string, mediaId: string, server?: string): Promise<any> {
    throw new Error('Method not implemented');
  }

  async fetchEpisodeServers(episodeId: string, mediaId: string): Promise<any> {
    throw new Error('Method not implemented');
  }
}
