import express from "express";
import bodyParser from "body-parser";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();

const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || "private-key.pem";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim()
  ? process.env.PRIVATE_KEY.replace(/\\n/g, "\n")
  : fs.readFileSync(path.resolve(PRIVATE_KEY_PATH), "utf8");
const GITHUB_APP_ID = Number(process.env.APP_ID);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const CONTROL_REPO_OWNER = process.env.CONTROL_REPO_OWNER;
const CONTROL_REPO_NAME = process.env.CONTROL_REPO_NAME;
const CONTROL_WORKFLOW_ID = process.env.CONTROL_WORKFLOW_ID || "control-suite.yaml";
const CONTROL_WORKFLOW_REF = process.env.CONTROL_WORKFLOW_REF || "main";

console.log("APP_ID:", GITHUB_APP_ID);
console.log("WEBHOOK_SECRET set:", Boolean(WEBHOOK_SECRET));
console.log("Private key source:", process.env.PRIVATE_KEY?.trim() ? "PRIVATE_KEY environment variable" : path.resolve(PRIVATE_KEY_PATH));
console.log(
  "CONTROL workflow configured:",
  Boolean(CONTROL_REPO_OWNER && CONTROL_REPO_NAME && CONTROL_WORKFLOW_ID && CONTROL_WORKFLOW_REF),
);

// Logs all hits before JSON parsing/signature verification.
app.use((req, res, next) => {
  console.log(`[IN] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(bodyParser.json({ verify: verifySignature }));

function verifySignature(req, res, buf) {
  const signature = req.headers["x-hub-signature-256"];

  // Non-GitHub/manual tests may not include signature.
  if (!signature) return;

  if (!WEBHOOK_SECRET) {
    throw new Error("WEBHOOK_SECRET is missing");
  }

  const hmac = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(buf)
    .digest("hex");

  const expected = `sha256=${hmac}`;
  if (signature !== expected) {
    throw new Error("Invalid signature");
  }
}

const githubApp = new App({
  appId: GITHUB_APP_ID,
  privateKey: PRIVATE_KEY,
  Octokit,
});

function parseTestPilotChoice(rawComment) {
  const comment = (rawComment || "").trim();
  if (!comment.startsWith("/testpilot")) return null;
  const rawChoice = comment.split(/\s+/)[1]?.toLowerCase() || null;
  if (!rawChoice) return null;
  if (rawChoice === "targeted") return "suggested";
  return rawChoice;
}

function ensureControlWorkflowConfig() {
  if (!CONTROL_REPO_OWNER || !CONTROL_REPO_NAME || !CONTROL_WORKFLOW_ID || !CONTROL_WORKFLOW_REF) {
    throw new Error(
      "Missing CONTROL workflow env vars. Set CONTROL_REPO_OWNER, CONTROL_REPO_NAME, CONTROL_WORKFLOW_ID, CONTROL_WORKFLOW_REF.",
    );
  }
}

async function resolvePrHeadSha(octokit, owner, repo, prNumber, payload) {
  const webhookSha = payload?.pull_request?.head?.sha;
  if (webhookSha) return webhookSha;

  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return pr.data.head.sha;
}

async function dispatchControlWorkflow({
  installationId,
  customerOwner,
  customerRepo,
  prNumber,
  mode,
  source,
  actor,
  payload,
}) {
  ensureControlWorkflowConfig();

  if (!installationId) {
    throw new Error("Missing installation ID in webhook payload.");
  }

  if (!["suggested", "full"].includes(mode)) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const headSha = await resolvePrHeadSha(octokit, customerOwner, customerRepo, prNumber, payload);

  await octokit.actions.createWorkflowDispatch({
    owner: CONTROL_REPO_OWNER,
    repo: CONTROL_REPO_NAME,
    workflow_id: CONTROL_WORKFLOW_ID,
    ref: CONTROL_WORKFLOW_REF,
    inputs: {
      customer_owner: customerOwner,
      customer_repo: customerRepo,
      installation_id: String(installationId),
      pr_number: String(prNumber),
      head_sha: headSha,
      mode,
      source,
      actor: actor || "unknown",
    },
  });

  console.log(
    `Dispatched ${CONTROL_WORKFLOW_ID} for ${customerOwner}/${customerRepo}#${prNumber} mode=${mode} source=${source}`,
  );
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/github/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];
  const payload = req.body;

  console.log("Event:", event);
  console.log("Action:", payload?.action);

  try {
    if (
      event === "pull_request" &&
      ["opened", "reopened", "synchronize"].includes(payload?.action)
    ) {
      await dispatchControlWorkflow({
        installationId: payload?.installation?.id,
        customerOwner: payload?.repository?.owner?.login,
        customerRepo: payload?.repository?.name,
        prNumber: payload?.pull_request?.number,
        mode: "suggested",
        source: `pull_request:${payload?.action}`,
        actor: payload?.sender?.login,
        payload,
      });
    }

    if (event === "issue_comment" && payload?.action === "created") {
      if (payload.issue?.pull_request) {
        const choice = parseTestPilotChoice(payload.comment?.body);
        if (choice === "suggested" || choice === "full") {
          await dispatchControlWorkflow({
            installationId: payload?.installation?.id,
            customerOwner: payload?.repository?.owner?.login,
            customerRepo: payload?.repository?.name,
            prNumber: payload?.issue?.number,
            mode: choice,
            source: "issue_comment",
            actor: payload?.comment?.user?.login,
            payload,
          });
        } else if (choice) {
          console.error("Invalid /testpilot choice:", choice);
        }
      }
    }

    if (
      event === "pull_request_review_comment" &&
      payload?.action === "created"
    ) {
      const choice = parseTestPilotChoice(payload.comment?.body);
      if (choice === "suggested" || choice === "full") {
        await dispatchControlWorkflow({
          installationId: payload?.installation?.id,
          customerOwner: payload?.repository?.owner?.login,
          customerRepo: payload?.repository?.name,
          prNumber: payload?.pull_request?.number,
          mode: choice,
          source: "pull_request_review_comment",
          actor: payload?.comment?.user?.login,
          payload,
        });
      } else if (choice) {
        console.error("Invalid /testpilot choice:", choice);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.sendStatus(500);
  }
});

// Catches JSON parse and signature errors from body-parser verify.
app.use((err, req, res, next) => {
  console.error("Pre-route middleware error:", err.message);
  if (err.message === "Invalid signature") {
    return res.status(401).send("Invalid webhook signature");
  }
  res.status(400).send("Bad request");
});

app.listen(3000, () => {
  console.log("TestPilot App listening on port 3000");
});
