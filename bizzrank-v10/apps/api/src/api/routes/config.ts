import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
// Expose non-secret config to authenticated frontend
router.get('/', requireAuth, (_, res) => {
  res.json({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  });
});
export default router;
