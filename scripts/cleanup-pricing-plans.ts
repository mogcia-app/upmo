import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

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

function readCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return undefined;
  return cert(JSON.parse(raw));
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "npm run cleanup:pricing-plans -- [--apply] [--uid <user-uid>] [--projectId <firebase-project-id>]",
      "",
      "Options:",
      "--apply     Firestore を実際に更新する。未指定時は dry-run。",
      "--uid       特定ユーザー配下だけを対象にする。",
      "--projectId Firebase project id を明示する。",
      "",
      "Behavior:",
      "- users/{uid}/documents/* と users/{uid}/chats/{chatId}/documents/* を対象にする。",
      "- pricingPlans フィールドが存在すれば削除する。",
      "",
      "Auth options:",
      "- Set GOOGLE_APPLICATION_CREDENTIALS, or",
      "- Set FIREBASE_SERVICE_ACCOUNT_JSON (stringified service account JSON).",
    ].join("\n"),
  );
}

function isTargetDocumentPath(path: string, uidFilter?: string): boolean {
  const rootPattern = /^users\/([^/]+)\/documents\/[^/]+$/;
  const chatPattern = /^users\/([^/]+)\/chats\/[^/]+\/documents\/[^/]+$/;
  const rootMatch = path.match(rootPattern);
  const chatMatch = path.match(chatPattern);
  const uid = rootMatch?.[1] ?? chatMatch?.[1];
  if (!uid) return false;
  if (uidFilter && uid !== uidFilter) return false;
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printUsage();
    return;
  }

  const projectId = args.projectId ?? process.env.FIREBASE_PROJECT_ID;
  const credential = readCredentials();
  const apply = args.apply === "true";
  const uidFilter = args.uid;

  if (getApps().length === 0) {
    initializeApp({
      ...(projectId ? { projectId } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  const db = getFirestore();
  const snapshot = await db.collectionGroup("documents").get();

  let scanned = 0;
  let changed = 0;

  for (const docSnap of snapshot.docs) {
    if (!isTargetDocumentPath(docSnap.ref.path, uidFilter)) continue;

    scanned += 1;
    const data = docSnap.data();
    if (!Object.prototype.hasOwnProperty.call(data, "pricingPlans")) continue;

    changed += 1;
    console.log(`[match] ${docSnap.ref.path}`);

    if (apply) {
      await docSnap.ref.update({
        pricingPlans: FieldValue.delete(),
      });
    }
  }

  console.log(`Scanned documents: ${scanned}`);
  console.log(`Changed documents: ${changed}`);
  console.log(apply ? "Mode: apply" : "Mode: dry-run");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
});
