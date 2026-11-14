# Self-host SuperTag

Run one shared, always-on **Control Plane**, the service that stores your organization and
schedules its work, so teammates can direct the same Tags and lend their machines as **Worker
Hosts**, the machines that run the work. A Tag is a persistent AI actor with its own
responsibilities and permissions. See the [glossary](../reference/glossary.md) for other terms.

A deployment has up to three roles:

| Role | Reachability | State |
| --- | --- | --- |
| Control Plane | The one public endpoint, for operators, Worker Hosts, and Gateways. It terminates its own TLS and speaks gRPC | PostgreSQL, and a volume for transfer files such as Session checkpoints and workspace bundles |
| **Gateway** (optional) | No public API: it connects to the Control Plane as a client. It receives collaboration surface webhooks through your reverse proxy, delivers replies, and sends operator notifications | A volume for connector state and the file credential vault, or HashiCorp Vault |
| Worker Hosts | Outbound only | Each host's own state directory |

Deploy the Gateway only when you connect Slack, GitHub, Linear, Lark, or Microsoft Teams, or send
operator notifications. The Control Plane never stores artifact bytes; they stay on Worker Hosts
and the Volumes you map.

## Before you start

- The `supertag` CLI on your machine; see [Install SuperTag](../operations/install.md).
- A host name for the Control Plane and a TLS certificate that names it. A platform host name
  such as `*.onrender.com` cannot carry a publicly trusted certificate for SuperTag's own TLS;
  issue one from your own certificate authority as
  [Issue certificates from your own CA](../../deploy/native/README.md#issue-certificates-from-your-own-ca)
  shows.
- PostgreSQL for every platform except Compose, which runs its own, and Render, whose Blueprint
  creates one.
- The `hosted` container image, for every platform except Compose. See
  [Build the hosted image](../../deploy/native/README.md#build-the-hosted-image).

## 1. Choose a platform

| Platform | How clients reach the Control Plane | Guide |
| --- | --- | --- |
| Docker Compose on your own server | Native gRPC on a published port | [Below](#docker-compose) |
| Fly.io | Native gRPC through a raw TCP service | [Deploy on Fly.io](deploy-fly.md) |
| Railway | Native gRPC through a TCP Proxy | [Deploy on Railway](deploy-railway.md) |
| Render | The WebSocket tunnel, `wss://` | [Deploy on Render](deploy-render.md) |
| Cloudflare | The WebSocket tunnel, `wss://` | [Deploy on Cloudflare](deploy-cloudflare.md) |
| Modal | The WebSocket tunnel, `wss://` | [Deploy on Modal](deploy-modal.md) |

Render, Cloudflare, and Modal terminate TLS at their edge and forward only HTTP/1.1. There the
Control Plane carries gRPC inside a WebSocket, the **tunnel**, and runs its own TLS end to end
inside it, so the platform sees only ciphertext. Clients use the `wss://` URL wherever this page
shows `https://`.

## 2. Prepare and check the configuration

Every platform shares one workflow. See [Configure a deployment](deployment-setup.md) for what
each file holds.

```sh
export SUPERTAG_DATABASE_URL='postgresql://supertag@db.example.com/supertag'  # not for Compose or Render
supertag setup deployment compose --output supertag-deployment
supertag check deployment compose --directory supertag-deployment
```

Setup writes `control-plane.env`, `gateway.env`, and `operator.env`, each readable only by you.
It generates the Gateway's credential and the admin **Operator Token** in `operator.env`, and
prints the next steps for the platform. Upload the files through your platform's secret
controls.

## 3. Deploy

### Docker Compose

On your server, with the images and the TLS directories in place:

```sh
export SUPERTAG_CONTROL_IMAGE=REGISTRY/supertag-control-plane@sha256:DIGEST
export SUPERTAG_GATEWAY_IMAGE=REGISTRY/supertag-gateway@sha256:DIGEST
export SUPERTAG_POSTGRES_ENV_FILE=$PWD/supertag-deployment/postgres.env
export SUPERTAG_CONTROL_ENV_FILE=$PWD/supertag-deployment/control-plane.env
export SUPERTAG_GATEWAY_ENV_FILE=$PWD/supertag-deployment/gateway.env
export SUPERTAG_CONTROL_TLS_DIRECTORY=$PWD/tls/control-plane
export SUPERTAG_GATEWAY_TLS_DIRECTORY=$PWD/tls/gateway
export SUPERTAG_CONTROL_PLANE_PUBLISH=0.0.0.0:443
docker compose -f deploy/compose.native.yaml -f deploy/compose.native.ingress.yaml up -d --wait
```

Add `--profile gateway` to also run the Gateway. The files and TLS layout are described in
[Docker Compose](../../deploy/native/README.md#docker-compose).

For the other platforms, follow their guide from [the table](#1-choose-a-platform).

## 4. Verify

```sh
supertag verify deployment https://supertag.example.com \
  --env-file supertag-deployment/operator.env
```

Set `SUPERTAG_SERVER_CA_FILE` to your CA when the certificate comes from your own CA.
Verification checks gRPC health, that anonymous calls and invalid credentials are refused, and
that the operator token works. It reports `not ready` until a Worker Host connects.

## 5. Connect your CLI

Save the Control Plane under a name with the admin Operator Token from `operator.env`:

```sh
supertag connect https://supertag.example.com --name team
```

Paste the token at the masked prompt. Commands, the terminal UI, and the desktop app then use
`--control-plane team`.

## 6. Connect a Worker Host

Create a host **Auth Key**, a short-lived secret that enrolls one machine, for the Tags the host
may run:

```sh
supertag auth-key create build-1 --role host --tag lead --control-plane team
```

On the Worker Host, save the printed key to a private file and add a host service to
`~/.supertag/supertag.yaml`:

```yaml
services:
  build-1:
    type: host
    control-plane: https://supertag.example.com
    auth-key: build-1-key
    harnesses: [codex]
    workspaces:
      app: ~/code/app
    restart: unless-stopped
secrets:
  build-1-key: { file: ~/build-1.key }
```

```sh
supertag up
rm ~/build-1.key
```

The first `supertag up` enrolls the host and keeps its own credential in its state directory, so
later runs ignore the key. To run a host without `supertag.yaml`, use `supertag host enroll` and
`supertag worker-host`; see [Run Worker Hosts](workers.md).

## Add teammates

Keep the admin token to yourself. Each teammate gets the secrets for what they do:

| Secret | Lets them | Create it with |
| --- | --- | --- |
| A client Auth Key | Connect their CLI, terminal UI, or desktop app as their own device | `supertag auth-key create NAME --role client --tag TAG` |
| An Operator Token | Run operator commands, recorded under the token's name | `supertag operator-token create NAME` |
| A host Auth Key | Join their computer as a Worker Host | `supertag auth-key create NAME --role host --tag TAG` |

Each command prints its secret once. Send it over a private channel. A teammate connects with
`supertag connect https://supertag.example.com --name team` and pastes the secret. A client Auth
Key enrolls their device as `client:NAME` and saves only the device's own credential.

To end access, revoke what you issued:

```sh
supertag operator-token revoke laptop-2 --control-plane team
supertag client revoke laptop-2 --control-plane team
supertag host revoke laptop-2 --control-plane team
```

`supertag audit` lists every operator change with the actor that made it.

## Manage your organization from CI

Keep your manifests in a repository and let CI apply them. Give CI its own Operator Token, so
its changes are recorded under its name:

```sh
supertag operator-token create ci --control-plane team
```

Store the secret as a CI secret named `SUPERTAG_OPERATOR_TOKEN`, install the CLI, and run:

```sh
# On each pull request: show what would change
supertag diff -f org/ --set org --prune --control-plane https://supertag.example.com
# After merging: apply it
supertag apply -f org/ --set org --prune --control-plane https://supertag.example.com
```

`--set org` names the resources these manifests own. With `--prune`, apply deletes a resource in
the set once you remove it from the files, and it never touches resources created another way.
An Operator Token expires 90 days after it is created or rotated; rotate it with
`supertag operator-token rotate ci`. See [Manage Control Plane resources](../operations/resources.md).

## Moving from a local setup

SuperTag has no command that copies a local Control Plane's state into a shared one. Apply your
manifests to the shared Control Plane, repeat collaboration surface setup there, and stop the
local services with `supertag down` so only one Control Plane uses the same surface app. Then
point your host service at the shared Control Plane as in
[Connect a Worker Host](#6-connect-a-worker-host).

## If something goes wrong

- **Verification cannot reach the Control Plane over TLS.** Check that `SUPERTAG_SERVER_CA_FILE`
  names your CA and that the certificate names the host in the URL.
- **Readiness stays `not ready`.** No Worker Host is connected. Check `supertag get host` and the
  host's `supertag logs`.
- **A mention gets no reply.** Work through [Troubleshoot the first reply](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md) for health, backups, upgrades, and
  secret boundaries
- [Run Worker Hosts](workers.md)
- [Connect a collaboration surface](../surfaces/README.md)
