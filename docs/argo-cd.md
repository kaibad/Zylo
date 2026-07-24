# ArgoCD Installation & GitOps Setup for Zylo (UI-Based)

> **Goal:** Install ArgoCD on the existing MicroK8s cluster and configure continuous deployment for the `zylo` Helm chart entirely through the ArgoCD UI — no ArgoCD Application manifests written by hand.

**Prerequisites:**

- MicroK8s cluster already running on EC2 (per the earlier `zylo` deployment guide)
- `kubectl` configured and working (`kubectl get nodes` succeeds)
- Security group allows the NodePort range `30000-32767`
- A GitHub PAT with read access to `kaibad/helm-charts` (the repo your CI/CD `update-manifest` job pushes to)

---

## Phase 1: Install ArgoCD on the Cluster

### Step 1.1: Create the ArgoCD Namespace

```bash
kubectl create namespace argocd
```

### Step 1.2: Apply the Official ArgoCD Install Manifest

This installs the ArgoCD platform itself (server, repo-server, application-controller, redis, dex). It is the standard upstream installer — equivalent to running `helm install` for a chart — and does not require you to author any YAML.

```bash
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

> **Note:** This installs the non-HA version, which is appropriate for a single-node t3.medium MicroK8s cluster.

### Step 1.3: Wait for All Pods to Be Ready

```bash
kubectl get pods -n argocd -w
```

Wait until the following are all `Running`:

| Pod                             | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `argocd-server`                 | Serves the UI/API                                     |
| `argocd-repo-server`            | Renders Helm charts / manifests from Git              |
| `argocd-application-controller` | Reconciles live cluster state vs Git                  |
| `argocd-dex-server`             | Handles SSO/auth (not required for local admin login) |
| `argocd-redis`                  | Caching layer                                         |

Press `Ctrl+C` once all pods show `Running` and `1/1` or `2/2` ready.

---

## Phase 2: Expose the ArgoCD UI

### Step 2.1: Patch the `argocd-server` Service to NodePort

```bash
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort"}}'
```

### Step 2.2: Find the Assigned NodePort

```bash
kubectl get svc argocd-server -n argocd
```

Look at the `PORT(S)` column — you want the port mapped to container port `443`, e.g.:

```
443:31789/TCP
```

Here, `31789` is your UI port.

### Step 2.3: Access the UI

```
https://<EC2-PUBLIC-IP>:<nodeport>
```

Your browser will show a self-signed certificate warning — this is expected for a default ArgoCD install. Proceed past the warning.

> **Alternative (no extra port exposure):** Use port-forwarding instead of NodePort, and tunnel it over SSH the same way you access the Zylo app locally:
>
> ```bash
> kubectl port-forward svc/argocd-server -n argocd 8080:443
> ```
>
> Then, from your local machine:
>
> ```bash
> ssh -i zylo-key.pem -L 8080:localhost:8080 ubuntu@<EC2-PUBLIC-IP>
> ```
>
> and open `https://localhost:8080`.

---

## Phase 3: Log In to ArgoCD

### Step 3.1: Retrieve the Initial Admin Password

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d; echo
```

### Step 3.2: Log In

- **Username:** `admin`
- **Password:** the value output above

### Step 3.3: Change the Admin Password

In the UI: **User Info → Update Password**. Do this immediately after first login, since the initial secret is only meant as a bootstrap credential.

> Optionally, once you no longer need it, delete the bootstrap secret:
>
> ```bash
> kubectl -n argocd delete secret argocd-initial-admin-secret
> ```

---

## Phase 4: Connect the Helm Charts Repository

Your CI/CD pipeline's `update-manifest` job already pushes image tag bumps to `kaibad/helm-charts`. ArgoCD needs read access to this repo to watch for changes.

### Step 4.1: Open Repository Settings

In the UI: **Settings (gear icon) → Repositories → Connect Repo**

### Step 4.2: Fill in Connection Details

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Connection method | HTTPS                                       |
| Type              | git                                         |
| Repository URL    | `https://github.com/kaibad/helm-charts.git` |
| Username          | your GitHub username                        |
| Password          | a GitHub PAT with `repo` read scope         |

### Step 4.3: Connect and Verify

Click **Connect**. The repo should appear in the list with a green **Successful** connection status. If it shows a failure, re-check the PAT scope and that the repo path is correct.

> **SSH alternative:** If you prefer key-based auth, generate a deploy key on the `helm-charts` repo and use the SSH connection method with the corresponding private key instead of username/PAT.

---

## Phase 5: Create the Zylo Application (UI Only)

### Step 5.1: Start a New Application

In the UI: **Applications → + New App**

### Step 5.2: General Section

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Application Name | `zylo`                                                                    |
| Project          | `default`                                                                 |
| Sync Policy      | `Manual` (recommended to start; switch to `Automatic` later once trusted) |

### Step 5.3: Source Section

| Field          | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| Repository URL | select `https://github.com/kaibad/helm-charts.git` from the dropdown (populated from Phase 4) |
| Revision       | `main`                                                                                        |
| Path           | `zylo` (the folder containing `Chart.yaml`)                                                   |

ArgoCD auto-detects this as a Helm chart once the path is set and shows a **Helm** parameters panel.

### Step 5.4: Destination Section

| Field       | Value                                         |
| ----------- | --------------------------------------------- |
| Cluster URL | `https://kubernetes.default.svc` (in-cluster) |
| Namespace   | `zylo`                                        |

### Step 5.5: (Optional) Helm Parameter Overrides

If you want to override specific `values.yaml` fields without editing Git, expand the **Helm** section and set parameters directly in the UI, e.g.:

- `backend.tag`
- `frontend.tag`
- `frontend.replicas`

Leaving these blank means ArgoCD uses whatever is currently committed in `values.yaml`.

### Step 5.6: Create the Application

Click **Create** at the top of the form. The `zylo` app will appear on the Applications dashboard, initially showing status `OutOfSync` / `Missing` since nothing has been synced yet.

---

## Phase 6: Sync the Application

### Step 6.1: Open the App

Click into the `zylo` tile from the Applications dashboard. This shows the live resource tree.

### Step 6.2: Sync

Click **Sync → Synchronize**. ArgoCD will:

1. Render the Helm chart at the given revision
2. Apply the resulting manifests to the `zylo` namespace
3. Display each resource (Deployments, Services, PVC, Secret, ConfigMap) in the topology view with health status

### Step 6.3: Confirm Health

Wait for all resources to show green (`Healthy` / `Synced`). Click any resource node to view live YAML, logs, or events directly from the UI.

---

## Phase 7: Ongoing GitOps Workflow

Once set up, your deployment loop is:

```
Code push → Zylo CI/CD pipeline (lint → scan → build → sign)
    │
    ▼
update-manifest job bumps backend.tag / frontend.tag
in kaibad/helm-charts values.yaml
    │
    ▼
ArgoCD detects Git diff
    │
    ├── Manual sync policy → App shows "OutOfSync", you click Sync in UI
    └── Automatic sync policy → ArgoCD applies the change automatically
    │
    ▼
New pods rolled out in zylo namespace
```

### Switching to Automatic Sync (Optional, Later)

Once you're confident in the pipeline's reliability:

1. Open the `zylo` app → **App Details → Sync Policy → Edit**
2. Enable **Automated**
3. Optionally enable **Prune Resources** and **Self Heal** so ArgoCD removes deleted resources and reverts manual `kubectl` drift automatically

---

## Troubleshooting

| Issue                             | Solution                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ArgoCD UI unreachable on NodePort | Confirm security group allows the specific NodePort (30000-32767 range) and that `kubectl get svc argocd-server -n argocd` shows `NodePort` type |
| Repo connection fails             | Check PAT has `repo` scope and hasn't expired; verify exact repo URL casing                                                                      |
| App stuck on `Missing` after sync | Check `argocd-repo-server` logs: `kubectl logs -n argocd deploy/argocd-repo-server`                                                              |
| Helm chart not auto-detected      | Ensure `Path` points directly to the folder containing `Chart.yaml`, not a parent directory                                                      |
| Pods not updating after tag bump  | Confirm ArgoCD picked up the latest commit — check **Refresh** button on the app, or that auto-sync/webhook is configured                        |
| Self-signed cert warnings         | Expected by default; can be replaced later with a proper cert via Ingress + cert-manager if desired                                              |

---

## Summary Flow

```
kubectl create namespace argocd
        │
        ▼
kubectl apply -f install.yaml (official ArgoCD manifest)
        │
        ▼
Patch argocd-server → NodePort
        │
        ▼
Retrieve admin password → Log in via UI
        │
        ▼
Settings → Repositories → Connect kaibad/helm-charts
        │
        ▼
Applications → + New App
   ├─ Name: zylo
   ├─ Repo: helm-charts, path: zylo
   ├─ Cluster: in-cluster, ns: zylo
   └─ Sync Policy: Manual → Sync
        │
        ▼
ArgoCD renders Helm chart → applies to zylo namespace
        │
        ▼
CI/CD bumps tags in Git → ArgoCD shows OutOfSync → Sync (or auto)
```
