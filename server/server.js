import express from "express";
import bodyParser from "body-parser";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import crypto from "crypto";
import fs from "fs";

const app = express();

const PRIVATE_KEY = fs.readFileSync("private-key.pem", "utf8");
const GITHUB_APP_ID = Number(process.env.APP_ID);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

console.log("APP_ID:", GITHUB_APP_ID);
console.log("WEBHOOK_SECRET set:", Boolean(WEBHOOK_SECRET));

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
  return comment.split(/\s+/)[1]?.toLowerCase() || null;
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
    if (event === "issue_comment" && payload?.action === "created") {
      if (payload.issue?.pull_request) {
        const choice = parseTestPilotChoice(payload.comment?.body);
        if (choice === "targeted") {
          console.log("User selected targeted fast tests via slash");
        } else if (choice === "full") {
          console.log("User selected full tests via slash");
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
      if (choice === "targeted") {
        console.log("User selected targeted fast tests via inline comment");
      } else if (choice === "full") {
        console.log("User selected full tests via inline comment");
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
