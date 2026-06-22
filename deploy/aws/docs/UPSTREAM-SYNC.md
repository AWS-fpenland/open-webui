# Staying in sync with upstream & contributing

This deployment layer is intentionally **additive** so the fork can track
`open-webui/open-webui` with minimal friction and the work can, if desired, be contributed
upstream cleanly.

## Branch model

- **`main`** — kept pristine, tracks `open-webui/open-webui`. Do not commit deployment code
  here.
- **`aws-deploy`** — this branch. Adds only `deploy/aws/`. Nothing upstream is modified.

Because the only difference between `main` and `aws-deploy` is a new top-level directory,
syncing upstream is conflict-free.

## Syncing the fork with upstream

**GitHub UI (easiest):** on `AWS-fpenland/open-webui`, use the **"Sync fork"** button on
the `main` branch. This is available because the repo is a true GitHub fork.

**CLI:**
```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main      # main is pristine, so this fast-forwards
git push origin main

# bring the new upstream commits under the deploy branch
git checkout aws-deploy
git rebase main                        # no conflicts — deploy/ doesn't overlap upstream
git push --force-with-lease origin aws-deploy
```

> `upstream` remote: `git remote add upstream https://github.com/open-webui/open-webui.git`

## Bumping the deployed Open WebUI version

After syncing, point the deployment at the new release:

1. Set `image.tag` to the new version (e.g. `v0.9.7`) in your config file, or pass
   `-c imageTag=v0.9.7`.
2. Redeploy (Mode 1) or push (pipeline modes). ECS rolls the task; the circuit breaker
   rolls back automatically if the new image fails health checks.

The deployment defaults to the **official prebuilt image**, so a version bump is just a tag
change — no rebuild.

## Verifying the diff stays additive

```bash
git fetch upstream
git diff --name-only upstream/main...aws-deploy | grep -v '^deploy/' \
  && echo "NON-ADDITIVE CHANGES FOUND" || echo "OK: purely additive"
```

A green "OK" means every change is under `deploy/` and the upstream tree is untouched.

## Contributing upstream (optional)

Open WebUI **can** receive this as a contribution, but mind their process (verified from
their CONTRIBUTING guide and repo):

1. **Open a GitHub Discussion first.** They ask contributors to discuss before opening a PR;
   unsolicited large PRs may be closed. Pitch the `deploy/aws/` directory and get a maintainer
   read on whether they want cloud IaC in-tree (note: they moved the Helm chart to a
   *separate* repo, `open-webui/helm-charts`, so a separate repo may be their preference).
2. **CLA.** Open WebUI has a Contributor License Agreement granting Open WebUI Inc. broad
   rights over contributions. Review `CONTRIBUTOR_LICENSE_AGREEMENT` before submitting.
3. **Keep it atomic & dependency-light.** Their guide favors single-objective PRs and
   discourages adding new external dependencies without discussion. This directory adds no
   Python/Node deps to the app — it's self-contained CDK under `deploy/aws/cdk/`.
4. **License header.** The app is under a BSD-3-Clause + branding-clause license. The IaC
   here doesn't alter the app or its branding.

If upstream prefers not to host cloud IaC in-tree, this directory works perfectly well as a
standalone distribution on the fork — that's the default expectation.

## License / branding note (operational)

Open WebUI's license includes a clause restricting removal of "Open WebUI" branding unless
your deployment has **≤50 users in any 30-day window**, you have written permission, or an
enterprise license. The default deployment ships unmodified branding, so this is satisfied
out of the box — just be aware of it before white-labeling at scale.
