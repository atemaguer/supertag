# Deploy the Control Plane on Modal

A **Tag** is a persistent AI actor with its own responsibilities and permissions, and Tags work
in Teams: flat lists of member Tags. Together, your Teams of Tags make up an **autonomous organization**: Teams
may pursue different goals but share one set of rules and one record of the work. Run the **Control
Plane** (the service that stores and coordinates a SuperTag organization) as one always-on Modal
Server built from its standard Node.js image. A **Worker Host** provides execution capacity, and its
**Worklet** connects outbound over HTTPS/WebSocket. Hosting the Control Plane on Modal is
independent of using Modal sandboxes as Worker Hosts; you can use either without the other. See the
[glossary](../reference/glossary.md) for other terms.

## Before you start

- The installed `supertag` CLI, matching the release you deploy (`supertag --version`).
- A checkout of the repository; run the commands below from its root.
- A Python environment for the Modal deployment SDK.
- Externally reachable PostgreSQL and HashiCorp Vault KV v2, with database and Vault network access
  configured for the Modal deployment. See [Limits](#limits) for why external storage is required.
- Familiarity with the shared [deployment setup workflow](deployment-setup.md); step 3 runs it.

## 1. Install the Modal SDK

Install the pinned deployment SDK and authenticate:

```sh
python -m pip install -r deploy/modal/requirements.txt
modal setup
```

By default, Modal builds `deploy/docker/Dockerfile` from your checkout, then adds Python for its
supervisor. No registry is required. To deploy a prebuilt image instead, see
[Optional: deploy a prebuilt image](#optional-deploy-a-prebuilt-image).

## 2. Choose App and Secret names

Choose unique App and Secret names, especially for a disposable test:

```sh
export SUPERTAG_MODAL_APP=supertag-control-plane
export SUPERTAG_MODAL_SECRET=supertag-control-plane
```

## 3. Prepare the environment and Secret

```sh
supertag setup deployment --platform modal
supertag check deployment --platform modal --env-file .env.deployment
modal secret create "$SUPERTAG_MODAL_SECRET" --from-dotenv .env.deployment
```

Setup prompts for the PostgreSQL URL, administrative token, public coordination URL, Vault address
and token. All values are uploaded from the private
file, never as secret command arguments.

Use the HTTPS URL printed by Modal as `SUPERTAG_COORDINATION_URL`. On first deployment, if the URL
is not known yet, use `https://pending.invalid` during setup. Before connecting any Worklets or
accepting work, update that value in the private file to the actual URL, stop the App, replace the
Secret with `modal secret create "$SUPERTAG_MODAL_SECRET" --from-dotenv .env.deployment --force`,
and deploy again. To look up the URL later:

```sh
python -c 'import os, modal; print(modal.Server.from_name(os.environ["SUPERTAG_MODAL_APP"], "control-plane").get_url())'
```

## 4. Migrate and deploy

```sh
modal run deploy/modal/app.py::migrate
modal deploy deploy/modal/app.py::app
```

Migrations run in a separate temporary App, so invoking them does not start the Control Plane.
A migration failure stops the command; do not continue to deployment. The startup path checks
schema readiness and never silently runs migrations.

For updates, stop the serving App first (`modal app stop "$SUPERTAG_MODAL_APP"`), back up durable
storage, run the migration command, then deploy.

## 5. Connect your CLI and a Worklet

```sh
supertag verify deployment https://YOUR-MODAL-URL --env-file .env.deployment
supertag connect control-plane https://YOUR-MODAL-URL
supertag create auth-key build-host --tag engineering
```

Connect reads the administrative token from your environment or a masked prompt. The
[Auth Key](../reference/resource-model.md#auth-keys) prints a `stak_` secret once. On the Worker Host, set
it in `SUPERTAG_AUTH_KEY`, then follow [Run a Worker](workers.md). The host joins on its first
connection and is bound to the Tag. A **Worker** is the code on that host that completes the Tag's work. A Tag with no
bound Worker Host rejects every mention. This template uses WebSocket; see
[Choose the Worker connection](deployment-setup.md#choose-the-worker-connection).

## Check that it worked

```sh
supertag verify deployment https://YOUR-MODAL-URL --env-file .env.deployment --require-ready
```

After setting up a **collaboration surface** (an external work tool such as Slack where SuperTag
meets people) and Tag with the [collaboration surface guides](../surfaces/README.md), mention
the Tag in a connected Slack channel and confirm that a Worker replies. Test reconnection after
replacing the Server.

## Optional: add a supertag.yaml

The Control Plane starts with `supertag up --foreground control-plane`, so it also reads a
[`supertag.yaml`](../reference/supertag-yaml.md). The Modal Secret and the template's environment remain the main configuration and override
the file. Keep `SUPERTAG_DATABASE_URL`, `SUPERTAG_ADMIN_TOKEN`, and `SUPERTAG_COORDINATION_URL` there,
because the platform check reads them from the environment. A file suits settings such as `notify`,
`logging`, `operators.file`, or a `provision` list, which creates missing resources each time the
Control Plane starts; leave `ports` out.

Modal has no volume at `/var/lib/supertag`, so bake the file into the image there. In your
copy of the repository, add this line to `deploy/docker/Dockerfile` after
`COPY deploy/docker/entrypoint.sh`, then migrate and deploy as usual, or publish it as a [prebuilt image](#optional-deploy-a-prebuilt-image):

```dockerfile
COPY supertag.yaml /var/lib/supertag/supertag.yaml
```

See [In containers and hosting platforms](../reference/supertag-yaml.md#in-containers-and-hosting-platforms)
for the keys that behave differently in a container.

## Limits

- The template requires external credential storage because its local filesystem is temporary.
  It does not treat a Modal Volume as a directly attached POSIX disk for the credential vault.
  Artifact bytes (captured output files) stay on the Worker Hosts that capture them; the Control Plane stores none.
- The Server keeps one container warm even without incoming requests; it incurs ongoing usage.
  Do not increase its replica count.
- Stop-before-deploy updates avoid overlapping Control Planes and cause downtime.
- Modal's proxy accepts public requests so SuperTag's own authentication works; management and
  Worklet routes still require their SuperTag credentials.
- The supervisor checks `/healthz` during startup and forwards termination to the Node process.
  Modal subsequently checks the listening port; use external HTTP monitoring for ongoing `/healthz`
  and `/readyz` checks. See [Modal Servers](https://modal.com/docs/guide/servers) for lifecycle and
  routing behavior.

## Optional: deploy a prebuilt image

Publish the shared image to a registry you control:

```sh
docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile \
  -t YOUR-REGISTRY/supertag:YOUR-RELEASE --push .
export SUPERTAG_MODAL_IMAGE=YOUR-REGISTRY/supertag@sha256:YOUR-DIGEST
```

Use the digest reported by the registry. When `SUPERTAG_MODAL_IMAGE` is set, Modal pulls that image
instead of building the checkout. Both paths use the same Docker entrypoint. For a private registry,
create a Modal Secret containing `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` through the dashboard or
a private file, then set `SUPERTAG_MODAL_REGISTRY_SECRET` to that Secret's name.

## Optional: remove a test deployment

For a disposable test, stop its App and verify no containers remain. Delete its dedicated Secret
with `modal secret delete YOUR-TEST-SECRET`, and separately remove any test database, Vault namespace,
or registry image you created. Never delete shared services used by other deployments.

## If something goes wrong

- **Verification fails right after deployment.** Modal may return from deployment before the Server
  finishes starting. Wait for startup, then retry verification if liveness is not available yet.
- **`/readyz` returns unavailable.** This is expected until a compatible Worklet connects. See
  [Health and readiness](../operations/control-plane.md#health-and-readiness).
- **The Worklet cannot connect.** HTTPS Worklet addresses select gRPC unless you pass
  `--transport websocket`. See [Choose the Worker connection](deployment-setup.md#choose-the-worker-connection)
  and [Troubleshooting](troubleshooting.md).

## Next

- [Control Plane operations](../operations/control-plane.md)
- [Run a Worker](workers.md)
- [Run a Worker in Modal sandboxes](modal-workers.md)
