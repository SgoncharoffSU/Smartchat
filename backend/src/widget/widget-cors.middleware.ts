import { NextFunction, Request, Response } from 'express';

/**
 * The widget is embedded on arbitrary third-party sites, so /api/widget/*
 * must allow any origin. This is scoped to just those routes (see
 * AppModule#configure) rather than enabling CORS for the whole app.
 */
export function widgetCorsMiddleware(req: Request, res: Response, next: NextFunction) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}
