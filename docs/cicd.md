# Zylo CI/CD Pipeline

## Overview

This document walks through the Zylo DevSecOps pipeline stage by stage, in the order the jobs actually run. Each section explains what the stage does, why it exists, and how it's implemented in `Zylo-pipeline.yml`.

The pipeline is built on GitHub Actions and covers two paths:

- **Pull requests** run validation only — linting, dependency audit, Dockerfile lint, and IaC scanning. Nothing is built or pushed.
- **Version tag pushes** (`v*.*.*`) run the full pipeline — validation, build, signing, image scanning, and a deployment manifest update.

Merging to `main` without a tag does not trigger a build. A release only happens when a version tag is pushed, which keeps "what's in `main`" and "what's actually shipped" as two deliberate, separate decisions.

```
Lint → SCA → Dockerfile Lint → IaC Scan → Build → Sign → Image Scan
```

---

## 1. Lint

**What it is**

Static analysis of the backend and frontend source code using ESLint, run separately for each component via a matrix strategy.

**Why it matters**

Linting catches style violations, unused variables, unreachable code, and common bug patterns before anything else runs. It's the cheapest and fastest check in the pipeline, so it runs first — there's no reason to spend CI minutes on a dependency audit or a Docker build if the code doesn't even pass basic static checks.

**How it works**

Each matrix job checks out the repository, installs Node.js 20 with npm caching keyed to `package-lock.json`, runs `npm ci` for a clean, reproducible install, then runs `npm run lint`. Every downstream job (`sca`, `dockerfile-lint`, `iac-scan`) depends on `lint` passing first.

**The job, as defined in the pipeline**

```yaml
lint:
  name: "Lint Code"
  runs-on: ubuntu-latest
  strategy:
    matrix:
      component: [backend, frontend]
  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"
        cache-dependency-path: "${{ matrix.component }}/package-lock.json"

    - name: Install dependencies
      working-directory: ${{ matrix.component }}
      run: npm ci

    - name: Run ESLint
      working-directory: ${{ matrix.component }}
      run: npm run lint
```

**Line-by-line**

- `strategy.matrix.component: [backend, frontend]` — runs this job twice in parallel, once per component, instead of writing two near-identical jobs.
- `actions/checkout@v4` — pulls the repository onto the runner; nothing else can happen without the source code present.
- `actions/setup-node@v4` with `cache: "npm"` and `cache-dependency-path` — installs Node 20 and caches `node_modules` keyed to that component's lockfile, so unrelated changes to the other component don't invalidate this cache.
- `working-directory: ${{ matrix.component }}` — every `run` step operates inside `backend/` or `frontend/`, since each is its own Node project with its own `package.json`.
- `npm ci` — installs exactly what's in `package-lock.json`, rather than `npm install`, which can silently update versions and produce a different dependency tree than what was committed.
- `npm run lint` — the actual ESLint invocation, delegated to whatever script is defined in each component's `package.json` rather than hardcoding ESLint flags here.

---

## 2. Dependency Audit (SCA)

**What it is**

Software Composition Analysis — scanning the project's third-party dependencies for known vulnerabilities using `npm audit`.

**Why it matters**

Most real-world vulnerabilities in an application don't come from code you wrote — they come from a library three levels deep in your dependency tree. SCA is how you find out about them before an attacker does. This stage is set to fail the build on `high` or `critical` findings, rather than reporting on them and continuing anyway, so a known-vulnerable dependency can't silently ride into a release.

**How it works**

Runs after `lint`, per component. Installs dependencies with `npm ci`, then runs `npm audit --audit-level=high`. If a high or critical vulnerability is found, the job exits non-zero and the pipeline stops there — the build stage never runs.

**The job, as defined in the pipeline**

```yaml
sca:
  name: "Dependency Audit"
  runs-on: ubuntu-latest
  needs: lint
  strategy:
    matrix:
      component: [backend, frontend]
  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"
        cache-dependency-path: "${{ matrix.component }}/package-lock.json"

    - name: Install dependencies
      working-directory: ${{ matrix.component }}
      run: npm ci

    - name: npm audit
      working-directory: ${{ matrix.component }}
      run: npm audit --audit-level=high
```

**Line-by-line**

- `needs: lint` — this job won't even start until both `lint` matrix runs succeed, so a dependency audit never runs against code that failed basic static checks.
- The checkout and Node setup steps mirror the `lint` job exactly, since this is a separate job (GitHub Actions jobs don't share filesystem state) and needs its own environment.
- `npm audit --audit-level=high` — the critical line. `--audit-level=high` tells `npm audit` to exit non-zero only for `high` or `critical` severity findings; `low` and `moderate` findings are still reported in the log but don't fail the job. There is no `|| true` after this command, which is what makes the check actually blocking — without it, this line would report findings but let the job succeed regardless.

---

## 3. Dockerfile Lint

**What it is**

Static analysis of each component's `Dockerfile` using Hadolint.

**Why it matters**

A Dockerfile is infrastructure, not just a build script, and it accumulates the same kind of bad habits as any other code: running as root unnecessarily, using `latest` tags, leaving unnecessary layers, or skipping `--no-cache` where it matters. Catching these at lint time is far cheaper than catching them in a security review after the image is already in production.

**How it works**

Runs after `lint`, per component, using the `hadolint-action`. The failure threshold is set to `warning`, so this stage is intentionally stricter than "only fail on errors" — style and best-practice violations are treated as real findings.

**The job, as defined in the pipeline**

```yaml
dockerfile-lint:
  name: "Dockerfile Lint"
  runs-on: ubuntu-latest
  needs: lint
  strategy:
    matrix:
      component: [backend, frontend]
  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Run Hadolint
      uses: hadolint/hadolint-action@v3.1.0
      with:
        dockerfile: ${{ matrix.component }}/Dockerfile
        failure-threshold: warning
```

**Line-by-line**

- `needs: lint` — same gating pattern as `sca`; this runs in parallel with `sca` and `iac-scan`, all three depending only on `lint`.
- No Node.js setup is needed here — Hadolint doesn't touch application dependencies, only the Dockerfile itself, so this job is lighter than `lint` or `sca`.
- `dockerfile: ${{ matrix.component }}/Dockerfile` — points Hadolint at the correct component's Dockerfile using the same matrix variable used elsewhere.
- `failure-threshold: warning` — this is the setting that makes the job blocking. Hadolint's default threshold only fails on `error`-level findings; setting it to `warning` means best-practice violations (not just outright mistakes) will fail the job.

---

## 4. IaC Security Scan

**What it is**

Static analysis of infrastructure-as-code using Checkov, run against both the Terraform configuration (`terraform/`) and the Kubernetes manifests (`k8s/`).

**Why it matters**

Application code isn't the only thing that can be insecure — a misconfigured security group, a publicly exposed database, or an over-permissioned IAM role can undo every other security control in this pipeline. Scanning IaC catches these before they're ever applied.

**How it works**

Two separate Checkov runs:

- **Terraform** is scanned with `soft_fail: false`, meaning any finding fails the job — with the exception of two explicitly skipped checks (`CKV_AWS_39`, `CKV_AWS_58`, covering a public EKS endpoint) that are accepted as a known, intentional exception for the current environment.
- **Kubernetes manifests** are scanned with `soft_fail: true`, since not every Checkov Kubernetes check is meaningful for every deployment shape — findings are surfaced but don't block the pipeline.

Both scans depend only on `lint`, so they run in parallel with `sca` and `dockerfile-lint`, keeping the validation phase fast.

**The job, as defined in the pipeline**

```yaml
iac-scan:
  name: "IaC Security Scan"
  runs-on: ubuntu-latest
  needs: lint
  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Run Checkov on Terraform
      uses: bridgecrewio/checkov-action@v12
      with:
        directory: terraform/
        framework: terraform
        soft_fail: false
        skip_check: CKV_AWS_39,CKV_AWS_58
        output_format: cli

    - name: Run Checkov on Kubernetes manifests
      uses: bridgecrewio/checkov-action@v12
      with:
        directory: k8s/
        framework: kubernetes
        soft_fail: true
        output_format: cli
```

**Line-by-line**

- This job has no `strategy.matrix` — unlike the previous stages, infrastructure code isn't split per application component, so it runs once against the whole repository.
- First `checkov-action` call: `directory: terraform/`, `framework: terraform`, `soft_fail: false` — scans the Terraform root and fails the job on any unskipped finding.
- `skip_check: CKV_AWS_39,CKV_AWS_58` — explicitly excludes two checks (both related to a public EKS endpoint) that are accepted as intentional for the current environment. Anything not on this list still blocks the pipeline.
- Second `checkov-action` call: `directory: k8s/`, `framework: kubernetes`, `soft_fail: true` — a separate scan for the Kubernetes manifests, deliberately non-blocking, since some Checkov Kubernetes checks don't cleanly apply to every deployment shape.
- `output_format: cli` on both — keeps scan output readable in the Actions log rather than emitting SARIF or JSON, since there's no code-scanning integration consuming it yet.

---

## 5. Build

**What it is**

Building the backend and frontend Docker images with Buildx and pushing them to GitHub Container Registry (GHCR).

**Why it matters**

This is where source code becomes a deployable artifact. Everything before this stage exists to make sure the thing being built is safe to build; everything after this stage exists to make sure the thing that got built is safe to run.

**How it works**

This stage only runs once `sca`, `dockerfile-lint`, and `iac-scan` have all passed — a vulnerable dependency, a bad Dockerfile, or a broken IaC config never reaches a build. Buildx builds each component with GitHub Actions layer caching (`cache-from`/`cache-to: type=gha`), and `docker/metadata-action` generates the image tags:

- `type=semver` tags derived from the git tag (e.g. `v1.4.2` and `1.4`)
- a SHA-based tag as a fallback reference
- `latest`, but only outside pull requests

Provenance and SBOM generation are enabled on the build (`provenance: true`, `sbom: true`), and the resulting image digest is captured as a job output. That digest — not a tag, not a rebuilt copy — is what every downstream stage (signing, scanning) operates on, so what gets signed and scanned is guaranteed to be the exact artifact that was pushed.

On pull requests, the build still runs (to confirm the Dockerfile builds cleanly) but nothing is pushed.

**The job, as defined in the pipeline**

```yaml
build:
  name: "Build ${{ matrix.component }}"
  runs-on: ubuntu-latest
  needs: [sca, dockerfile-lint, iac-scan]
  permissions:
    contents: read
    packages: write # Needed to push to GHCR
  strategy:
    matrix:
      component: [backend, frontend]
  outputs:
    backend-digest: ${{ steps.digest-export.outputs.backend }}
    frontend-digest: ${{ steps.digest-export.outputs.frontend }}
  steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Log in to GitHub Container Registry
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Extract metadata (tags, labels)
      id: meta
      uses: docker/metadata-action@v5
      with:
        images: ghcr.io/${{ github.repository }}/Zylo-${{ matrix.component }}
        tags: |
          type=semver,pattern={{version}}
          type=semver,pattern={{major}}.{{minor}}
          type=sha,prefix=
          type=raw,value=latest,enable=${{ github.event_name != 'pull_request' }}

    - name: Build and push image
      id: build
      uses: docker/build-push-action@v6
      with:
        context: ./${{ matrix.component }}
        file: ./${{ matrix.component }}/Dockerfile
        push: ${{ github.event_name != 'pull_request' }}
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
        provenance: true
        sbom: true

    - name: Export digest
      id: digest-export
      if: github.event_name != 'pull_request'
      run: |
        echo "${{ matrix.component }}=${{ steps.build.outputs.digest }}" >> "$GITHUB_OUTPUT"
```

**Line-by-line**

- `needs: [sca, dockerfile-lint, iac-scan]` — the key gate. All three validation jobs must succeed before a single image gets built.
- `permissions.packages: write` — overrides the workflow-level `permissions: contents: read` default just for this job, granting only the extra scope this job actually needs (pushing to GHCR), rather than widening permissions for the whole workflow.
- `outputs.backend-digest` / `outputs.frontend-digest` — job-level outputs, populated from the `digest-export` step. This is how the digest produced here becomes available to the `sign` and `image-scan` jobs, which reference it as `needs.build.outputs.backend-digest`.
- `docker/login-action@v3` using `secrets.GITHUB_TOKEN` — authenticates to GHCR using the workflow's own automatically-issued token rather than a separately managed credential.
- `docker/metadata-action@v5` — generates the tag list. `type=semver,pattern={{version}}` and `{{major}}.{{minor}}` produce tags from the git tag that triggered the run (e.g. `v1.4.2` and `1.4`); `type=sha,prefix=` adds a commit-SHA tag as a stable fallback reference; `type=raw,value=latest,enable=${{ github.event_name != 'pull_request' }}` only applies the `latest` tag outside pull requests, since a PR build is never something that should become "latest."
- `push: ${{ github.event_name != 'pull_request' }}` — the build always runs, but the image is only pushed to the registry when the trigger isn't a pull request. This is what lets PRs validate that the Dockerfile builds without publishing anything.
- `provenance: true`, `sbom: true` — asks Buildx to attach build provenance attestation and a Software Bill of Materials to the image, so anyone consuming it later can trace exactly how and from what it was built.
- `cache-from`/`cache-to: type=gha` — uses GitHub Actions' built-in cache backend to speed up repeated builds by reusing unchanged layers.
- The final `run` step reads `steps.build.outputs.digest` — an output automatically provided by `build-push-action` — and writes it to `$GITHUB_OUTPUT` under a key matching the component name, which is what populates the job-level `outputs` block above. `if: github.event_name != 'pull_request'` skips this step entirely on PRs, since there's no pushed digest to export.

---

## 6. Sign

**What it is**

Cosign keyless signing of each pushed image, using GitHub's OIDC identity instead of a long-lived signing key.

**Why it matters**

A scanned, vulnerability-free image is only trustworthy if you can prove it hasn't been tampered with between the registry and the cluster that pulls it. Signing gives you that guarantee, and keyless signing removes the operational burden — and risk — of managing a private signing key.

**How it works**

Runs after `build`, using the digest exported from that stage. `sigstore/cosign-installer` sets up the CLI, and `cosign sign --yes` signs `image@digest` using the workflow's OIDC token (`id-token: write` permission), recording the signature in Sigstore's transparency log. This stage is skipped on pull requests, since nothing is pushed to sign.

**The job, as defined in the pipeline**

```yaml
sign:
  name: "Sign ${{ matrix.component }} Image"
  runs-on: ubuntu-latest
  needs: build
  if: github.event_name != 'pull_request'
  permissions:
    contents: read
    packages: write
    id-token: write # Required for keyless signing (OIDC)
  strategy:
    matrix:
      component: [backend, frontend]
  steps:
    - name: Install cosign
      uses: sigstore/cosign-installer@v3

    - name: Log in to GitHub Container Registry
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Sign image by digest
      env:
        COSIGN_EXPERIMENTAL: "1"
        IMAGE: ghcr.io/${{ github.repository }}/Zylo-${{ matrix.component }}
        DIGEST: ${{ matrix.component == 'backend' && needs.build.outputs.backend-digest || needs.build.outputs.frontend-digest }}
      run: |
        cosign sign --yes "${IMAGE}@${DIGEST}"
```

**Line-by-line**

- `if: github.event_name != 'pull_request'` at the job level — the entire job is skipped on PRs rather than skipping individual steps, since there's nothing to sign when nothing was pushed.
- `permissions.id-token: write` — this is what allows the job to request an OIDC token from GitHub, which cosign uses in place of a stored private key. Without this permission, keyless signing isn't possible.
- `DIGEST: ${{ matrix.component == 'backend' && needs.build.outputs.backend-digest || needs.build.outputs.frontend-digest }}` — a ternary-style expression picking the correct digest output depending on which matrix leg is currently running, since `needs.build.outputs` contains both components' digests but this job only needs one at a time.
- `cosign sign --yes "${IMAGE}@${DIGEST}"` — signs the image referenced by digest (not by tag), so the signature is bound to the exact content that was built and pushed, not to a mutable tag that could later point somewhere else. `--yes` skips the interactive confirmation prompt, since this runs non-interactively in CI.

---

## 7. Image Scan

**What it is**

Container vulnerability scanning with Trivy, checking OS packages and application libraries inside the built image for known CVEs.

**Why it matters**

SCA (stage 2) scans your dependency manifests before the image exists. Image scanning checks the actual filesystem of the built container — including OS packages, base image layers, and anything pulled in during the Docker build that wouldn't show up in a `package-lock.json` audit. It's a second, independent check on a different surface.

**How it works**

Like signing, this stage scans the image by digest — the exact artifact pushed in the `build` stage — rather than rebuilding the image from source a second time, which would risk scanning something subtly different from what was actually shipped. Trivy is configured to fail the build (`exit-code: "1"`) on `CRITICAL` or `HIGH` severity findings, ignoring vulnerabilities with no available fix (`ignore-unfixed: true`), since there's no actionable remediation for those yet.

**The job, as defined in the pipeline**

```yaml
image-scan:
  name: "Scan ${{ matrix.component }} Image"
  runs-on: ubuntu-latest
  needs: build
  if: github.event_name != 'pull_request'
  strategy:
    matrix:
      component: [backend, frontend]
  steps:
    - name: Log in to GitHub Container Registry
      uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@master
      env:
        DIGEST: ${{ matrix.component == 'backend' && needs.build.outputs.backend-digest || needs.build.outputs.frontend-digest }}
      with:
        image-ref: "ghcr.io/${{ github.repository }}/Zylo-${{ matrix.component }}@${{ env.DIGEST }}"
        format: "table"
        exit-code: "1"
        ignore-unfixed: true
        vuln-type: "os,library"
        severity: "CRITICAL,HIGH"
        timeout: "10m"
```

**Line-by-line**

- `needs: build` (not `needs: sign`) — image scanning and signing both depend directly on `build` and run independently of each other; there's no ordering requirement between them, so they run in parallel rather than one waiting on the other.
- The login step is required here even though this job doesn't push anything — Trivy needs registry credentials to pull the image by digest for scanning.
- `image-ref: "...@${{ env.DIGEST }}"` — the same digest-pinning pattern used in `sign`, ensuring Trivy scans the exact pushed artifact.
- `exit-code: "1"` — tells Trivy to exit non-zero (failing the job) if it finds anything matching the configured severity, rather than just printing a report and exiting `0` regardless.
- `ignore-unfixed: true` — filters out vulnerabilities that don't yet have a patched version available, since failing the build over something with no fix wouldn't be actionable.
- `vuln-type: "os,library"` — scans both OS-level packages (from the base image) and application-level libraries, rather than just one or the other.
- `severity: "CRITICAL,HIGH"` — sets the bar for what actually fails the build; `MEDIUM` and `LOW` findings are still visible in the scan output but don't block.

---

## 8. Update Manifest

**What it is**

Automatically updating the Kubernetes deployment manifest (`k8s/Zylo.yaml`) with the newly built image tags, and committing that change back to `main`.

**Why it matters**

This is the handoff from CI to CD. Once an image has passed every prior gate — lint, SCA, Dockerfile lint, IaC scan, build, signing, and image scan — the manifest needs to reference it so a GitOps controller (or a manual `kubectl apply`/Helm upgrade) can actually deploy it. Automating this step removes manual tag-bumping as a source of error and keeps the manifest as a reliable record of what was released.

**How it works**

This stage only runs on a version tag push (`refs/tags/v*`), and only after both `image-scan` and `sign` have succeeded — so nothing gets wired into the manifest unless it has already cleared every earlier check. Since the triggering ref is a tag rather than a branch, the job explicitly checks out `main` (where the manifest lives) rather than the tag's commit.

The image tag written into the manifest is the release tag itself (e.g. `v1.4.2`), not a commit SHA, so the manifest always points at a specific, named release rather than an arbitrary point in history. The manifest is edited with `yq`, selecting each container by name (`backend`, `frontend`) rather than relying on line numbers, so the edit is resilient to the manifest being reordered or reformatted later. The commit is pushed with a small retry loop that rebases and retries up to three times in case another job pushes to `main` first.

**The job, as defined in the pipeline**

```yaml
update-manifest:
  name: "Update K8s Manifest"
  runs-on: ubuntu-latest
  needs: [image-scan, sign]
  if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
  permissions:
    contents: write # Needed to push manifest changes
  steps:
    - name: Checkout main
      uses: actions/checkout@v4
      with:
        ref: main
        token: ${{ secrets.GITHUB_TOKEN }}

    - name: Get release tag
      id: tag
      run: echo "name=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"

    - name: Install yq
      run: |
        sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
        sudo chmod +x /usr/local/bin/yq

    - name: Update K8s manifest with new image tags
      run: |
        IMAGE_TAG="${{ steps.tag.outputs.name }}"

        yq -i '
          (.spec.template.spec.containers[] | select(.name == "backend") | .image) = "'"${BACKEND_IMAGE}"':'"${IMAGE_TAG}"'" |
          (.spec.template.spec.containers[] | select(.name == "frontend") | .image) = "'"${FRONTEND_IMAGE}"':'"${IMAGE_TAG}"'"
        ' k8s/Zylo.yaml

        echo "Updated images to tag: ${IMAGE_TAG}"
        grep -n "image:" k8s/Zylo.yaml

    - name: Commit and push manifest update
      run: |
        git config user.name "github-actions[bot]"
        git config user.email "github-actions[bot]@users.noreply.github.com"
        git add k8s/Zylo.yaml
        git diff --cached --quiet && exit 0

        for i in 1 2 3; do
          git commit -m "ci: update k8s images to ${{ steps.tag.outputs.name }} [skip ci]" || break
          if git push; then
            exit 0
          fi
          echo "Push rejected, rebasing and retrying ($i/3)..."
          git pull --rebase
        done
```

**Line-by-line**

- `needs: [image-scan, sign]` — this job only starts once the image has both passed the vulnerability scan and been signed. Either one failing keeps the manifest untouched.
- `if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')` — the deployment gate. This is the only job in the pipeline restricted to tag pushes specifically (the others check `!= 'pull_request'`, which would also include a plain branch push if one were configured).
- `ref: main` on the checkout step — since the workflow was triggered by a tag ref (`refs/tags/v1.4.2`), a default checkout would land on that tag's commit, detached from any branch. Explicitly checking out `main` ensures the manifest edit and subsequent push target the right branch.
- `echo "name=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"` — a parameter expansion that strips the `refs/tags/` prefix off `$GITHUB_REF`, leaving just the tag name (e.g. `v1.4.2`), stored as a step output for reuse.
- The `yq` install step downloads a specific binary release directly, since `yq` isn't preinstalled on GitHub-hosted runners the way `jq` is.
- The `yq` expression itself: `.spec.template.spec.containers[] | select(.name == "backend")` walks the container list and selects the entry by name rather than by position, so the edit still works correctly if the manifest's container order changes.
- `git diff --cached --quiet && exit 0` — if the manifest update produced no actual change (e.g. re-running against an already-current manifest), the job exits cleanly instead of trying to commit nothing.
- The `for i in 1 2 3` loop — commits once, then attempts to push; if the push is rejected (because something else updated `main` in the meantime), it rebases onto the latest `main` and retries, up to three attempts, before giving up.

---

## Design Notes

A few deliberate choices worth calling out:

- **Validation and release are separate triggers.** Pull requests validate; only a version tag builds, signs, scans, and deploys. This avoids building and pushing an image for every branch push, and makes "what got released" an explicit, tagged decision rather than an implicit side effect of merging.
- **Scan by digest, not by rebuild.** Both signing and image scanning operate on the exact digest produced by the `build` stage, so the pipeline never signs or scans a different artifact than the one that was actually pushed.
- **Blocking vs. soft-fail is intentional, not uniform.** SCA, Dockerfile lint, Terraform IaC scanning, and image scanning all block the pipeline on real findings. Kubernetes IaC scanning is soft-fail, since not every check applies cleanly to every manifest shape — findings are visible without stopping a release over noise.
