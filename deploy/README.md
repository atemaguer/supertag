# Deployment files

This directory owns the container images and platform definitions for SuperTag's native
services: a Control Plane, an optional Gateway for collaboration surfaces, and Worker Hosts. It
also owns the base image for Workspace sandboxes.
Follow [Configure, check, and verify](native/README.md#configure-check-and-verify) for the shared CLI workflow.

```text
deploy/
  docker/
    rust-service.Dockerfile   Native service images (control-plane, gateway, hosted targets)
    rust-release.Dockerfile   Linux native release builder
    rust-hosted-entrypoint.sh Hosted-image entrypoint: prepares state and TLS, then drops root
    rust-hosted-pair.sh       Runs a Control Plane and a Gateway in one hosted container
    worker/Dockerfile         Base image for Workspace sandboxes
  compose.native.yaml         Docker Compose: PostgreSQL, Control Plane, optional Gateway
  compose.native.ingress.yaml Compose ingress overlay
  native/                     Compose notes, Fly.io, and Railway
  render/render.yaml          Render Blueprint (WebSocket tunnel)
  modal/app.py                Modal app (WebSocket tunnel) and pinned Modal client
  cloudflare/                 Tunnel Worker, Wrangler configuration, container image
```

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

Set Render's Blueprint Path to `deploy/render/render.yaml`. Cloudflare tooling runs from
`deploy/cloudflare` with its own `npm ci`. Test fixture images keep their Dockerfiles with their
respective code.

## Choose a host

| Target | Compute | Durable state | Start here |
| --- | --- | --- | --- |
| Docker Compose | Your own server | PostgreSQL and local volumes | [Native services](native/README.md) |
| Fly.io | Control Plane and optional Gateway apps | PostgreSQL and attached volumes | [Native services](native/README.md) |
| Railway | Control Plane and optional Gateway services | PostgreSQL and attached volumes | [Native services](native/README.md) |
| Render | Control Plane web service, optional Gateway worker | PostgreSQL and attached disks | [Render](render/README.md) |
| Modal | One always-on container | External PostgreSQL, a Modal Volume, and Vault | [Modal](modal/README.md) |
| Cloudflare | Worker plus one Container | External PostgreSQL and Vault | [Cloudflare](cloudflare/README.md) |

Hosting the Control Plane and supplying Worker Hosts are independent choices. Modal sandbox
execution support does not require a Modal-hosted Control Plane. Render, Modal, and Cloudflare
run the native services from the `hosted` image by digest. Provider adapters own only
provisioning, ingress, lifecycle, and configuration. Never bake deployment credentials into an
image.

When adding a target, include its adapter/configuration, a README linking to the public guide,
shared environment validation, migration and single-instance behavior, health and reconnection
checks, and explicit teardown instructions. After disposable live tests, remove their compute and
dedicated storage and verify cleanup; stopping compute alone may leave billable resources.

The deployment menu and thin-adapter approach are informed by
[Omnigent's deployment layout](https://github.com/omnigent-ai/omnigent/tree/main/deploy).
