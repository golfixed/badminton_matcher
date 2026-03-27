import { initializeApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';

export let firebaseDb: Database | null = null;

const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined;

if (databaseURL) {
  try {
    const app = initializeApp({
      apiKey:      import.meta.env.VITE_FIREBASE_API_KEY as string,
      authDomain:  import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
      databaseURL,
      projectId:   import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
      appId:       import.meta.env.VITE_FIREBASE_APP_ID as string,
    });
    firebaseDb = getDatabase(app);
  } catch (e) {
    console.warn('[Firebase] init failed — falling back to localStorage only');
  }
}

export const FIREBASE_READY = firebaseDb !== null;
