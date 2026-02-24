import { getApp, getApps, initializeApp } from "firebase/app";

const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;

const missingEnvVars = [
  ["NEXT_PUBLIC_FIREBASE_API_KEY", apiKey],
  ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", authDomain],
  ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", projectId],
  ["NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", storageBucket],
  ["NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", messagingSenderId],
  ["NEXT_PUBLIC_FIREBASE_APP_ID", appId],
]
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Missing required Firebase env var(s): ${missingEnvVars.join(", ")}`,
  );
}

const firebaseConfig = {
  apiKey,
  authDomain,
  projectId,
  storageBucket,
  messagingSenderId,
  appId,
};

export const firebaseApp = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);
