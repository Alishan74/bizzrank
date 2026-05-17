import { create } from 'zustand';
interface S { token: string | null; user: any; setAuth: (t: string, u: any) => void; logout: () => void; isLoggedIn: () => boolean; }
export const useAuth = create<S>((set, get) => ({
  token: localStorage.getItem('token'), user: null,
  setAuth: (token, user) => { localStorage.setItem('token', token); set({ token, user }); },
  logout: () => { localStorage.removeItem('token'); set({ token: null, user: null }); },
  isLoggedIn: () => !!get().token,
}));
