# Deployment files

This directory owns the configuration and build files for hosting SuperTag's Control Plane.
Follow the [deployment setup guide](../docs/guides/deployment-setup.md) for the shared CLI workflow.

```text
deploy/
  shared/                 Common runtime and environment contract (private workspace package)
  generate.ts             Native manifest generator and drift check
  docker/
    Dockerfile            Shared Control Plane image; build context is the repository root
    Dockerfile.dockerignore
    entrypoint.sh
  compose.yaml            Local self-hosting with PostgreSQL and persistent volumes
  .env.example            Environment template for self-hosting
  railway/railway.json    Railway service configuration
  render/render.yaml      Render Blueprint
  fly/fly.toml            Fly Machine, release migration, volume, and HTTPS checks
  modal/                  Modal Server adapter, generated runtime contract, and pinned Python SDK
  cloudflare/             Routing Worker, Wrangler configuration, and independent npm tooling
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
same rules because Wrangler's image build does not discover the Dockerfile-specific ignore file.
Do not change the build context to `deploy/`:
the image needs the application and workspace packages.

Set Railway's Config File to `/deploy/railway/railway.json`, leaving the service root at the
repository root. Set Render's Blueprint Path to `deploy/render/render.yaml`. Existing services
must update these settings when adopting this layout; there are no duplicate root manifests.

Compose explicitly uses project name `supertag` to preserve the normal existing volume names.
If an existing installation used another project name, retain it with `COMPOSE_PROJECT_NAME` or
`-p` when using the relocated Compose file. The local `.env` stays at the repository root.

Cloudflare tooling runs from `deploy/cloudflare`; the shared contract also remains bundled in
the published `supertag-ai` CLI. The package under `shared/` is internal and is never published.
Test fixture images and example applications keep their Dockerfiles with their respective code.

## Choose a host

| Target | Compute | Durable state | Start here |
| --- | --- | --- | --- |
| Docker Compose | Your own server | PostgreSQL and local volumes | [Self-hosting](../docs/guides/self-hosting.md) |
| Railway | One service | PostgreSQL and attached volume | [Railway](railway/README.md) |
| Render | One service | PostgreSQL and attached disk | [Render](render/README.md) |
| Fly.io | One always-on Machine | PostgreSQL and attached volume | [Fly.io](fly/README.md) |
| Modal | One always-on Server | External PostgreSQL and Vault | [Modal](modal/README.md) |
| Cloudflare | Worker plus one Container | External PostgreSQL and Vault | [Cloudflare](cloudflare/README.md) |

Hosting the Control Plane and supplying Worker Hosts are independent choices. Modal sandbox
execution support does not require a Modal-hosted Control Plane. Every target starts the same
Node application; provider adapters own only provisioning, ingress, lifecycle, and configuration.

Fly and Modal build the common Dockerfile by default. Fly accepts a published image with `--image`;
Modal accepts one through `SUPERTAG_MODAL_IMAGE`. Pin a digest when using a registry so migration
and serving containers run the same release. Never bake deployment credentials into the image.

When adding a target, include its adapter/configuration, a README linking to the public guide,
shared environment validation, migration and single-instance behavior, health and reconnection
checks, and explicit teardown instructions. Keep generated values in `generate.ts` and run the
drift check. After disposable live tests, remove their compute and dedicated storage and verify
cleanup; stopping compute alone may leave billable resources.

The deployment menu and thin-adapter approach are informed by
[Omnigent's deployment layout](https://github.com/omnigent-ai/omnigent/tree/main/deploy).
