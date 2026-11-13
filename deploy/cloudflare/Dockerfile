# The container `wrangler deploy` builds and pushes: the SuperTag hosted image, unchanged. Tag
# the hosted image (rust-service.Dockerfile target "hosted") as supertag-hosted:local first, for
# example `docker pull IMAGE@sha256:DIGEST && docker tag IMAGE@sha256:DIGEST supertag-hosted:local`,
# for linux/amd64, the architecture Cloudflare Containers run.
FROM supertag-hosted:local
# The tunnel listener; local development (`wrangler dev`) requires the exposed port.
EXPOSE 8080/tcp
