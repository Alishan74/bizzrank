import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

export interface AuthRequest extends Request { userId?: string; userEmail?: string; }

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.slice(7);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET!) as any;
    req.userId = p.userId;
    req.userEmail = p.email;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}
