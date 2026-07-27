# Monitoring (Prometheus + Grafana) & Secrets Management (HashiCorp Vault) for Zylo

> **Goal:** Add cluster and application monitoring using the `kube-prometheus-stack` Helm chart, and centralize secrets management using HashiCorp Vault — both on the existing MicroK8s cluster running on the EC2 t3.medium instance alongside Zylo and ArgoCD.

**Prerequisites:**

- MicroK8s cluster already running (per the `microk8s-and-helm.md` guide), with `helm`, `kubectl` aliases configured
- Zylo deployed in the `zylo` namespace via the Helm chart
- Security group allows the NodePort range `30000-32767`
- Since this is a single t3.medium (2 vCPU / 4 GB RAM) node also running ArgoCD and Zylo, every install below uses reduced resource footprints (HA/replicas disabled, Loki skipped) to avoid starving the node
- A Gmail account with 2-Step Verification enabled, so you can generate an **App Password** for Alertmanager's SMTP relay (a regular Gmail password won't work for SMTP auth)

---

# Part A: Monitoring with Prometheus & Grafana

## Phase 1: Add the Helm Repository

### Step 1.1: Add and Update the `prometheus-community` Repo

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

### Step 1.2: Create the Monitoring Namespace

```bash
kubectl create namespace monitoring
```

---

## Phase 2: Install `kube-prometheus-stack`

This single chart bundles Prometheus, Grafana, Alertmanager, and the node/kube-state metrics exporters.

### Step 2.1: Create a Lightweight `values.yaml`

Since the node is shared with Zylo and ArgoCD, trim resource usage everywhere. Alertmanager stays enabled but minimal — its Gmail SMTP routing is configured separately in Phase 5.

```bash
cat > monitoring-values.yaml << 'EOF'
# ============================================
# Prometheus
# ============================================
prometheus:
  prometheusSpec:
    retention: 3d
    resources:
      requests:
        cpu: 100m
        memory: 256Mi
      limits:
        cpu: 500m
        memory: 512Mi
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: microk8s-hostpath
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 5Gi
  service:
    type: NodePort
    nodePort: 30900

# ============================================
# Grafana
# ============================================
grafana:
  adminPassword: "changeme123!"   # change this immediately after install
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 256Mi
  persistence:
    enabled: true
    storageClassName: microk8s-hostpath
    size: 2Gi
  service:
    type: NodePort
    nodePort: 30300

# ============================================
# Alertmanager — enabled, lightweight, single replica
# (SMTP/Gmail routing config is layered on in Phase 5)
# ============================================
alertmanager:
  enabled: true
  alertmanagerSpec:
    replicas: 1
    resources:
      requests:
        cpu: 25m
        memory: 64Mi
      limits:
        cpu: 100m
        memory: 128Mi
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: microk8s-hostpath
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 1Gi
  service:
    type: NodePort
    nodePort: 30903

# ============================================
# Node exporter & kube-state-metrics — keep enabled, lightweight
# ============================================
nodeExporter:
  enabled: true
kubeStateMetrics:
  enabled: true
EOF
```

> **Note:** MicroK8s's hostpath-storage addon registers its StorageClass as `microk8s-hostpath`. Confirm the name on your cluster with `kubectl get storageclass` before installing — adjust the value above if it differs.

### Step 2.2: Install the Chart

```bash
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f monitoring-values.yaml
```

### Step 2.3: Verify the Install

```bash
kubectl get pods -n monitoring
kubectl get svc -n monitoring
```

Wait until `prometheus-kube-prometheus-stack-prometheus-0`, `kube-prometheus-stack-grafana-*`, and the exporter pods show `Running`.

---

## Phase 3: Access Prometheus & Grafana

### Method 1: Direct NodePort Access

```
Prometheus:   http://<EC2-PUBLIC-IP>:30900
Grafana:      http://<EC2-PUBLIC-IP>:30300
Alertmanager: http://<EC2-PUBLIC-IP>:30903
```

### Method 2: Port-Forward (if you don't want extra ports open)

```bash
# Prometheus
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090

# Grafana
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80

# Alertmanager
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093
```

Then tunnel over SSH the same way you access Zylo and ArgoCD locally:

```bash
ssh -i zylo-key.pem -L 3000:localhost:3000 -L 9090:localhost:9090 -L 9093:localhost:9093 ubuntu@<EC2-PUBLIC-IP>
```

### Step 3.1: Log In to Grafana

- **Username:** `admin`
- **Password:** value of `grafana.adminPassword` from `monitoring-values.yaml` (or retrieve it from the secret):

```bash
kubectl get secret -n monitoring kube-prometheus-stack-grafana \
  -o jsonpath="{.data.admin-password}" | base64 -d; echo
```

Change the password immediately under **Profile → Change Password**.

---

## Phase 4: Scrape Zylo's Backend Metrics

If the Zylo Node.js backend exposes a `/metrics` endpoint (e.g. via `prom-client`), tell Prometheus to scrape it with a `ServiceMonitor`.

### Step 4.1: Confirm the Backend Exposes Metrics

```bash
kubectl port-forward -n zylo svc/backend 3001:3001
curl http://localhost:3001/metrics
```

### Step 4.2: Add a `ServiceMonitor` Template to the Zylo Helm Chart

```bash
cat > zylo/templates/servicemonitor.yaml << 'EOF'
{{- if .Values.backend.metrics.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: zylo-backend
  namespace: {{ .Values.namespace }}
  labels:
    release: kube-prometheus-stack   # must match the Prometheus operator's serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: backend
  namespaceSelector:
    matchNames:
      - {{ .Values.namespace }}
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
{{- end }}
EOF
```

### Step 4.3: Add the Toggle to `values.yaml`

```bash
cat >> zylo/values.yaml << 'EOF'

# ============================================
# Backend metrics scraping
# ============================================
backend:
  metrics:
    enabled: true
EOF
```

> **Note:** The Service backing the backend Pods needs a named port called `http` (or whatever you reference in `endpoints[].port`) for the `ServiceMonitor` to resolve it — check `zylo/templates/service.yaml` and add `name: http` to the port if it's missing.

### Step 4.4: Upgrade the Release (or Let ArgoCD Sync It)

```bash
# Manual path
helm upgrade zylo ./zylo

# GitOps path (per argo-cd.md): commit + push to kaibad/helm-charts,
# then Sync from the ArgoCD UI
```

### Step 4.5: Confirm the Target Is Being Scraped

In Prometheus UI: **Status → Targets** → look for `zylo-backend` with state `UP`.

---

## Phase 5: Alerting via Gmail SMTP

Alertmanager needs SMTP credentials to send mail through Gmail. Gmail requires an **App Password** (not your normal login password) for third-party SMTP clients.

### Step 5.1: Generate a Gmail App Password

1. Go to your **Google Account → Security**
2. Enable **2-Step Verification** if it isn't already on
3. Go to **Security → 2-Step Verification → App passwords**
4. Create a new app password (name it e.g. `zylo-alertmanager`)
5. Copy the 16-character password shown — you won't be able to view it again

### Step 5.2: Store the App Password as a Kubernetes Secret

Don't put the raw password in `monitoring-values.yaml` since that file gets committed to Git. Create a Secret directly instead:

```bash
kubectl create secret generic alertmanager-gmail-smtp \
  -n monitoring \
  --from-literal=smtp-password='<16-char-app-password>'
```

### Step 5.3: Configure Alertmanager's Routing and Gmail Receiver

`kube-prometheus-stack` accepts a full Alertmanager config under `alertmanager.config`. Add this to `monitoring-values.yaml`:

```bash
cat >> monitoring-values.yaml << 'EOF'

# ============================================
# Alertmanager config — Gmail SMTP routing
# ============================================
alertmanager:
  alertmanagerSpec:
    secrets:
      - alertmanager-gmail-smtp
  config:
    global:
      resolve_timeout: 5m
      smtp_smarthost: 'smtp.gmail.com:587'
      smtp_from: 'your-alerts@gmail.com'
      smtp_auth_username: 'your-alerts@gmail.com'
      smtp_auth_password_file: /etc/alertmanager/secrets/alertmanager-gmail-smtp/smtp-password
      smtp_require_tls: true

    route:
      receiver: 'gmail-notifications'
      group_by: ['alertname', 'namespace']
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - receiver: 'gmail-notifications'
          matchers:
            - severity =~ "warning|critical"

    receivers:
      - name: 'gmail-notifications'
        email_configs:
          - to: 'your-personal-email@gmail.com'
            send_resolved: true
EOF
```

> **Note:** `secrets:` under `alertmanagerSpec` mounts the named Secret into the Alertmanager pod at `/etc/alertmanager/secrets/<secret-name>/`, which is why `smtp_auth_password_file` points there instead of embedding the password inline. Replace `your-alerts@gmail.com` (sender) and `your-personal-email@gmail.com` (recipient) with real addresses — they can be the same account.

### Step 5.4: Apply the Updated Config

```bash
helm upgrade kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f monitoring-values.yaml
```

### Step 5.5: Define Alerting Rules for Zylo

Add a `PrometheusRule` so Alertmanager actually has something to fire on. This can live in the Zylo Helm chart alongside the `ServiceMonitor` from Phase 4.

```bash
cat > zylo/templates/prometheusrule.yaml << 'EOF'
{{- if .Values.backend.metrics.enabled }}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: zylo-alerts
  namespace: {{ .Values.namespace }}
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: zylo.rules
      rules:
        - alert: ZyloBackendDown
          expr: up{job="zylo-backend"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Zylo backend is down"
            description: "Prometheus has not been able to scrape the zylo-backend target for 2 minutes."

        - alert: ZyloBackendHighErrorRate
          expr: |
            sum(rate(http_requests_total{job="zylo-backend", status_code=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{job="zylo-backend"}[5m])) > 0.05
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Zylo backend 5xx error rate above 5%"
            description: "More than 5% of requests to zylo-backend have returned 5xx over the last 5 minutes."

        - alert: ZyloBackendHighMemory
          expr: |
            sum(container_memory_working_set_bytes{namespace="{{ .Values.namespace }}", pod=~"backend-.*"})
            > 200 * 1024 * 1024
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Zylo backend memory usage is high"
            description: "Backend pod memory usage has exceeded 200Mi for 5 minutes."
{{- end }}
EOF
```

### Step 5.6: Upgrade Zylo and Verify

```bash
helm upgrade zylo ./zylo
```

In Prometheus UI: **Alerts** tab → confirm `ZyloBackendDown`, `ZyloBackendHighErrorRate`, and `ZyloBackendHighMemory` are listed (state `Inactive` is normal until triggered).

### Step 5.7: Send a Test Alert

Trigger a manual test without waiting for a real incident:

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093
```

```bash
curl -H "Content-Type: application/json" -d '[{
  "labels": {
    "alertname": "ZyloTestAlert",
    "severity": "critical",
    "namespace": "zylo"
  },
  "annotations": {
    "summary": "Test alert to confirm Gmail SMTP delivery"
  }
}]' http://localhost:9093/api/v2/alerts
```

Check your Gmail inbox (and spam folder, the first time) for the notification.

---

## Phase 6: Import and Design Dashboards in Grafana

### Step 6.1: Add the Prebuilt Kubernetes Dashboards

`kube-prometheus-stack` ships default dashboards automatically (Cluster, Nodes, Pods) under **Dashboards → Kubernetes / Compute Resources**.

### Step 6.2: Import a Node.js Community Dashboard as a Starting Point

**Dashboards → New → Import** → enter dashboard ID `11159` (Node.js Application Dashboard), select the **Prometheus** data source when prompted, and click **Import**. Use this as a reference while you build the Zylo-specific one below.

### Step 6.3: Create a New Dashboard and Folder

1. **Dashboards → New → New Folder** → name it `Zylo`
2. **Dashboards → New → New Dashboard** → **Save dashboard** into the `Zylo` folder, name it `Zylo — Application Overview`

Keeping dashboards in a dedicated folder keeps them separate from the cluster-level ones imported in Step 6.1.

### Step 6.4: Add Dashboard Variables (Templating)

Variables let one dashboard serve multiple environments/releases without duplicating panels.

**Dashboard settings (gear icon) → Variables → Add variable:**

| Name        | Type     | Query                                             | Purpose                                                                        |
| ----------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `namespace` | Query    | `label_values(up{job="zylo-backend"}, namespace)` | switch between environments if you later run `zylo-staging`, `zylo-prod`, etc. |
| `interval`  | Interval | `1m,5m,15m,1h`                                    | control the rate-window used in panel queries                                  |

Reference them in queries as `$namespace` and `$interval`.

### Step 6.5: Build the Panels

Use **Add → Visualization** for each panel below. Organize them into two **rows** first (**Add → Row**): `Traffic & Errors` and `Resource Usage`.

**Row: Traffic & Errors**

| Panel                   | Visualization                     | Query                                                                                                                                                                                                     |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request Rate            | Time series                       | `sum(rate(http_requests_total{job="zylo-backend", namespace="$namespace"}[$interval])) by (route)`                                                                                                        |
| Error Rate (%)          | Time series (unit: Percent 0-100) | `100 * sum(rate(http_requests_total{job="zylo-backend", namespace="$namespace", status_code=~"5.."}[$interval])) / sum(rate(http_requests_total{job="zylo-backend", namespace="$namespace"}[$interval]))` |
| p95 Latency             | Time series (unit: seconds)       | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="zylo-backend", namespace="$namespace"}[$interval])) by (le))`                                                                |
| Requests by Status Code | Bar gauge or Pie chart            | `sum(rate(http_requests_total{job="zylo-backend", namespace="$namespace"}[$interval])) by (status_code)`                                                                                                  |

**Row: Resource Usage**

| Panel                | Visualization             | Query                                                                                                            |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Backend Pod Memory   | Time series (unit: bytes) | `sum(container_memory_working_set_bytes{namespace="$namespace", pod=~"backend-.*"}) by (pod)`                    |
| Backend Pod CPU      | Time series (unit: cores) | `sum(rate(container_cpu_usage_seconds_total{namespace="$namespace", pod=~"backend-.*"}[$interval])) by (pod)`    |
| Pod Restarts         | Stat (with thresholds)    | `sum(kube_pod_container_status_restarts_total{namespace="$namespace", pod=~"backend-.*"})`                       |
| Postgres Connections | Time series               | `pg_stat_database_numbackends{namespace="$namespace"}` (requires `postgres_exporter`, optional — see note below) |

> **Note:** the Postgres panel requires the `prometheus-postgres-exporter` chart running as a sidecar or standalone deployment scraping the `postgres-db` service; it's not covered by the `ServiceMonitor` from Phase 4, which only targets the backend. Skip that panel if you haven't deployed the exporter.

### Step 6.6: Set Panel Thresholds and Alerts Visually

For panels like **Error Rate (%)** and **Pod Restarts**, open the panel's **Edit → Thresholds** tab and set:

- Green: `0`
- Yellow: `2` (restarts) or `1` (error % )
- Red: `5` (restarts) or `5` (error %)

This colors the panel/stat directly in the dashboard, separate from the Alertmanager rules in Phase 5 — useful for at-a-glance viewing without needing an email.

### Step 6.7: Arrange and Save

Drag panels into a readable layout (traffic panels wide on top, resource panels below), then **Save dashboard** (top right). Use **Save As** if you want to keep the community-imported dashboard from Step 6.2 untouched as a reference.

### Step 6.8: Export the Dashboard as Code

Once you're happy with the layout, export it so it's versioned in Git rather than living only in Grafana's database:

**Dashboard settings → JSON Model → Copy to clipboard**, then save it into your repo:

```bash
mkdir -p zylo-dashboards
cat > zylo-dashboards/zylo-application-overview.json << 'EOF'
# paste the JSON Model content here
EOF
```

### Step 6.9: (Optional) Provision the Dashboard Automatically on Install

Rather than manually re-importing after every fresh install, load it via a Grafana dashboard ConfigMap so `kube-prometheus-stack`'s sidecar picks it up automatically:

```bash
kubectl create configmap zylo-application-overview \
  -n monitoring \
  --from-file=zylo-dashboards/zylo-application-overview.json \
  --dry-run=client -o yaml | \
  kubectl label --local -f - grafana_dashboard=1 -o yaml --dry-run=client > zylo-dashboard-configmap.yaml

kubectl apply -f zylo-dashboard-configmap.yaml
```

The `grafana_dashboard: "1"` label is what `kube-prometheus-stack`'s dashboard sidecar watches for — Grafana will pick up the ConfigMap within a minute or two without a restart.

---

## Troubleshooting (Part A)

| Issue                                                        | Solution                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grafana/Prometheus pods `Pending`                            | Check `kubectl describe pod` — usually PVC not bound; confirm `storageClassName` matches `kubectl get storageclass` output                                                                                                        |
| `ServiceMonitor` target not showing in Prometheus            | Confirm the `release:` label matches the value of `--set` / release name used during `helm install`, and that `serviceMonitorSelectorNilUsesHelmValues` wasn't left restricting to a different label                              |
| Can't reach NodePort 30900/30300                             | Confirm security group allows those ports, or use SSH port-forward instead                                                                                                                                                        |
| Grafana shows "no data"                                      | Check the Prometheus data source URL in Grafana points to `http://kube-prometheus-stack-prometheus.monitoring.svc:9090`                                                                                                           |
| High memory pressure on the node                             | Lower `prometheus.prometheusSpec.retention`, disable `kubeStateMetrics`/`nodeExporter` if not needed, or move Grafana/Prometheus to a bigger instance                                                                             |
| No Gmail email received                                      | Check spam folder first; confirm the App Password (not your normal Gmail password) was used, and that `smtp_auth_username`/`smtp_from` match the Gmail account that generated the App Password                                    |
| Alertmanager pod `CrashLoopBackOff` after adding SMTP config | Check `kubectl logs -n monitoring alertmanager-kube-prometheus-stack-alertmanager-0` — usually a YAML indentation error in `alertmanager.config`, or the secret name in `alertmanagerSpec.secrets` not matching the actual Secret |
| `smtp_auth_password_file` not found                          | Confirm the Secret was created in the `monitoring` namespace before `helm upgrade`, and that its name exactly matches the one listed under `alertmanagerSpec.secrets`                                                             |
| Alerts stuck `Pending`/never fire                            | Check the `for:` duration in the `PrometheusRule` — the condition must hold continuously for that whole window before it fires                                                                                                    |
| Dashboard panel shows "No data" for a Postgres query         | The Postgres panel needs `prometheus-postgres-exporter` deployed separately — Phase 4's `ServiceMonitor` only covers the backend                                                                                                  |

---

# Part B: Secrets Management with HashiCorp Vault

## Phase 1: Install Vault via Helm

### Step 1.1: Add the HashiCorp Helm Repo

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
```

### Step 1.2: Create the Vault Namespace

```bash
kubectl create namespace vault
```

### Step 1.3: Create a Lightweight `values.yaml` for a Single-Node Raft Cluster

Production Vault normally runs 3+ replicas with Raft consensus; on a single t3.medium node, run 1 replica (no HA) but still use the Raft storage backend so data persists across restarts.

```bash
cat > vault-values.yaml << 'EOF'
server:
  ha:
    enabled: false

  dataStorage:
    enabled: true
    size: 2Gi
    storageClass: microk8s-hostpath

  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 300m
      memory: 512Mi

  service:
    type: NodePort
    nodePort: 30820

  # Standalone mode — single pod, file/raft-backed, manually unsealed
  standalone:
    enabled: true
    config: |
      ui = true
      listener "tcp" {
        address = "[::]:8200"
        tls_disable = true
      }
      storage "raft" {
        path = "/vault/data"
      }

injector:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 150m
      memory: 128Mi

ui:
  enabled: true
  serviceType: NodePort
  serviceNodePort: 30820
EOF
```

> **Note:** `tls_disable = true` is acceptable here because Vault sits behind the same private EC2 node as everything else and is only reached via SSH tunnel/NodePort restricted by the security group. For anything beyond a lab/internship setup, terminate TLS at an Ingress or enable Vault's own TLS listener.

### Step 1.4: Install the Chart

```bash
helm install vault hashicorp/vault \
  -n vault \
  -f vault-values.yaml
```

### Step 1.5: Verify

```bash
kubectl get pods -n vault
```

`vault-0` will show `0/1 Running` — this is expected. Vault starts **sealed and uninitialized**; it won't pass readiness checks until you initialize and unseal it in the next phase. The `vault-agent-injector-*` pod should already show `1/1 Running`.

---

## Phase 2: Initialize and Unseal Vault

### Step 2.1: Initialize Vault

```bash
kubectl exec -n vault -it vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init-output.json
```

> **Critical:** `vault-init-output.json` contains the 5 unseal keys and the initial root token. Copy it off the EC2 instance immediately (e.g. `scp` it to your local machine) and store it somewhere safe like a password manager — this file is not something you commit to Git or leave sitting on the server.

### Step 2.2: Extract the Unseal Keys and Root Token

```bash
cat vault-init-output.json | jq -r '.unseal_keys_b64[]'
cat vault-init-output.json | jq -r '.root_token'
```

### Step 2.3: Unseal Vault

Vault requires a threshold number of unseal keys (3 of the 5 generated above) every time the pod restarts, since it's running standalone (not auto-unseal via cloud KMS).

```bash
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_1>
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_2>
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_3>
```

### Step 2.4: Confirm Vault Is Unsealed and Ready

```bash
kubectl exec -n vault -it vault-0 -- vault status
kubectl get pods -n vault
```

`vault-0` should now show `1/1 Running` with `Sealed: false`.

---

## Phase 3: Enable the KV Secrets Engine and Store Zylo Secrets

### Step 3.1: Log In with the Root Token (Interactive Session)

```bash
kubectl exec -n vault -it vault-0 -- /bin/sh
export VAULT_TOKEN=<root_token>
vault login $VAULT_TOKEN
```

### Step 3.2: Enable KV Version 2 at a `zylo/` Path

```bash
vault secrets enable -path=zylo kv-v2
```

### Step 3.3: Write the Postgres Credentials

```bash
vault kv put zylo/database \
  POSTGRES_USER="zylo_user" \
  POSTGRES_PASSWORD="<strong-password>" \
  POSTGRES_DB="zylo_db"
```

### Step 3.4: Verify

```bash
vault kv get zylo/database
```

Exit back out of the pod shell once done (`exit`).

---

## Phase 4: Configure Kubernetes Auth so Pods Can Read Secrets

### Step 4.1: Enable the Kubernetes Auth Method

```bash
kubectl exec -n vault -it vault-0 -- /bin/sh
export VAULT_TOKEN=<root_token>

vault auth enable kubernetes
```

### Step 4.2: Configure It to Trust the Cluster's Service Account Tokens

```bash
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443"
```

### Step 4.3: Create a Policy Granting Read Access to Zylo's Secrets

```bash
vault policy write zylo-backend-policy - << 'EOF'
path "zylo/data/database" {
  capabilities = ["read"]
}
EOF
```

### Step 4.4: Bind the Policy to a Kubernetes Service Account

This ties the policy to the `backend` service account in the `zylo` namespace (created by the Zylo Helm chart's `serviceaccount.yaml`).

```bash
vault write auth/kubernetes/role/zylo-backend \
  bound_service_account_names=backend \
  bound_service_account_namespaces=zylo \
  policies=zylo-backend-policy \
  ttl=1h
```

Exit the pod shell (`exit`).

---

## Phase 5: Inject Secrets into Zylo Pods with the Vault Agent Injector

Rather than storing `POSTGRES_PASSWORD` in a Kubernetes `Secret` (as `templates/secret.yaml` currently does), the Vault Agent Injector sidecar fetches it directly from Vault at pod startup and writes it to a file inside the pod.

### Step 5.1: Add Vault Annotations to the Backend Deployment

Edit `zylo/templates/deployment.yaml` (backend section) to add annotations under `spec.template.metadata`:

```bash
cat >> zylo/templates/deployment-backend-patch.yaml << 'EOF'
# Add these annotations to the backend Deployment's pod template metadata:
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "zylo-backend"
  vault.hashicorp.com/agent-inject-secret-database: "zylo/data/database"
  vault.hashicorp.com/agent-inject-template-database: |
    {{- with secret "zylo/data/database" -}}
    export POSTGRES_USER="{{ .Data.data.POSTGRES_USER }}"
    export POSTGRES_PASSWORD="{{ .Data.data.POSTGRES_PASSWORD }}"
    export POSTGRES_DB="{{ .Data.data.POSTGRES_DB }}"
    {{- end -}}
EOF
```

> **What this does:** the injector mutates the backend Pod on creation, adding an init container (`vault-agent-init`) and a sidecar (`vault-agent`) that authenticate to Vault using the Pod's service account token, then render the secret to `/vault/secrets/database` inside the container.

### Step 5.2: Source the Rendered Secret in the Container's Entrypoint

Update the backend's startup command (or `entrypoint.sh`/`entrypoint.py`) to source the file before starting the app:

```bash
# Example entrypoint snippet
source /vault/secrets/database
node server.js
```

### Step 5.3: Remove the Static Kubernetes Secret (Optional, Once Migrated)

Once the backend is confirmed to be pulling credentials from Vault, retire the old static Secret:

```bash
# Remove or comment out templates/secret.yaml's POSTGRES_PASSWORD field,
# keep only what Postgres itself still needs (see Step 5.4)
```

### Step 5.4: Handle the Postgres StatefulSet/Deployment Itself

Postgres's own container still needs `POSTGRES_PASSWORD` as an env var at startup (it can't source a Vault Agent file the same way an app can, unless you customize its entrypoint). Two common approaches:

- **Simplest:** keep Postgres's credentials in the existing Kubernetes `Secret`, and only migrate the **backend's read of that password** to Vault, keeping a single source of truth (Vault) with an init job that syncs Vault → K8s Secret on deploy.
- **Fuller Vault integration:** add the same `vault.hashicorp.com/agent-inject` annotations to the Postgres pod template and modify its startup to `source` the rendered file before running `docker-entrypoint.sh`.

For an internship-scale setup, the simplest approach is usually enough — Vault becomes the single source of truth that the backend reads live, while Postgres keeps a synced copy.

### Step 5.5: Upgrade the Release (or Let ArgoCD Sync It)

```bash
helm upgrade zylo ./zylo
# or push to kaibad/helm-charts and Sync from the ArgoCD UI
```

### Step 5.6: Verify Injection

```bash
kubectl get pods -n zylo
# backend pod should now show 2/2 (app container + vault-agent sidecar)

kubectl exec -n zylo <backend-pod> -c backend -- cat /vault/secrets/database
```

---

## Phase 6: Access the Vault UI

### Method 1: Direct NodePort

```
https://<EC2-PUBLIC-IP>:30820
```

### Method 2: Port-Forward + SSH Tunnel

```bash
kubectl port-forward -n vault svc/vault 8200:8200
ssh -i zylo-key.pem -L 8200:localhost:8200 ubuntu@<EC2-PUBLIC-IP>
```

Open `http://localhost:8200/ui` and log in with the root token (or better, create a scoped token for day-to-day use and retire the root token per Vault's security best practices).

---

## Troubleshooting (Part B)

| Issue                                                          | Solution                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault-0` stuck at `0/1 Running` after install                 | Expected until initialized and unsealed — run Phase 2                                                                                                                            |
| Vault re-seals after pod restart                               | Standalone mode without auto-unseal always reseals on restart; re-run `vault operator unseal` with 3 of the 5 keys, or configure cloud auto-unseal (e.g. AWS KMS) for production |
| Backend pod stuck waiting on init container `vault-agent-init` | Check `kubectl logs <pod> -c vault-agent-init` — usually a Kubernetes auth role/policy mismatch; confirm `bound_service_account_names` matches the actual service account name   |
| `permission denied` reading secret                             | Double-check the policy path — KV v2 requires the `data/` prefix in the policy (`zylo/data/database`) even though you write/read via `zylo/database` on the CLI                  |
| Can't reach Vault UI on NodePort 30820                         | Confirm security group allows the port; Vault Helm chart may need `global.tlsDisable=true` reflected consistently across `server` and `ui` sections                              |
| Lost unseal keys                                               | No recovery path without them — this is why `vault-init-output.json` must be backed up outside the cluster immediately after Phase 2                                             |

---

## Summary Flow

```
helm repo add prometheus-community / grafana / hashicorp
        │
        ▼
┌─────────────────────────────┐      ┌─────────────────────────────┐
│  Part A: Monitoring         │      │  Part B: Secrets (Vault)    │
├─────────────────────────────┤      ├─────────────────────────────┤
│ kubectl create ns monitoring│      │ kubectl create ns vault     │
│ helm install                │      │ helm install vault          │
│   kube-prometheus-stack     │      │   hashicorp/vault           │
│ (Prometheus + Grafana,      │      │ vault operator init         │
│  Alertmanager disabled)     │      │ vault operator unseal x3    │
│        │                    │      │        │                    │
│        ▼                    │      │        ▼                    │
│ Add ServiceMonitor for      │      │ vault secrets enable        │
│ zylo-backend /metrics       │      │   -path=zylo kv-v2          │
│        │                    │      │ vault kv put zylo/database  │
│        ▼                    │      │        │                    │
│ Gmail App Password → Secret │      │        ▼                    │
│ Alertmanager SMTP config +  │      │ vault auth enable kubernetes│
│ PrometheusRule alert rules  │      │ policy + role bound to      │
│        │                    │      │ backend service account     │
│        ▼                    │      │        │                    │
│ Design Grafana dashboards:  │      │        ▼                    │
│ folder, variables, panels,  │      │ Annotate backend Deployment │
│ thresholds → export as JSON │      │ → Vault Agent Injector      │
│ → optionally provision via  │      │ sidecar renders secret file │
│ ConfigMap                   │      │                              │
└─────────────────────────────┘      └─────────────────────────────┘
        │                                     │
        ▼                                     ▼
helm upgrade zylo . (or ArgoCD Sync from kaibad/helm-charts)
        │
        ▼
Zylo now emits metrics scraped by Prometheus, visualized in Grafana,
and reads its database credentials live from Vault instead of a static Secret
```
