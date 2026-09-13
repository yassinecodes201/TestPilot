# TestPilot App Setup

## 1) Configure env
Copy `server/.env.example` values into your shell env.

PowerShell example:

```powershell
$env:APP_ID="<your_app_id>"
$env:WEBHOOK_SECRET="<your_webhook_secret>"
$env:PRIVATE_KEY_PATH="private-key.pem"

$env:CONTROL_REPO_OWNER="<owner>"
$env:CONTROL_REPO_NAME="<private-control-repo>"
$env:CONTROL_WORKFLOW_ID="control-suite.yaml"
$env:CONTROL_WORKFLOW_REF="main"
```

## 2) Start app

```powershell
cd server
npm start
```

## 3) Configure GitHub App webhook URL
Set webhook URL to:

`https://<your-domain>/github/webhook`

Also subscribe webhook events to include:
- `Pull request`
- `Issue comment`
- `Pull request review comment`

## 4) Trigger flow
- Open/reopen/update PR -> app dispatches `control-suite.yaml` with `mode=suggested`.
- Comment on the PR or inline review comment:
  - `/testpilot suggested`
  - `/testpilot full`
- App dispatches `control-suite.yaml` in your control repo.
