# mdpm website

Static site for https://mdpm.availabooks.com: plain HTML and CSS, no build step.

| File | Page |
|---|---|
| `index.html` | Home: what mdpm is, how it works, install |
| `support.html` | FAQ, bug reports, contact |
| `privacy.html` | Privacy policy (mdpm collects no data) |
| `style.css`, `favicon.svg` | Shared styles and icon |

## Preview locally

```bash
npx serve site
```

Check the layout at about 375px and at desktop width.

## Deploy (Cloudflare Pages)

Needs access to the Cloudflare account that holds the `availabooks.com` zone. No tokens belong in this repo.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, and pick `availabooks/mdpm`.
2. Production branch: `main`. Framework preset: **None**. Build command: leave empty. Build output directory: `site`.
3. Save and deploy. Every push to `main` that changes `site/` redeploys automatically.
4. In the project, **Custom domains** → **Set up a custom domain** → `mdpm.availabooks.com`. Because the zone is in the same account, Cloudflare creates the DNS record (a proxied CNAME to `<project>.pages.dev`) for you.
5. Wait for the certificate to become active, then verify:

```bash
curl -sI https://mdpm.availabooks.com | head -1
curl -sI https://mdpm.availabooks.com/support.html | head -1
```

Both should return `200`.

### Alternative: deploy from the command line

```bash
npx wrangler pages deploy site --project-name mdpm
```

Run `npx wrangler login` first. For CI, store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub repository secrets.
