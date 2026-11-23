# supertag.sh

The redirects behind `https://supertag.sh`. The site holds no files: every path answers with a
temporary redirect to this repository's GitHub Releases, so the install script and the archives
always come from the published release.

| Path | Goes to |
| --- | --- |
| `/install`, `/install.sh` | The latest release's `install.sh` |
| `/install/X.Y.Z` | That release's `install.sh` |
| `/releases/latest/download/FILE` | The latest release's asset `FILE` |
| `/releases/download/TAG/FILE` | Release `TAG`'s asset `FILE` |
| `/releases`, `/download` | The releases page, and the latest release |
| `/docs` | The documentation in this repository |
| `/` | This repository |

It is the Vercel project `supertag-sh`, and the domain is registered there. A release changes
nothing here. To change a redirect, edit [`vercel.json`](vercel.json), then deploy from this
directory and check it:

```sh
vercel deploy --prod
curl -fsSI https://supertag.sh/install
```

Whoever controls the domain or the Vercel project decides what `curl ... | sh` runs. Keep
two-factor authentication on that account, and keep the redirects pointing only at this
repository's releases.
