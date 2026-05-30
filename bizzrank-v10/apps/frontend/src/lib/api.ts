import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = 'Bearer ' + token;
  return config;
});

// Track if we're already refreshing to avoid infinite loops
let isRefreshing = false;
let refreshQueue: Array<(token: string) => void> = [];

api.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config;

    // 401 + not already retried + not the refresh endpoint itself
    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !originalRequest.url?.includes('/auth/login')
    ) {
      originalRequest._retry = true;

      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise(resolve => {
          refreshQueue.push((token: string) => {
            originalRequest.headers.Authorization = 'Bearer ' + token;
            resolve(api(originalRequest));
          });
        });
      }

      isRefreshing = true;

      try {
        const { data } = await api.post('/auth/refresh');
        const newToken = data.token;
        localStorage.setItem('token', newToken);
        api.defaults.headers.common['Authorization'] = 'Bearer ' + newToken;
        originalRequest.headers.Authorization = 'Bearer ' + newToken;

        // Flush queued requests
        refreshQueue.forEach(cb => cb(newToken));
        refreshQueue = [];

        return api(originalRequest);
      } catch {
        // Refresh failed — session truly expired, force logout
        localStorage.removeItem('token');
        refreshQueue = [];
        window.location.href = '/login?expired=1';
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export const authApi = {
  signup: (d: any) => api.post('/auth/signup', d),
  login: (d: any) => api.post('/auth/login', d),
  me: () => api.get('/auth/me'),
  refresh:         () => api.post('/auth/refresh'),
  forgotPassword:  (d: any) => api.post('/auth/forgot-password', d),
  resetPassword:   (d: any) => api.post('/auth/reset-password', d),
  gbpConnect: () => api.get('/auth/gbp/connect'),
  gbpLocations: () => api.get('/auth/gbp/locations'),
};

export const bizApi = {
  list: () => api.get('/businesses'),
  autocomplete: (q: string) => api.get('/businesses/autocomplete?q=' + encodeURIComponent(q)),
  placeDetails: (id: string) => api.get('/businesses/place/' + id),
  create: (d: any) => api.post('/businesses', d),
  updateBrandVoice: (id: string, brandVoice: any) => api.patch('/businesses/' + id + '/brand-voice', { brandVoice }),
  updateHours: (id: string, d: any) => api.patch('/businesses/' + id + '/hours', d),
  importGBP: (ids: string[]) => api.post('/businesses/import-gbp', { locationIds: ids }),
};

export const compApi = {
  list: (businessId: string) => api.get('/competitors?businessId=' + businessId),
  limit: (businessId: string) => api.get('/competitors/limit?businessId=' + businessId),
  autocomplete: (q: string) => api.get('/competitors/autocomplete?q=' + encodeURIComponent(q)),
  placeDetails: (id: string) => api.get('/competitors/place/' + id),
  add: (d: any) => api.post('/competitors', d),
  remove: (id: string) => api.delete('/competitors/' + id),
};

export const organicApi = {
  list: () => api.get('/organic-scans'),
  get: (id: string) => api.get('/organic-scans/' + id),
  create: (d: any) => api.post('/organic-scans', d),
  addressAutocomplete: (q: string) => api.get('/organic-scans/address-autocomplete?q=' + encodeURIComponent(q)),
  addressDetails: (placeId: string) => api.get('/organic-scans/address-details/' + placeId),
};

export const adApi = {
  list: () => api.get('/ad-scans'),
  get: (id: string) => api.get('/ad-scans/' + id),
  create: (d: any) => api.post('/ad-scans', d),
  stop: (id: string) => api.post('/ad-scans/' + id + '/stop'),
  addressAutocomplete: (q: string) => api.get('/ad-scans/address-autocomplete?q=' + encodeURIComponent(q)),
  addressDetails: (placeId: string) => api.get('/ad-scans/address-details/' + placeId),
};

export const reviewApi = {
  list: (businessId: string) => api.get('/reviews?businessId=' + businessId),
  fetch: (businessId: string) => api.post('/reviews/fetch', { businessId }),
  generateAll: (businessId: string) => api.post('/reviews/generate-all', { businessId }),
  approve: (id: string, editedReply?: string) => api.post('/reviews/' + id + '/approve', { editedReply }),
  regenerate: (id: string) => api.post('/reviews/' + id + '/regenerate'),
  toggleAuto: (id: string, enabled: boolean) => api.patch('/reviews/' + id + '/toggle-auto', { enabled }),
};

export const leaderboardApi = {
  get: (businessId: string) => api.get('/leaderboard?businessId=' + businessId),
};

export const citationApi = {
  get: (businessId: string) => api.get('/citations?businessId=' + businessId),
  run: (businessId: string) => api.post('/citations/run', { businessId }),
  completeTask: (auditId: string, taskIndex: number) => api.patch('/citations/' + auditId + '/task/' + taskIndex + '/complete'),
};

export const dashboardApi = {
  get: () => api.get('/dashboard'),
};

export const profileApi = {
  credits: () => api.get('/profile/credits'),
  updateDetails: (d: any) => api.patch('/profile/details', d),
  changePassword: (d: any) => api.patch('/profile/password', d),
  deleteAccount:  (d: any) => api.delete('/profile/account', { data: d }),
};

export default api;

// SSE — real-time scan progress (no polling)
export function subscribeScanProgress(
  scanId: string,
  token: string,
  onProgress: (data: any) => void,
  onComplete: () => void
): () => void {
  const es = new EventSource('/api/organic-scans/' + scanId + '/progress' + '?token=' + (localStorage.getItem('token') ?? ''));
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onProgress(data);
      if (data.percentComplete >= 100 || data.state === 'completed' || data.state === 'failed') {
        es.close();
        onComplete();
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); onComplete(); };
  return () => es.close();
}

export const customScanApi = {
  list:              ()        => api.get('/custom-scans'),
  get:               (id: string) => api.get('/custom-scans/' + id),
  create:            (d: any)  => api.post('/custom-scans', d),
  addressAutocomplete: (q: string) => api.get('/custom-scans/address-autocomplete?q=' + encodeURIComponent(q)),
  addressDetails:    (id: string)  => api.get('/custom-scans/address-details/' + id),
};

export const intelApi = {
  status:  (businessId: string) => api.get('/intelligence/status?businessId=' + businessId),
  signals: (businessId: string, limit = 20) => api.get('/intelligence/signals?businessId=' + businessId + '&limit=' + limit),
};

export const gbpGuardApi = {
  summary:      (businessId: string) => api.get('/gbp-guard/summary?businessId=' + businessId),
  alerts:       (businessId: string, includeRead = false) =>
                  api.get('/gbp-guard/alerts?businessId=' + businessId + '&includeRead=' + includeRead),
  markRead:     (alertIds: string[]) => api.post('/gbp-guard/mark-read', { alertIds }),
  markAllRead:  (businessId: string) => api.post('/gbp-guard/mark-all-read', { businessId }),
  history:      (entityId: string, limit = 30) =>
                  api.get('/gbp-guard/history?entityId=' + entityId + '&limit=' + limit),
};

export const aiVisibilityApi = {
  status:          (businessId: string) => api.get('/ai-visibility/status?businessId=' + businessId),
  platforms:       ()                   => api.get('/ai-visibility/platforms'),
  check:           (businessId: string) => api.post('/ai-visibility/check', { businessId }),
  // These were MISSING — CitationsTab.tsx was throwing "is not a function"
  citations:       (businessId: string) => api.get('/ai-visibility/citations?businessId=' + businessId),
  citationSources: (sector: string)     => api.get('/ai-visibility/citation-sources?sector=' + sector),
};


export const billingApi = {
  status:   ()           => api.get('/billing/status'),
  checkout: (plan: string) => api.post('/billing/checkout', { plan }),
  portal:   ()           => api.post('/billing/portal'),
};

export const agencyApi = {
  dashboard:         ()                           => api.get('/agency/dashboard'),
  clients:           ()                           => api.get('/agency/clients'),
  createClient:      (d: any)                     => api.post('/agency/clients', d),
  getClient:         (id: string)                 => api.get('/agency/clients/' + id),
  updateClient:      (id: string, d: any)         => api.patch('/agency/clients/' + id, d),
  deleteClient:      (id: string)                 => api.delete('/agency/clients/' + id),
  setStatus:         (id: string, status: string) => api.patch('/agency/clients/' + id + '/status', { status }),
  rotateToken:       (id: string)                 => api.post('/agency/clients/' + id + '/rotate-token'),
  assignBusiness:    (clientId: string, businessId: string) => api.post('/agency/clients/' + clientId + '/assign-business', { businessId }),
  unassignBusiness:  (clientId: string, businessId: string) => api.post('/agency/clients/' + clientId + '/unassign-business', { businessId }),
  addNote:           (clientId: string, note: string) => api.post('/agency/clients/' + clientId + '/notes', { note }),
  workQueue:         ()                           => api.get('/agency/work-queue'),
  resolveTask:       (id: string)                 => api.post('/agency/work-queue/' + id + '/resolve'),
  generateTasks:     ()                           => api.post('/agency/work-queue/generate'),
  credits:           ()                           => api.get('/agency/credits'),
  analytics:         ()                           => api.get('/agency/analytics'),
  bulkScan:          (clientId: string)           => api.post('/agency/bulk-scan', { clientId }),
  exportData:        ()                           => api.get('/agency/export'),
};
