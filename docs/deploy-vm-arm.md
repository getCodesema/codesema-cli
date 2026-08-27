# Deploying an arm on a VM

Arm mode runs `codesema brain serve` unattended on a machine you do not sit
in front of, connected to a brain (today: the codesema.com production
brain), working one repository around the clock. This is the runbook for
standing one up: first as a local rehearsal VM (multipass), later — once the
gate below is lifted — on a real server, from the exact same artifact.

The provisioning content lives in `packages/cli/assets/deploy/`:

- `cloud-init.yaml.example` — the full cloud-init file. Copy it to
  `cloud-init.local.yaml` (gitignored) and fill in every `__PLACEHOLDER__`.
- `brain.env.example` — the three secrets `cloud-init.local.yaml` needs, with
  one line each on where to mint them.

## Security gate

**Local VM only, for now.** This runbook's steps 1-7 and their local-VM
checks are safe to run today: the VM is outbound-only on your own machine,
so the blast radius of anything going wrong is near zero.

**Step 8 (a real, internet-facing server) is gated.** The order channel a
brain uses to tell an arm to ship or reply to a task has no signature or
confirmation yet, and there is no kill switch to cut an arm off. Exposing a
24/7 arm on a machine you do not control physical access to, before that
hardening lands, means an attacker who reaches the brain's order channel
reaches your server. Do not run step 8 until that work has shipped.

## Prerequisites

- **On your workstation:** `/dev/kvm` present, and `multipass` (`sudo snap
install multipass`). `codesema` and `claude` installed globally (both are
  needed only to mint tokens below, not to run the arm itself).
- **A GitHub personal access token** with `repo` scope, for the bench
  repository the arm will clone and push to.
- **codesema.com prod reachable and current.** `curl -s -o /dev/null -w
'%{http_code}\n' https://codesema.com/health` must print `200` — the
  route runs pending migrations before it starts listening, so a `200` is
  proof the deployed backend is current, not just alive. If it is not
  deployed yet, deploy it first (Dokploy) and re-check.
- **The bench repository already registered** in your codesema.com account
  (connected through the dashboard's GitHub integration).

## 1. Mint a brain token against prod

`codesema brain connect` takes a token in the form
`csk_<workspaceId>.<secret>` — the same shape `codesema sync`/`codesema
link` already use, minted the same way, in a scratch config directory so it
never touches your own workspace credentials:

```bash
mkdir -p /tmp/codesema-mint
CODESEMA_CONFIG_DIR=/tmp/codesema-mint codesema link
```

This asks for confirmation (a fresh anonymous workspace is being created),
then opens a browser tab; confirm it while logged into your real
codesema.com account, so this minted workspace links to your account. Once
the CLI prints "linked":

```bash
WORKSPACE_ID=$(node -p "require('/tmp/codesema-mint/config.json').syncWorkspaceId")
SECRET=$(node -p "require('/tmp/codesema-mint/config.json').syncSecret")
echo "csk_${WORKSPACE_ID}.${SECRET}"   # → CODESEMA_BRAIN_TOKEN
rm -rf /tmp/codesema-mint
```

Copy the printed value into `brain.env`'s `CODESEMA_BRAIN_TOKEN` (or
straight into `cloud-init.local.yaml`), then clear your terminal scrollback.

## 2. Generate the other two tokens

```bash
claude setup-token
```

Prints a long-lived (about one year) OAuth token scoped to inference only —
paste it as `CLAUDE_CODE_OAUTH_TOKEN`.

For `GH_TOKEN`, create a classic personal access token with `repo` scope
from your GitHub account settings.

## 3. Fill in the templates

```bash
cp packages/cli/assets/deploy/cloud-init.yaml.example packages/cli/assets/deploy/cloud-init.local.yaml
```

Edit `cloud-init.local.yaml` and replace:

- the three `__PLACEHOLDER__` values in the `/etc/codesema/brain.env`
  section, with the tokens from steps 1-2;
- `__CODESEMA_BENCH_REPO_URL__` in `provision.sh`, with the bench
  repository's HTTPS clone URL.

`cloud-init.local.yaml` and any `brain.env` are gitignored — this is the one
file in this workflow that ever holds real secrets.

## 4. Switch the repository to arm mode

In the codesema.com dashboard, open the bench repository's settings and
switch its execution mode from server to arm. This tells the brain to stop
waiting for its own scheduler on this repository and instead hand tickets to
whichever arm connects and claims them.

## 5. Launch the VM

```bash
cd packages/cli/assets/deploy
multipass launch 24.04 --name codesema-arm --cpus 2 --memory 4G --disk 20G \
  --cloud-init cloud-init.local.yaml
```

Provisioning runs on first boot and takes a few minutes (package installs,
the initial `node:26` pull). Progress is logged to
`/var/log/codesema-provision.log` inside the VM.

## 6. Verify

```bash
multipass shell codesema-arm
sudo tail -f /var/log/codesema-provision.log   # until it prints "done"
sudo systemctl --user -M codesema@ status codesema-brain.service
sudo journalctl --user -M codesema@ -u codesema-brain.service -f
```

From your workstation, `codesema brain status` (run against the same
account you linked in step 1) should list the bench repository with a
recent heartbeat once the arm has claimed a ticket.

## Troubleshooting

- **`systemctl --user -M codesema@ …` fails with "Failed to connect to
  bus".** Linger was not enabled or logind has not caught up yet:
  `sudo loginctl enable-linger codesema`, wait a few seconds for
  `/run/user/$(id -u codesema)` to exist, retry.
- **`podman info` fails rootless (`newuidmap: not found` or a userns
  error).** Confirm `uidmap` is installed and codesema has a subuid/subgid
  range: `grep codesema /etc/subuid /etc/subgid`. If either is empty:
  `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 codesema`,
  then `sudo -u codesema podman system migrate`.
- **Rootless podman will not come up at all (locked-down kernel, no
  unprivileged user namespaces).** Fallback: install `docker.io` instead and
  add `codesema` to the `docker` group. This is a real trade-off, not a free
  substitution: the `docker` group is root-equivalent, so it gives up the "no
  privileged group" property this runbook otherwise holds to. Only take this
  path if rootless podman is provably unavailable, and say so in your
  provisioning notes.
- **`codesema brain serve` exits immediately.** `WorkingDirectory` in the
  unit must be a git clone, not an empty directory — check the clone step's
  log in `/var/log/codesema-provision.log`.

## 7. A real server (gated — see above)

Once the order-channel hardening has shipped, the same `cloud-init.local.yaml`
targets a real VPS unchanged: hand it to the provider's cloud-init field at
creation time instead of `multipass launch --cloud-init`. Nothing else in
this runbook changes.
