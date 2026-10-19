---
title: Build Support Website for This
status: done
author: Elijah Allen
created: 2026-10-19
owner: claude
start: 2026-10-19
branch: agent/build-support-website-for-this
pr: https://github.com/availabooks/mdpm/pull/3
end: 2026-10-19
---

# Build Support Website for This

## Goal

Build the support website and Publish our tool to the public, this way it can be included in the vscode extensions market.

## Context

This is project management software designed to help software engineers get the most out of their claude subscription. It works by allowing you to write tasks in markdown and have the agent of your choice build it while you are sleeping.

Relevant files in the repo (`github.com/availabooks/mdpm`):

- `README.md` and `packages/vscode/README.md`: existing product copy to reuse.
- `docs/agent-workflow.md`: how agents claim, refine and hand off tasks; source for a "How it works" section.
- `packages/vscode/package.json`: `homepage`, `bugs` and `publisher` fields. `homepage` currently points at the GitHub README and should point at the new site.
- `.github/workflows/ci.yml`: existing CI, a reference if a deploy workflow is added.

There is no site directory yet, and nothing in the repo shows an existing Cloudflare project or DNS zone for availabooks.com.

## Plan

1. Create `site/` at the repo root with plain `index.html`, `support.html` and `style.css` (optionally `favicon.svg`, `404.html`). No build step, no framework.
2. `index.html`: hero (what mdpm is), how it works (markdown tasks, kanban board, agents work overnight, review in the morning), install (Marketplace, CLI), link to GitHub.
3. `support.html`: short FAQ, how to report bugs (https://github.com/availabooks/mdpm/issues), contact method, links to docs.
4. Hosting: Cloudflare Pages (or Workers static assets) serving `site/`, with custom domain `mdpm.availabooks.com`.
5. Update `homepage` in `packages/vscode/package.json` and link the site from both READMEs.

## Acceptance criteria

- [x] `site/` contains a static site (`index.html`, `support.html`, `style.css`) in plain HTML/CSS, with no SSG, bundler or framework.
- [x] The home page explains what mdpm is, how it works and how to install it, and links to the support page and the GitHub repo.
- [x] The support page links to GitHub issues, gives a contact method, and has a short FAQ.
- [x] Pages are responsive at mobile widths and have a `<title>`, meta description and Open Graph tags. (CSS media queries and viewport meta; not checked in a browser.)
- [ ] The site is deployed on Cloudflare and served at https://mdpm.availabooks.com over HTTPS. (Needs your Cloudflare access; steps in `site/README.md`.)
- [x] `packages/vscode/package.json` `homepage` points at https://mdpm.availabooks.com, and both READMEs link to the site.
- [x] Deploy steps are documented in `site/README.md`.

## Verification

- Serve locally (`npx serve site`) and check that every internal link resolves and the layout works at about 375px and at desktop width.
- `curl -sI https://mdpm.availabooks.com` returns 200 with valid TLS, and `/support.html` also returns 200.
- Publicly accessible: open the URL from a logged-out browser or another network.
- `npm test` and `npm run typecheck` still pass after the `package.json` change.
- `mdpm check --strict` passes.

## Constraints

- Static site only: simple HTML/CSS, no SSG such as Astro. Build it in this repo under `site/`.
- Don't touch `packages/core`, `packages/cli` or extension source. Only `homepage` metadata and READMEs may change.
- No secrets or Cloudflare tokens in the repo. Never push to `main`.
- An unattended agent can build and commit the site but probably can't deploy it or set up DNS; that needs the person's Cloudflare access (see Questions).

## Questions

- [ ] (claude, 2026-10-19) Deployment: Cloudflare Pages connected to the GitHub repo (output dir 'site', auto-deploys on push to main), or a GitHub Action running 'wrangler pages deploy site'? An agent can't log in to Cloudflare, so you'd need to create the project or add a token as a repo secret. Which do you prefer?
    - whatever is easier. 
- [ ] (claude, 2026-10-19) Is availabooks.com already in your Cloudflare account/DNS? If so, you'd add the custom domain mdpm.availabooks.com to the Pages project; I'll document the steps in site/README.md.
    - yes that is right
- [ ] (claude, 2026-10-19) What contact email should the support page show, or should it only link to GitHub issues?
    - availabooks@gmail.com
- [ ] (claude, 2026-10-19) Does the Marketplace listing need a privacy policy page too, and do you have a logo or brand colors? Otherwise I'll do a minimal text-based design.
    - yes, for logo and branding, look at the styles in ~/availabooks/app. for privacy we do not collect any data
- [ ] (claude, 2026-10-19) I scoped this to building the site in site/ and updating the extension homepage metadata; publishing the extension to the Marketplace is a separate task. Is that right? If so, please review this refinement and move it to todo.
    - looks great to me!

## Agent log

- 2026-10-19 14:21 claude — claimed (run r-20261019-142132-hbg3)
- 2026-10-19 14:21 Elijah Allen — started an interactive claude session on this task
- 2026-10-19 14:29 Elijah Allen — started an interactive claude session on this task
- 2026-10-19 14:29 claude — claimed for refinement (run r-20261019-142919-ivy5)
- 2026-10-19 14:51 claude — claimed for refinement (run r-20261019-145113-rh83)
- 2026-10-19 14:51 claude — blocked on 5 questions (see Questions)
- 2026-10-19 14:54 Elijah Allen — unblocked; moved back to todo
- 2026-10-19 14:56 claude — claimed (run r-20261019-145604-wd91)
- 2026-10-19 14:57 claude — Built site/ (index, support, privacy, style, favicon, README), updated homepage + READMEs; npm test and typecheck pass. Not done: Cloudflare deploy/DNS (no access), and branding from ~/availabooks/app (outside allowed dirs, so I used a neutral blue/stone palette and the extension's icon; swap in brand colors in site/style.css :root).
- 2026-10-19 14:57 claude — handed off for review: Site built in site/ (home, support, privacy, CSS, favicon, deploy README); extension homepage and both READMEs link to it. npm test, typecheck and mdpm check pass. Still needed from you: create the Cloudflare Pages project (steps in site/README.md) and add the custom domain; I couldn't deploy. Branding: ~/availabooks/app was outside my allowed dirs, so the palette is neutral — swap colors in site/style.css :root. Layout not checked in a browser.
- 2026-10-19 14:57 mdpm — run r-20261019-145604-wd91: opened https://github.com/availabooks/mdpm/pull/3
