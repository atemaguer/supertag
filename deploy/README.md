# Deployment files

This directory owns the configuration and build files for hosting SuperTag's Control Plane and
the base image for Workspace sandboxes.
Follow the [deployment setup guide](../docs/guides/deployment-setup.md) for the shared CLI workflow.

The native services (separate Control Plane, Gateway, and Worker Hosts) use the definitions in
[`native/`](native/README.md), `compose.native.yaml`, `compose.native.ingress.yaml`, and the
Render, Cloudflare, and Modal directories.

```text
deploy/
  shared/                 TypeScript templates' runtime and environment contract (private package)
  generate.ts             Native manifest generator and drift check
  docker/
    Dockerfile            Shared Control Plane image; build context is the repository root
    Dockerfile.dockerignore
    entrypoint.sh
    worker/Dockerfile     Base image for Workspace sandboxes
  compose.yaml            Local self-hosting with PostgreSQL and persistent volumes
  .env.example            Environment template for self-hosting
  railway/railway.json    Railway service configuration
  fly/fly.toml            Fly Machine, release migration, volume, and HTTPS checks
  native/                 Native services: Compose notes, Fly.io, and Railway
  render/render.yaml      Native services: Render Blueprint (WebSocket tunnel)
  modal/app.py            Native services: Modal app (WebSocket tunnel) and pinned Modal client
  cloudflare/             Native services: tunnel Worker, Wrangler configuration, container image
```

From the repository root:

```sh
pnpm deploy:generate
pnpm deploy:check
docker build -f deploy/docker/Dockerfile -t supertag:local .
cp deploy/.env.example .env
# Populate .env with generated secrets before using Compose.
docker compose --env-file .env -f deploy/compose.yaml config --quiet
```

The ignore rules live in `docker/Dockerfile.dockerignore`, keeping local secrets and build
outputs out of the repository-root build context. A root `.dockerignore` symlink points to those
same rules for builders that do not discover the Dockerfile-specific ignore file.
Do not change the build context to `deploy/`:
the image needs the application and workspace packages.

The Workspace base image builds with `docker build -t supertag-worker-base:local deploy/docker/worker`.
Its build context contains only the image recipe. The
[Worker image workflow](../.github/workflows/publish-worker-base.yml) rebuilds it when the recipe
changes on `main` and publishes Linux AMD64 and ARM64 images to GitHub Container Registry. It
tags the image `latest` and `sha-<full commit SHA>`. Run the workflow manually on `main` to
rebuild after an upstream base image update.

GitHub creates the package as private on first publication. When the image is ready for
anonymous use, set the package visibility to Public in GitHub Packages and verify a pull from
a machine without registry credentials. See the user guide for extending the image and
configuring it on a Worker Host. [Build a Workspace image](../docs/guides/modal-workers.md#build-a-workspace-image)

Set Railway's Config File to `/deploy/railway/railway.json`, leaving the service root at the
repository root. Set Render's Blueprint Path to `deploy/render/render.yaml`. Existing services
must update these settings when adopting this layout; there are no duplicate root manifests.

Compose explicitly uses project name `supertag` to preserve the normal existing volume names.
If an existing installation used another project name, retain it with `COMPOSE_PROJECT_NAME` or
`-p` when using the relocated Compose file. The local `.env` stays at the repository root.

Cloudflare tooling runs from `deploy/cloudflare`. The package under `shared/` is internal, is
never published, and serves only the TypeScript Railway and Fly.io definitions and the TypeScript
CLI's `setup deployment --platform railway|fly`.
Test fixture images and example applications keep their Dockerfiles with their respective code.

## Choose a host

| Target | Compute | Durable state | Start here |
| --- | --- | --- | --- |
| Docker Compose | Your own server | PostgreSQL and local volumes | [Self-hosting](../docs/guides/self-hosting.md) |
| Railway | One service | PostgreSQL and attached volume | [Railway](railway/README.md) |
| Render (native) | Control Plane web service, optional Gateway worker | PostgreSQL and attached disks | [Render](render/README.md) |
| Fly.io | One always-on Machine | PostgreSQL and attached volume | [Fly.io](fly/README.md) |
| Modal (native) | One always-on container | External PostgreSQL, a Modal Volume, and Vault | [Modal](modal/README.md) |
| Cloudflare (native) | Worker plus one Container | External PostgreSQL and Vault | [Cloudflare](cloudflare/README.md) |

Hosting the Control Plane and supplying Worker Hosts are independent choices. Modal sandbox
execution support does not require a Modal-hosted Control Plane. The Compose, Railway, and Fly.io
targets here start the Node application; Render, Modal, and Cloudflare run the native services
from the `hosted` image. Provider adapters own only provisioning, ingress, lifecycle, and
configuration.

Fly builds the common Dockerfile by default and accepts a published image with `--image`. Render,
Modal, and Cloudflare deploy the native `hosted` image by digest. Never bake deployment credentials
into an image.

When adding a target, include its adapter/configuration, a README linking to the public guide,
shared environment validation, migration and single-instance behavior, health and reconnection
checks, and explicit teardown instructions. Keep generated values in `generate.ts` and run the
drift check. After disposable live tests, remove their compute and dedicated storage and verify
cleanup; stopping compute alone may leave billable resources.

The deployment menu and thin-adapter approach are informed by
[Omnigent's deployment layout](https://github.com/omnigent-ai/omnigent/tree/main/deploy).
