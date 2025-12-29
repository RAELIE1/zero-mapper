export const ANILIST_URL = 'https://graphql.anilist.co';

export const ANILIST_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title {
        romaji
        english
        native
        userPreferred
      }
      episodes
      synonyms
    }
  }
`;

export const HIANIME_URL = 'https://hianime.to';
export const ANIZIP_URL = 'https://api.ani.zip/mappings';

export default {
  ANILIST_URL,
  ANILIST_QUERY,
  HIANIME_URL,
  ANIZIP_URL
};
