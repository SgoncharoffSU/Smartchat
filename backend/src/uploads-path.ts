import { join } from 'path';

// A sibling of backend/, widget/, cabinet/ at the repo root — NOT inside
// backend/dist, so an `npm run build` (which only touches dist/) never
// wipes it, and it's outside anything a deploy script's file list would
// ever overwrite. process.cwd() is reliably backend/ (both `nest start`
// in dev and the pm2-run `node dist/main` in production run from there),
// so this needs no __dirname depth-counting that would silently break if
// a file importing it ever moves to a different folder depth.
export const UPLOADS_DIR = join(process.cwd(), '..', 'uploads');
