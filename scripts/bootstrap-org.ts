import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args: Args, key: string): string {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function readCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return undefined;
  return cert(JSON.parse(raw));
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "npm run bootstrap:org -- \\",
      "  --orgId <org-id> \\",
      "  --ownerUid <uid> \\",
      "  --ownerEmail <email> \\",
      "  --ownerName <display-name> \\",
      "  [--orgName <organization-name>] \\",
      "  [--seatLimit 10] \\",
      "  [--projectId <firebase-project-id>]",
      "",
      "Auth options:",
      "- Set GOOGLE_APPLICATION_CREDENTIALS, or",
      "- Set FIREBASE_SERVICE_ACCOUNT_JSON (stringified service account JSON).",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printUsage();
    return;
  }

  const orgId = requireArg(args, "orgId");
  const ownerUid = requireArg(args, "ownerUid");
  const ownerEmail = requireArg(args, "ownerEmail");
  const ownerName = requireArg(args, "ownerName");
  const seatLimit = Number(args.seatLimit ?? "10");
  const orgName = args.orgName ?? orgId;

  if (!Number.isInteger(seatLimit) || seatLimit <= 0) {
    throw new Error("--seatLimit must be a positive integer");
  }

  const projectId = args.projectId ?? process.env.FIREBASE_PROJECT_ID;
  const credential = readCredentials();

  if (getApps().length === 0) {
    initializeApp({
      ...(projectId ? { projectId } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  const db = getFirestore();

  const orgRef = db.doc(`organizations/${orgId}`);
  const memberRef = db.doc(`organizations/${orgId}/members/${ownerUid}`);

  await db.runTransaction(async (tx) => {
    const now = FieldValue.serverTimestamp();

    tx.set(
      orgRef,
      {
        name: orgName,
        ownerId: ownerUid,
        seatLimit,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    tx.set(
      memberRef,
      {
        uid: ownerUid,
        email: ownerEmail,
        displayName: ownerName,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  });

  console.log("Bootstrap completed.");
  console.log(`Organization: organizations/${orgId}`);
  console.log(`Owner member: organizations/${orgId}/members/${ownerUid}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
});
