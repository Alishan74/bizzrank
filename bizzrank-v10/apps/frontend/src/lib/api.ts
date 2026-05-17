import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = 'Bearer ' + token;
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  signup: (d: any) => api.post('/auth/signup', d),
  login: (d: any) => api.post('/auth/login', d),
  me: () => api.get('/auth/me'),
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
};

export default api;

// SSE — real-time scan progress (no polling)
export function subscribeScanProgress(
  scanId: string,
  token: string,
  onProgress: (data: any) => void,
  onComplete: () => void
): () => void {
  const es = new EventSource('/api/organic-scans/' + scanId + '/progress');
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
