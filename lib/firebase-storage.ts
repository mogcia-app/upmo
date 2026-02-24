import { getStorage } from "firebase/storage";

import { firebaseApp } from "@/lib/firebase";

export const storage = getStorage(firebaseApp);
