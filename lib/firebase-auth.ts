import { getAuth } from "firebase/auth";

import { firebaseApp } from "@/lib/firebase";

export const auth = getAuth(firebaseApp);
