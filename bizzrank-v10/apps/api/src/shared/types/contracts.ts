// ============================================================
// BizzRank AI v10 — Shared Domain Contracts
// All domain interfaces defined here.
// Domains communicate ONLY through these types.
// ============================================================

// ─── IDENTITY ────────────────────────────────────────────────
export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  companyName: string | null;
  plan: PlanName;
  creditsBalance: number;
  monthlyAllowance: number;
  maxBusinesses: number;
  maxCompetitorsPerLocation: number;
  gbpConnected: boolean;
  gbpAccessToken: string | null;
  gbpRefreshToken: string | null;
  createdAt: string;
}

export type PlanName = 'starter' | 'professional' | 'agency' | 'enterprise';

// ─── GEO ─────────────────────────────────────────────────────
export interface ScanPoint {
  lat: number;
  lng: number;
  index: number;
  label: string;
  locationName: string;
  googleMapsUrl: string;
  source: 'auto_grid' | 'address' | 'zip_code';
}

// ─── SERPAPI ─────────────────────────────────────────────────
export interface SearchResult {
  placeId: string;
  name: string;
  address: string;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  latitude: number;
  longitude: number;
  rank: number;
  isSponsored: boolean;
  thumbnail: string | null;
}

export interface SearchResults {
  organic: SearchResult[];
  sponsored: SearchResult[];
  fromCache: boolean;
}

export interface SerpReview {
  reviewId: string;
  reviewerName: string;
  reviewerPhoto: string | null;
  rating: number;
  text: string;
  date: string;
  isReplied: boolean;
}

// ─── SCANNING ────────────────────────────────────────────────
export type ScanState = 'pending' | 'running' | 'completed' | 'failed';
export type TargetingMethod = 'auto_grid' | 'addresses' | 'zip_codes';

export interface ScanJob {
  scanId: string;
  userId: string;
  businessId: string;
  clientGooglePlaceId: string | null;
  competitors: Array<{ id: string; name: string; googlePlaceId: string | null }>;
  keyword: string;
  points: ScanPoint[];
  radiusKm: number;
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  rank: number | null;
  label: string;
  locationName: string;
  intensity: number;
  googleMapsUrl: string;
}

export interface GridScore {
  placeId: string;
  name: string;
  isClientBusiness: boolean;
  visibilityScore: number;
  avgRanking: number | null;
  territoryDominance: number;
  top3Cells: number;
  top10Cells: number;
  rankedCells: number;
  totalCells: number;
  heatmapPoints: HeatmapPoint[];
}

// ─── AD PRESSURE ─────────────────────────────────────────────
export interface AdSlotJob {
  slotId: string;
  sessionId: string;
  userId: string;
  businessId: string;
  keyword: string;
  radiusKm: number;
  targetingMethod: TargetingMethod;
  inputAddresses: any[] | null;
  inputZipCodes: string[] | null;
  gridSize: number;
}

export interface AdDensityPoint {
  lat: number;
  lng: number;
  label: string;
  locationName: string;
  adCount: number;
  hasAds: boolean;
  googleMapsUrl: string;
  topAdvertisers: Array<{ name: string; rank: number; placeId: string }>;
}

// ─── REVIEWS ─────────────────────────────────────────────────
export interface ReviewSyncJob {
  businessId: string;
  userId: string;
  googlePlaceId: string;
  businessName: string;
}

// ─── BILLING ─────────────────────────────────────────────────
export interface CreditDeduction {
  userId: string;
  amount: number;
  reason: string;
  transactionType: 'usage' | 'refund' | 'purchase';
}

// ─── DOMAIN EVENTS ───────────────────────────────────────────
export interface DomainEvent<T = any> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  payload: T;
}

export interface ScanCompletedEvent {
  scanId: string;
  userId: string;
  businessId: string;
  keyword: string;
  score: number;
  clientGooglePlaceId: string | null;
}

export interface ScanProgressEvent {
  scanId: string;
  pointsCompleted: number;
  totalPoints: number;
  percentComplete: number;
}

export interface ReviewFetchedEvent {
  businessId: string;
  userId: string;
  count: number;
}
