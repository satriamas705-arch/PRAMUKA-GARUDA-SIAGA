import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize Firebase app safely
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Provider with full Google Drive scope
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.setCustomParameters({
  prompt: 'select_account',
});

export interface GoogleUserProfile {
  email: string;
  name: string;
  picture?: string;
  sub?: string;
}

// In-memory token storage (NEVER in localStorage per Workspace Security guidelines)
let cachedAccessToken: string | null = null;
let tokenAcquiredAt: number = 0;
let currentGoogleUser: User | null = null;
let currentProfile: GoogleUserProfile | null = null;
let isSigningIn = false;

type AuthCallback = (
  user: User | null,
  token: string | null,
  profile: GoogleUserProfile | null
) => void;
const listeners: Set<AuthCallback> = new Set();

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener(currentGoogleUser, cachedAccessToken, currentProfile);
    } catch (err) {
      console.error('Error in auth listener:', err);
    }
  });
}

/**
 * Fetch profile info from Google userinfo API using access token
 */
export async function fetchGoogleProfile(
  token: string
): Promise<GoogleUserProfile | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      email: data.email || '',
      name: data.name || data.email || 'Pengguna Google',
      picture: data.picture,
      sub: data.sub,
    };
  } catch (err) {
    console.warn('Gagal mengambil profil Google userinfo:', err);
    return null;
  }
}

/**
 * Initialize auth listener
 */
export const initGoogleAuth = (
  onAuthChange?: AuthCallback
): (() => void) => {
  if (onAuthChange) {
    listeners.add(onAuthChange);
    onAuthChange(currentGoogleUser, cachedAccessToken, currentProfile);
  }

  const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
    currentGoogleUser = user;
    if (user && !currentProfile) {
      currentProfile = {
        email: user.email || '',
        name: user.displayName || user.email || 'Pengguna Google',
        picture: user.photoURL || undefined,
        sub: user.uid,
      };
    } else if (!user && !cachedAccessToken) {
      currentProfile = null;
    }
    notifyListeners();
  });

  return () => {
    if (onAuthChange) listeners.delete(onAuthChange);
    unsubscribe();
  };
};

/**
 * Direct Sign in via Google Identity Services (GIS Token Client)
 * This bypasses Firebase Auth domain issues if running in iframes or preview domains.
 */
function requestTokenViaGIS(): Promise<{
  accessToken: string;
  profile?: GoogleUserProfile;
} | null> {
  return new Promise((resolve, reject) => {
    const googleGsi = (window as any).google?.accounts?.oauth2;
    if (!googleGsi) {
      resolve(null);
      return;
    }

    try {
      const client = googleGsi.initTokenClient({
        client_id: firebaseConfig.oAuthClientId,
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
        callback: async (response: any) => {
          if (response.error) {
            reject(
              new Error(
                response.error_description ||
                  `Gagal memperoleh token dari Google: ${response.error}`
              )
            );
            return;
          }
          if (response.access_token) {
            cachedAccessToken = response.access_token;
            tokenAcquiredAt = Date.now();
            const profile = await fetchGoogleProfile(response.access_token);
            if (profile) currentProfile = profile;
            notifyListeners();
            resolve({
              accessToken: response.access_token,
              profile: profile || undefined,
            });
          } else {
            resolve(null);
          }
        },
        error_callback: (err: any) => {
          reject(new Error(err.message || 'Proses otorisasi Google ditolak.'));
        },
      });

      client.requestAccessToken({ prompt: 'select_account' });
    } catch (err: any) {
      console.warn('GIS Token client error:', err);
      reject(err);
    }
  });
}

/**
 * Universal Google Sign-In with fallback between Firebase and GIS
 */
export const signInWithGoogle = async (): Promise<{
  accessToken: string;
  user?: User | null;
  profile?: GoogleUserProfile | null;
}> => {
  if (isSigningIn) {
    throw new Error('Proses autentikasi sedang berlangsung. Silakan tunggu.');
  }

  isSigningIn = true;
  let lastError: any = null;

  try {
    // Strategy 1: Try Firebase Auth popup
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);

      if (credential?.accessToken) {
        cachedAccessToken = credential.accessToken;
        tokenAcquiredAt = Date.now();
        currentGoogleUser = result.user;
        currentProfile = {
          email: result.user.email || '',
          name: result.user.displayName || result.user.email || 'Pengguna Google',
          picture: result.user.photoURL || undefined,
          sub: result.user.uid,
        };
        notifyListeners();
        return {
          accessToken: cachedAccessToken,
          user: currentGoogleUser,
          profile: currentProfile,
        };
      }
    } catch (fbErr: any) {
      console.warn('Firebase signInWithPopup failed, trying GIS fallback:', fbErr);
      lastError = fbErr;

      // If user deliberately closed the popup, don't spam them with GIS
      if (fbErr.code === 'auth/popup-closed-by-user') {
        throw new Error('Jendela masuk Google ditutup oleh pengguna.');
      }
    }

    // Strategy 2: Fallback to Google Identity Services (GIS) Token Client
    try {
      const gisResult = await requestTokenViaGIS();
      if (gisResult?.accessToken) {
        return {
          accessToken: gisResult.accessToken,
          user: currentGoogleUser,
          profile: currentProfile,
        };
      }
    } catch (gisErr: any) {
      console.warn('GIS Token client failed as well:', gisErr);
      lastError = gisErr;
    }

    // If both failed, handle friendly message
    if (lastError) {
      if (lastError.code === 'auth/popup-blocked') {
        throw new Error(
          'Jendela masuk Google diblokir oleh peramban (browser). Izinkan pop-up untuk situs ini lalu coba lagi.'
        );
      }
      if (lastError.code === 'auth/unauthorized-domain') {
        throw new Error(
          'Domain aplikasi ini belum diizinkan pada konsol Firebase. Silakan hubungi pengembang.'
        );
      }
      throw new Error(
        lastError.message ||
          'Gagal menghubungkan akun Google. Pastikan perizinan Google Drive disetujui.'
      );
    }

    throw new Error('Tidak ada token yang diterima dari Google.');
  } finally {
    isSigningIn = false;
  }
};

/**
 * Returns currently valid in-memory token (or null if missing/expired)
 */
export const getGoogleAccessToken = (): string | null => {
  if (!cachedAccessToken) return null;
  // Google tokens typically last 3600 seconds (1 hour). We consider 55 minutes valid.
  const elapsed = Date.now() - tokenAcquiredAt;
  if (tokenAcquiredAt > 0 && elapsed > 55 * 60 * 1000) {
    cachedAccessToken = null;
    notifyListeners();
    return null;
  }
  return cachedAccessToken;
};

/**
 * Manually set an access token (e.g. if refreshed)
 */
export const setCachedAccessToken = (token: string, profile?: GoogleUserProfile) => {
  cachedAccessToken = token;
  tokenAcquiredAt = Date.now();
  if (profile) currentProfile = profile;
  notifyListeners();
};

export const hasActiveGoogleToken = (): boolean => {
  return !!getGoogleAccessToken();
};

export const getCurrentGoogleUser = (): User | null => {
  return currentGoogleUser;
};

export const getCurrentGoogleProfile = (): GoogleUserProfile | null => {
  return currentProfile;
};

/**
 * Sign out and clear in-memory tokens
 */
export const signOutGoogle = async (): Promise<void> => {
  try {
    await signOut(auth);
  } finally {
    cachedAccessToken = null;
    tokenAcquiredAt = 0;
    currentGoogleUser = null;
    currentProfile = null;
    notifyListeners();
  }
};
