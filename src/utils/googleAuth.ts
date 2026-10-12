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

// Initialize Firebase safely (avoid duplicate app initialization)
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Provider with Google Drive scope
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive');
provider.setCustomParameters({
  prompt: 'select_account',
});

// Flag to track sign-in in progress
let isSigningIn = false;

// In-memory token cache (DO NOT store in localStorage per security guidelines)
let cachedAccessToken: string | null = null;
let currentGoogleUser: User | null = null;

type AuthCallback = (user: User | null, token: string | null) => void;
const listeners: Set<AuthCallback> = new Set();

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener(currentGoogleUser, cachedAccessToken);
    } catch (err) {
      console.error('Error in auth listener:', err);
    }
  });
}

/**
 * Initialize auth listener on application start
 */
export const initGoogleAuth = (
  onAuthChange?: (user: User | null, token: string | null) => void
): (() => void) => {
  if (onAuthChange) {
    listeners.add(onAuthChange);
    // Notify immediately with current state
    onAuthChange(currentGoogleUser, cachedAccessToken);
  }

  const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
    currentGoogleUser = user;
    if (!user) {
      cachedAccessToken = null;
    }
    notifyListeners();
  });

  return () => {
    if (onAuthChange) listeners.delete(onAuthChange);
    unsubscribe();
  };
};

/**
 * Sign in with Google Popup and obtain access token
 */
export const signInWithGoogle = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    if (!credential?.accessToken) {
      throw new Error(
        'Gagal memperoleh access token Google Drive dari autentikasi. Pastikan izin Drive disetujui.'
      );
    }

    cachedAccessToken = credential.accessToken;
    currentGoogleUser = result.user;
    notifyListeners();

    return {
      user: result.user,
      accessToken: cachedAccessToken,
    };
  } catch (error: any) {
    console.error('Google Sign-in Error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Get current active in-memory access token
 */
export const getGoogleAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

/**
 * Get current Google User
 */
export const getCurrentGoogleUser = (): User | null => {
  return currentGoogleUser;
};

/**
 * Sign out from Google Auth and clear in-memory cache
 */
export const signOutGoogle = async (): Promise<void> => {
  try {
    await signOut(auth);
  } finally {
    cachedAccessToken = null;
    currentGoogleUser = null;
    notifyListeners();
  }
};
