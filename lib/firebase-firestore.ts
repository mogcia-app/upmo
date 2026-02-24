import { getFirestore } from "firebase/firestore";

import { firebaseApp } from "@/lib/firebase";

export const db = getFirestore(firebaseApp);
