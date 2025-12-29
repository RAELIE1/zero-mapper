import NodeCache from 'node-cache';
import { Request, Response, NextFunction } from 'express';

const apiCache = new NodeCache({ stdTTL: 300 });

export function cache(duration: string) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {

    if (req.method !== 'GET') {
      return next();
    }

    const key = req.originalUrl || req.url;

    const cachedResponse = apiCache.get(key);

    if (cachedResponse) {
      console.log(`Cache hit for: ${key}`);
      return res.json(cachedResponse);
    }

    const originalJson = res.json.bind(res);

    res.json = function(data: any): Response {
      try {

        if ((res.statusCode || 200) < 400) {
          console.log(`Caching response for: ${key}`);
          apiCache.set(key, data);
        } else {
          console.log(`Skip caching error for: ${key} (status ${res.statusCode})`);
        }
      } catch (e: any) {
        console.warn(`Cache middleware error: ${e?.message || e}`);
      }

      return originalJson(data);
    };

    next();
  };
}
