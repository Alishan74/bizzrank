import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

export interface AuthRequest extends Request { userId?: string; userEmail?: string; }

// Validate at module load — fail loudly instead of silently
// using undefined as JWT secret (which makes ALL tokens valid)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[auth middleware] JWT_SECRET environment variable is required but not set');
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  // Support both header and query param (SSE needs ?token=)
  const header = req.headers.authorization?.slice(7);
  const query  = req.query?.token as string | undefined;
  const token  = header ?? query;

  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const p = jwt.verify(token, JWT_SECRET) as any;
    req.userId    = p.userId;
    req.userEmail = p.email;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}
