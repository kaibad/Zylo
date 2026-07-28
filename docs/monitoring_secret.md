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
kubectl port-forward -n zylo svc/zylo-backend 5000:5000
curl http://localhost:5000/metrics
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

# Part B: Secrets Management with HashiCorp Vault (Dedicated Server)

> Vault runs on its own small EC2 instance, separate from the Zylo/ArgoCD/monitoring server. This keeps secrets management isolated on its own blast radius and its own resource budget, and mirrors how Vault is commonly run in the real world — as a standalone service other clusters talk to, rather than another workload competing for the same node. The Zylo cluster only runs the lightweight **Vault Agent Injector**, which talks out to this external Vault over the network.

**Architecture:**

```
┌────────────────────────────┐        ┌──────────────────────────────────┐
│  Server 1 (existing)       │        │  Server 2 (new, dedicated)       │
│  microk8s-zylo-server       │        │  vault-server                    │
│  t3.medium                  │        │  t3.small                        │
├────────────────────────────┤        ├──────────────────────────────────┤
│ MicroK8s cluster             │        │ MicroK8s cluster (single node)    │
│  - Zylo (backend/frontend/db)│  HTTP  │  - Vault (server mode, Raft)      │
│  - ArgoCD                    │◄──────►│  - reachable on NodePort :30820   │
│  - kube-prometheus-stack     │  8200  │                                   │
│  - Vault Agent Injector only │        │                                   │
│    (server.enabled=false)    │        │                                   │
└────────────────────────────┘        └──────────────────────────────────┘
```

**Prerequisites:**

- An AWS account with the same VPC as your existing EC2 instance (so the two servers can reach each other over private IPs, or over public IPs with tightly scoped security groups)
- A new key pair, or reuse `zylo-key.pem`

---

## Phase 1: Launch the Dedicated Vault Server

### Step 1.1: Create the EC2 Instance

1. **AWS Console → EC2 → Launch Instance**
2. **Name:** `vault-server`
3. **AMI:** Ubuntu Server 24.04 LTS, 64-bit (x86)
4. **Instance Type:** `t3.small` (2 vCPU, 2 GB RAM) — Vault alone is light; this is smaller than the `t3.medium` used for Zylo since it isn't sharing the node with anything else
5. **Key Pair:** reuse `zylo-key.pem` or create `vault-key`
6. **Network Settings:** same VPC as `microk8s-zylo-server` so the two instances share private networking
7. **Security Group** (`vault-server-sg`) — **Inbound:**

| Type       | Protocol | Port Range | Source                                                          | Description                                                    |
| ---------- | -------- | ---------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| SSH        | TCP      | 22         | My IP                                                           | SSH access                                                     |
| Custom TCP | TCP      | 30820      | `microk8s-zylo-server`'s security group (or its private IP /32) | Vault API/UI — scoped to the Zylo server only, not `0.0.0.0/0` |
| Custom TCP | TCP      | 16443      | My IP                                                           | MicroK8s API server (needed only for your own admin access)    |

> **Important:** Unlike the Zylo server's NodePort range, don't open `30820` to `0.0.0.0/0` — Vault holds real secrets. Restrict the source to the Zylo server's security group ID (`sg-xxxxxxxx`) so only that instance can reach it.

8. **Storage:** 20 GB GP3
9. Click **Launch Instance**

### Step 1.2: Connect

```bash
chmod 400 vault-key.pem
ssh -i vault-key.pem ubuntu@<VAULT-SERVER-PUBLIC-IP>
```

---

## Phase 2: Install Prerequisites (kubectl, Helm, MicroK8s)

Same baseline as the Zylo server, condensed here since it's the identical process — see `microk8s-and-helm.md` for the full explanation of each step.

```bash
# System update
sudo apt-get update && sudo apt-get upgrade -y

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl

# Helm
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh
./get_helm.sh

# MicroK8s
sudo snap install microk8s --classic --channel=1.31/stable
sudo usermod -aG microk8s $USER
mkdir -p ~/.kube && sudo chown -R $USER ~/.kube
newgrp microk8s

microk8s status --wait-ready
microk8s enable dns hostpath-storage helm3

microk8s config > ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
echo "alias k='microk8s kubectl'" >> ~/.bashrc
echo "alias kubectl='microk8s kubectl'" >> ~/.bashrc
echo "alias helm='microk8s helm3'" >> ~/.bashrc
source ~/.bashrc
```

> **Note:** this instance doesn't need `ingress`, `metrics-server`, `registry`, or `dashboard` — it only ever runs one workload (Vault), so skip those addons to keep it lean.

---

## Phase 3: Install Vault (Server Mode Only)

### Step 3.1: Add the HashiCorp Helm Repo

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
```

### Step 3.2: Create the Vault Namespace

```bash
kubectl create namespace vault
```

### Step 3.3: Create `values.yaml` — Server Only, No Injector

The injector runs on the **Zylo cluster** in Phase 8, not here. This server only needs the Vault backend itself.

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

# This server only runs Vault itself — the injector lives on the Zylo cluster
injector:
  enabled: false

ui:
  enabled: true
  serviceType: NodePort
  serviceNodePort: 30820
EOF
```

> **Note:** `tls_disable = true` is workable here because the security group in Phase 1 already restricts port `30820` to only the Zylo server's IP. For anything beyond an internship/lab setup, put a TLS listener or a reverse proxy with a real certificate in front of Vault, since traffic is now crossing between two separate EC2 instances instead of staying inside one cluster.

### Step 3.4: Install the Chart

```bash
helm install vault hashicorp/vault \
  -n vault \
  -f vault-values.yaml
```

### Step 3.5: Verify

```bash
kubectl get pods -n vault
```

`vault-0` will show `0/1 Running` — expected until initialized/unsealed in Phase 4. No `vault-agent-injector` pod should appear here, since it's disabled.

---

## Phase 4: Initialize and Unseal Vault

### Step 4.1: Initialize

```bash
kubectl exec -n vault -it vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init-output.json
```

> **Critical:** copy `vault-init-output.json` off this instance immediately (`scp` it to your local machine, then delete it from the server) and store the unseal keys and root token somewhere safe like a password manager.

### Step 4.2: Extract Keys and Root Token

```bash
cat vault-init-output.json | jq -r '.unseal_keys_b64[]'
cat vault-init-output.json | jq -r '.root_token'
```

### Step 4.3: Unseal

```bash
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_1>
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_2>
kubectl exec -n vault -it vault-0 -- vault operator unseal <unseal_key_3>
```

### Step 4.4: Confirm

```bash
kubectl exec -n vault -it vault-0 -- vault status
kubectl get pods -n vault
```

`vault-0` should now show `1/1 Running`, `Sealed: false`.

---

## Phase 5: Enable the KV Secrets Engine and Store Zylo Secrets

### Step 5.1: Log In with the Root Token

```bash
kubectl exec -n vault -it vault-0 -- /bin/sh
export VAULT_TOKEN=<root_token>
vault login $VAULT_TOKEN
```

### Step 5.2: Enable KV v2 at `zylo/`

```bash
vault secrets enable -path=zylo kv-v2
```

### Step 5.3: Write the Postgres Credentials

```bash
vault kv put zylo/database \
  POSTGRES_USER="zylo_user" \
  POSTGRES_PASSWORD="<strong-password>" \
  POSTGRES_DB="zylo_db"
```

### Step 5.4: Verify

```bash
vault kv get zylo/database
```

Exit the pod shell (`exit`) once done.

---

## Phase 6: Trust the Zylo Cluster's Kubernetes API (Cross-Cluster Auth)

This is the part that's different from a same-cluster install: Vault's Kubernetes auth method needs to validate service account tokens issued by the **Zylo cluster's** API server — a different cluster than the one Vault itself runs on. That means Vault needs the Zylo API server's externally-reachable address, its CA certificate, and a reviewer token, instead of auto-detecting them from its own mounted service account.

### Step 6.1: On the Zylo Server — Create a Dedicated Service Account for Token Review

```bash
# Run these on microk8s-zylo-server
kubectl create serviceaccount vault-auth -n default

kubectl create clusterrolebinding vault-auth-binding \
  --clusterrole=system:auth-delegator \
  --serviceaccount=default:vault-auth
```

### Step 6.2: Create a Long-Lived Token for That Service Account

Kubernetes 1.24+ no longer auto-generates a Secret with a token for every ServiceAccount, so create one explicitly:

```bash
cat > vault-auth-token-secret.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: vault-auth-token
  namespace: default
  annotations:
    kubernetes.io/service-account.name: vault-auth
type: kubernetes.io/service-account-token
EOF

kubectl apply -f vault-auth-token-secret.yaml
```

### Step 6.3: Extract the Reviewer Token and the Cluster's CA Certificate

```bash
# Reviewer JWT
kubectl get secret vault-auth-token -n default \
  -o jsonpath='{.data.token}' | base64 -d > reviewer-token.txt

# CA cert used by the Zylo API server
kubectl get secret vault-auth-token -n default \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > zylo-ca.crt

# The Zylo cluster's externally reachable API endpoint
microk8s config | grep server
# → https://<ZYLO-SERVER-PUBLIC-OR-PRIVATE-IP>:16443
```

Copy `reviewer-token.txt` and `zylo-ca.crt` to the Vault server (`scp` them over, or paste contents directly in the next step).

```bash
scp -i zylo-key.pem reviewer-token.txt zylo-ca.crt ubuntu@<VAULT-SERVER-IP>:~/
```

### Step 6.4: On the Vault Server — Configure the Kubernetes Auth Method

```bash
# Copy the two files into the vault-0 pod
kubectl cp reviewer-token.txt vault/vault-0:/tmp/reviewer-token.txt
kubectl cp zylo-ca.crt vault/vault-0:/tmp/zylo-ca.crt

kubectl exec -n vault -it vault-0 -- /bin/sh
export VAULT_TOKEN=<root_token>

vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://<ZYLO-SERVER-PRIVATE-IP>:16443" \
  kubernetes_ca_cert=@/tmp/zylo-ca.crt \
  token_reviewer_jwt=@/tmp/reviewer-token.txt
```

> **Note:** use the Zylo server's **private IP** for `kubernetes_host` if both instances share a VPC (faster, doesn't cross the public internet); use the public IP only if they're in different networks, and make sure the Zylo server's security group allows inbound `16443` from the Vault server in that case.

### Step 6.5: Create the Policy and Role (Same as Before)

```bash
vault policy write zylo-backend-policy - << 'EOF'
path "zylo/data/database" {
  capabilities = ["read"]
}
EOF

vault write auth/kubernetes/role/zylo-backend \
  bound_service_account_names=backend \
  bound_service_account_namespaces=zylo \
  policies=zylo-backend-policy \
  ttl=1h
```

Exit the pod shell (`exit`).

---

## Phase 7: Install the Vault Agent Injector on the Zylo Cluster

Back on `microk8s-zylo-server`, install only the injector component — no server, no storage — pointed at the external Vault.

### Step 7.1: Add the Helm Repo (If Not Already Added)

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update
```

### Step 7.2: Install the Injector

```bash
kubectl create namespace vault

helm install vault hashicorp/vault \
  -n vault \
  --set "server.enabled=false" \
  --set "injector.enabled=true" \
  --set "injector.externalVaultAddr=http://<VAULT-SERVER-PRIVATE-IP>:30820" \
  --set "injector.resources.requests.cpu=50m" \
  --set "injector.resources.requests.memory=64Mi" \
  --set "injector.resources.limits.cpu=150m" \
  --set "injector.resources.limits.memory=128Mi"
```

### Step 7.3: Verify

```bash
kubectl get pods -n vault
# only vault-agent-injector-* should appear here, 1/1 Running
```

---

## Phase 8: Inject Secrets into Zylo Pods

Identical to a same-cluster setup from the application's point of view — the annotations don't change, only where they point to under the hood (the external Vault via the injector configured in Phase 7).

### Step 8.1: Add Vault Annotations to the Backend Deployment

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

### Step 8.2: Source the Rendered Secret in the Container's Entrypoint

```bash
# Example entrypoint snippet
source /vault/secrets/database
node server.js
```

### Step 8.3: Handle Postgres Itself

Same guidance as a same-cluster setup: keep Postgres's own credentials in the existing Kubernetes `Secret` for simplicity, and let only the backend read live from Vault — or extend the same annotations to Postgres's pod template if you want full coverage.

### Step 8.4: Upgrade the Release (or Let ArgoCD Sync It)

```bash
helm upgrade zylo ./zylo
# or push to kaibad/helm-charts and Sync from the ArgoCD UI
```

### Step 8.5: Verify Injection

```bash
kubectl get pods -n zylo
# backend pod should now show 2/2 (app container + vault-agent sidecar)

kubectl exec -n zylo <backend-pod> -c backend -- cat /vault/secrets/database
```

---

## Phase 9: Access the Vault UI

### Method 1: Direct NodePort (from the Zylo server or your own IP, both allowed by the security group in Phase 1)

```
http://<VAULT-SERVER-IP>:30820
```

### Method 2: Port-Forward + SSH Tunnel (from your local machine, through the Vault server)

```bash
# On the Vault server
kubectl port-forward -n vault svc/vault 8200:8200

# From your local machine
ssh -i vault-key.pem -L 8200:localhost:8200 ubuntu@<VAULT-SERVER-PUBLIC-IP>
```

Open `http://localhost:8200/ui` and log in with the root token (create a scoped token for daily use afterward).

---

## Troubleshooting (Part B)

| Issue                                                                                 | Solution                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vault-0` stuck at `0/1 Running` after install                                        | Expected until initialized and unsealed — run Phase 4                                                                                                                                                        |
| Vault re-seals after pod restart                                                      | Standalone mode without auto-unseal always reseals on restart; re-run `vault operator unseal` with 3 of the 5 keys, or configure cloud auto-unseal (e.g. AWS KMS) for production                             |
| Injector can't reach `externalVaultAddr`                                              | Confirm the Vault server's security group allows inbound `30820` from the Zylo server specifically; test with `curl http://<VAULT-SERVER-IP>:30820/v1/sys/health` from the Zylo server itself                |
| Backend pod stuck on init container `vault-agent-init` with a TLS or connection error | Check `kubectl logs <pod> -c vault-agent-init` on the Zylo cluster — usually the injector's `externalVaultAddr` is wrong, unreachable, or using `https://` when Vault has `tls_disable = true`               |
| `error validating token: claim "iss" is invalid` or similar during login              | The `kubernetes_host`, `kubernetes_ca_cert`, or `token_reviewer_jwt` configured in Phase 6 don't match the Zylo cluster's actual API server; re-extract them and re-run `vault write auth/kubernetes/config` |
| `permission denied` reading secret                                                    | Double-check the policy path — KV v2 requires the `data/` prefix (`zylo/data/database`) even though you write/read via `zylo/database` on the CLI                                                            |
| Reviewer token expired                                                                | Service-account tokens created via a Secret (Step 6.2) are long-lived by default, but if it was created differently, regenerate it and re-run Step 6.4                                                       |
| Can't reach Vault UI on NodePort 30820                                                | Confirm the security group source is your IP (for direct browser access) or the Zylo server's IP (for the injector) — not both blocked by an overly narrow rule                                              |
| Lost unseal keys                                                                      | No recovery path without them — back up `vault-init-output.json` outside the server immediately after Phase 4                                                                                                |

---

## Summary Flow

```
Server 1: microk8s-zylo-server          Server 2: vault-server (new, dedicated)
─────────────────────────────           ───────────────────────────────────────
                                          Launch EC2 t3.small
                                          Install kubectl, Helm, MicroK8s
                                          helm install vault hashicorp/vault
                                            (server.enabled=true, injector.enabled=false)
                                          vault operator init
                                          vault operator unseal x3
                                          vault secrets enable -path=zylo kv-v2
                                          vault kv put zylo/database ...
                                                    │
kubectl create sa vault-auth                        │
kubectl create clusterrolebinding                   │
  vault-auth-binding (system:auth-delegator)         │
kubectl apply -f vault-auth-token-secret.yaml        │
Extract reviewer-token.txt + zylo-ca.crt   ────────► │
                                          vault auth enable kubernetes
                                          vault write auth/kubernetes/config
                                            kubernetes_host / ca_cert / reviewer_jwt
                                          vault policy write zylo-backend-policy
                                          vault write auth/kubernetes/role/zylo-backend
                                                    │
helm install vault hashicorp/vault                  │
  (server.enabled=false, injector.enabled=true,      │
   externalVaultAddr=http://vault-server:30820) ◄────┘

Annotate backend Deployment with
  vault.hashicorp.com/agent-inject: "true"
helm upgrade zylo . (or ArgoCD Sync)
                    │
                    ▼
Backend pod now runs with a vault-agent sidecar that authenticates
to the external Vault server using its Kubernetes service account,
and renders POSTGRES_USER/PASSWORD/DB to /vault/secrets/database at startup
```
