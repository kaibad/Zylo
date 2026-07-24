# Complete Step-by-Step Guide: EC2 → MicroK8s → Helm → Zylo Deployment

> **Goal:** Launch an EC2 instance, install MicroK8s, create a Helm chart from your K8s manifests, and deploy the Zylo application — all from scratch.

---

## Phase 1: Launch EC2 Instance on AWS

### Step 1.1: Create an AWS EC2 Instance

1. Log in to **AWS Console** → Go to **EC2** → Click **Launch Instance**

2. **Name:** `microk8s-zylo-server`

3. **Application and OS Images (AMI):**
   - Select **Ubuntu Server 26.04 LTS** (or 24.04 LTS)
   - Architecture: **64-bit (x86)**

4. **Instance Type:**
   - Select **t3.medium** (2 vCPU, 4 GB RAM) — minimum for MicroK8s
   - For production workloads, use **t3.large** or bigger

5. **Key Pair:**
   - Create a new key pair (e.g., `zylo-key`)
   - Download the `.pem` file and keep it safe!

6. **Network Settings:**
   - **VPC:** Default VPC
   - **Auto-assign public IP:** Enable
   - **Security Group:** Create new security group

7. **Security Group Rules (Inbound):**

| Type       | Protocol | Port Range  | Source    | Description         |
| ---------- | -------- | ----------- | --------- | ------------------- |
| SSH        | TCP      | 22          | My IP     | SSH access          |
| HTTP       | TCP      | 80          | 0.0.0.0/0 | Web traffic         |
| HTTPS      | TCP      | 443         | 0.0.0.0/0 | Secure web          |
| Custom TCP | TCP      | 16443       | My IP     | MicroK8s API server |
| Custom TCP | TCP      | 30000-32767 | 0.0.0.0/0 | Kubernetes NodePort |

8. **Storage:**
   - Size: **20 GB** minimum (GP3 recommended)
   - Delete on termination: Uncheck if you want persistent data

9. Click **Launch Instance**

### Step 1.2: Connect to Your EC2 Instance

```bash
# On your local machine, set permissions on the key file
chmod 400 zylo-key.pem

# Connect via SSH (replace with your EC2 Public IP)
ssh -i zylo-key.pem ubuntu@<EC2-PUBLIC-IP>
```

> **Tip:** Find your EC2 Public IPv4 address in the AWS EC2 Console under "Instances".

---

## Phase 2: Install Prerequisites on EC2

### Step 2.1: Update System Packages

```bash
# Run these commands ON the EC2 instance
sudo apt-get update && sudo apt-get upgrade -y
```

### Step 2.2: Install Docker (Optional but Recommended)

MicroK8s uses its own container runtime (containerd), but Docker is useful for building images locally.

```bash
# Install Docker from Ubuntu repositories
sudo apt-get install -y docker.io

# Add your user to the docker group
sudo usermod -aG docker $USER

# Verify Docker installation
sudo systemctl enable docker
sudo systemctl start docker
docker --version
```

> **Note:** Log out and log back in for the docker group to take effect, OR run `newgrp docker`.

### Step 2.3: Install kubectl (Standalone)

```bash
# Download latest kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"

# Install it
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Clean up
rm kubectl

# Verify
kubectl version --client
```

### Step 2.4: Install Helm

```bash
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh
./get_helm.sh
```

---

## Phase 3: Install and Configure MicroK8s

### Step 3.1: Install MicroK8s via Snap

```bash
# Install MicroK8s (uses snap, which is pre-installed on Ubuntu)
sudo snap install microk8s --classic --channel=1.31/stable

# Wait for installation to complete (takes 1-2 minutes)
```

### Step 3.2: Add User to microk8s Group

```bash
# Add current user to microk8s group
sudo usermod -aG microk8s $USER

# Create .kube directory for kubectl config
mkdir -p ~/.kube
sudo chown -R $USER ~/.kube

# Apply group changes without logging out
newgrp microk8s
```

> **Note:** On some Ubuntu versions, `newgrp` requires `util-linux-extra`. If it fails:
>
> ```bash
> sudo apt install util-linux-extra
> newgrp microk8s
> ```

### Step 3.3: Verify MicroK8s Installation

```bash
# Wait for MicroK8s to be fully ready
microk8s status --wait-ready

# Check cluster status
microk8s status

# Verify nodes
microk8s kubectl get nodes

# Check all system pods
microk8s kubectl get pods -A
```

### Step 3.4: Enable Required MicroK8s Add-ons

```bash
# Enable essential add-ons one by one

# 1. DNS (CoreDNS) — REQUIRED for service discovery
microk8s enable dns

# 2. Storage (hostpath-storage) — REQUIRED for PVC/PV
microk8s enable hostpath-storage

# 3. Ingress — for external HTTP/HTTPS access
microk8s enable ingress

# 4. Metrics Server — for resource monitoring
microk8s enable metrics-server

# 5. Helm 3 — built-in Helm support
microk8s enable helm3

# 6. Dashboard — optional, for web UI
microk8s enable dashboard

# 7. Registry — optional, for local image registry
microk8s enable registry

# Verify all addons are enabled
microk8s status
```

### Step 3.5: Configure kubectl to Use MicroK8s

```bash
# Export MicroK8s config to ~/.kube/config
microk8s config > ~/.kube/config

# Set KUBECONFIG environment variable
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
source ~/.bashrc

# Create aliases for convenience
echo "alias k='microk8s kubectl'" >> ~/.bashrc
echo "alias kubectl='microk8s kubectl'" >> ~/.bashrc
echo "alias helm='microk8s helm3'" >> ~/.bashrc
source ~/.bashrc

# Test kubectl
kubectl get nodes
kubectl get pods -A
```

### Step 3.6: Create HostPath Directory for PostgreSQL

```bash
# Create the directory that Postgres will use for persistent storage
sudo mkdir -p /data/postgres

# Set permissions (postgres container runs as user 999)
sudo chmod 777 /data/postgres
sudo chown -R 999:999 /data/postgres

# Verify
ls -la /data/
```

---

## Phase 4: Create Helm Chart from Your K8s Manifests

### Step 4.1: Create Helm Chart Skeleton

```bash
# Create a new Helm chart named "zylo"
helm create zylo

# This creates the following structure:
# zylo/
# ├── Chart.yaml
# ├── values.yaml
# ├── charts/
# └── templates/
#     ├── NOTES.txt
#     ├── _helpers.tpl
#     ├── deployment.yaml
#     ├── hpa.yaml
#     ├── ingress.yaml
#     ├── service.yaml
#     ├── serviceaccount.yaml
#     └── tests/
```

### Step 4.2: Clean Up Default Templates

```bash
cd zylo

# Remove default templates (we will replace with our own)
rm -f templates/*.yaml
rm -rf templates/tests/

# Keep only _helpers.tpl and NOTES.txt (we will customize them)
```

### Step 4.3: Update Chart.yaml

```bash
cat > Chart.yaml << 'EOF'
apiVersion: v2
name: zylo
description: A Helm chart for Zylo microservices (Frontend, Backend, Postgres)
type: application
version: 1.0.0
appVersion: "1.0.0"
EOF
```

### Step 4.4: Create Your Templates

Now create each template file from your existing manifests. Run these commands:

**4.4.1 — Namespace:**

```bash
cat > templates/namespace.yaml << 'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
EOF
```

**4.4.2 — Secret:**

```bash
cat > templates/secret.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: {{ .Values.namespace }}
type: Opaque
stringData:
  POSTGRES_USER: {{ .Values.database.user }}
  POSTGRES_PASSWORD: {{ .Values.database.password }}
EOF
```

**4.4.3 — ConfigMap:**

```bash
cat > templates/configmap.yaml << 'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: {{ .Values.namespace }}
data:
  POSTGRES_DB: {{ .Values.database.dbName }}
EOF
```

**4.4.4 — PersistentVolume:**

```bash
cat > templates/pv.yaml << 'EOF'
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-pv
spec:
  capacity:
    storage: {{ .Values.database.storage.size }}
  accessModes:
    - ReadWriteOnce
  storageClassName: {{ .Values.database.storage.class }}
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: {{ .Values.database.storage.hostPath }}
EOF
```

**4.4.5 — PersistentVolumeClaim:**

```bash
cat > templates/pvc.yaml << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: {{ .Values.namespace }}
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: {{ .Values.database.storage.class }}
  resources:
    requests:
      storage: {{ .Values.database.storage.size }}
EOF
```

**4.4.6 — Database Deployment:**

```bash
cat > templates/db-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-db
  namespace: {{ .Values.namespace }}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: postgres-db
  template:
    metadata:
      labels:
        app: postgres-db
    spec:
      containers:
        - name: postgres-db
          image: {{ .Values.database.image }}:{{ .Values.database.tag }}
          ports:
            - containerPort: 5432
          envFrom:
            - secretRef:
                name: postgres-secret
            - configMapRef:
                name: postgres-config
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql/data
            - name: tmp
              mountPath: /tmp
            - name: run
              mountPath: /run
          readinessProbe:
            exec:
              command:
                - sh
                - -c
                - "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 5
          livenessProbe:
            exec:
              command:
                - sh
                - -c
                - "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"
            initialDelaySeconds: 15
            periodSeconds: 20
            timeoutSeconds: 5
            failureThreshold: 5
          resources:
            {{- toYaml .Values.database.resources | nindent 12 }}
      volumes:
        - name: pgdata
          persistentVolumeClaim:
            claimName: postgres-pvc
        - name: tmp
          emptyDir: {}
        - name: run
          emptyDir: {}
EOF
```

**4.4.7 — Database Service:**

```bash
cat > templates/db-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: postgres-db
  namespace: {{ .Values.namespace }}
spec:
  type: ClusterIP
  selector:
    app: postgres-db
  ports:
    - port: 5432
      targetPort: 5432
EOF
```

**4.4.8 — Backend Deployment:**

```bash
cat > templates/backend-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: {{ .Values.namespace }}
spec:
  replicas: {{ .Values.backend.replicas }}
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      initContainers:
        - name: wait-for-postgres
          image: {{ .Values.database.image }}:{{ .Values.database.tag }}
          envFrom:
            - secretRef:
                name: postgres-secret
            - configMapRef:
                name: postgres-config
          command:
            - sh
            - -c
            - |
              until pg_isready -h postgres-db -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do
                echo "waiting for postgres-db..."
                sleep 2
              done
      containers:
        - name: backend
          image: {{ .Values.backend.image }}:{{ .Values.backend.tag }}
          imagePullPolicy: Always
          ports:
            - containerPort: 5000
          env:
            - name: PORT
              value: "5000"
            - name: DB_HOST
              value: "postgres-db"
            - name: DB_PORT
              value: "5432"
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: POSTGRES_USER
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-secret
                  key: POSTGRES_PASSWORD
            - name: DB_NAME
              valueFrom:
                configMapKeyRef:
                  name: postgres-config
                  key: POSTGRES_DB
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          readinessProbe:
            tcpSocket:
              port: 5000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 5000
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            {{- toYaml .Values.backend.resources | nindent 12 }}
      volumes:
        - name: tmp
          emptyDir: {}
EOF
```

**4.4.9 — Backend Service:**

```bash
cat > templates/backend-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: zylo-backend
  namespace: {{ .Values.namespace }}
spec:
  type: ClusterIP
  selector:
    app: backend
  ports:
    - port: 5000
      targetPort: 5000
EOF
```

**4.4.10 — Frontend Deployment:**

```bash
cat > templates/frontend-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: {{ .Values.namespace }}
spec:
  replicas: {{ .Values.frontend.replicas }}
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: {{ .Values.frontend.image }}:{{ .Values.frontend.tag }}
          ports:
            - containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
          readinessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 20
          resources:
            {{- toYaml .Values.frontend.resources | nindent 12 }}
EOF
```

**4.4.11 — Frontend Service:**

```bash
cat > templates/frontend-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: {{ .Values.namespace }}
spec:
  type: {{ .Values.frontend.service.type }}
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 8080
      {{- if eq .Values.frontend.service.type "NodePort" }}
      nodePort: {{ .Values.frontend.service.nodePort }}
      {{- end }}
EOF
```

### Step 4.5: Update values.yaml

```bash
cat > values.yaml << 'EOF'
# ============================================
# Global Settings
# ============================================
namespace: zylo

# ============================================
# PostgreSQL Database
# ============================================
database:
  image: postgres
  tag: "16.14-alpine"
  user: zylo_user
  password: "zylo_pass"          # CHANGE THIS IN PRODUCTION!
  dbName: zylo_db
  storage:
    size: 1Gi
    class: standard
    hostPath: /data/postgres
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

# ============================================
# Backend Application
# ============================================
backend:
  image: kailashbadu/zylo-backend
  tag: latest
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# ============================================
# Frontend Application
# ============================================
frontend:
  image: kailashbadu/zylo-frontend
  tag: latest
  replicas: 2
  service:
    type: NodePort      # Use NodePort for EC2 direct access
    nodePort: 30080
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 300m
      memory: 128Mi
EOF
```

### Step 4.6: Update \_helpers.tpl

```bash
cat > templates/_helpers.tpl << 'EOF'
{{/*
Expand the name of the chart.
*/}}
{{- define "zylo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "zylo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "zylo.labels" -}}
helm.sh/chart: {{ include "zylo.chart" . }}
{{ include "zylo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "zylo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "zylo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
EOF
```

### Step 4.7: Update NOTES.txt

```bash
cat > templates/NOTES.txt << 'EOF'
1. Get the application URL by running these commands:
{{- if eq .Values.frontend.service.type "NodePort" }}
  export NODE_PORT=$(kubectl get --namespace {{ .Values.namespace }} -o jsonpath="{.spec.ports[0].nodePort}" services frontend)
  export NODE_IP=$(kubectl get nodes --namespace {{ .Values.namespace }} -o jsonpath="{.items[0].status.addresses[0].address}")
  echo http://$NODE_IP:$NODE_PORT
{{- else }}
  export POD_NAME=$(kubectl get pods --namespace {{ .Values.namespace }} -l "app=frontend" -o jsonpath="{.items[0].metadata.name}")
  kubectl port-forward $POD_NAME 8080:8080
{{- end }}

2. Check pod status:
  kubectl get pods --namespace {{ .Values.namespace }}

3. View logs:
  kubectl logs -f --namespace {{ .Values.namespace }} -l app=postgres-db
  kubectl logs -f --namespace {{ .Values.namespace }} -l app=backend
  kubectl logs -f --namespace {{ .Values.namespace }} -l app=frontend
EOF
```

### Step 4.8: Lint and Validate the Chart

```bash
# Go back to chart root
cd ~/zylo

# Lint the chart
helm lint .

# Do a dry-run to see rendered templates
helm template zylo . --debug

# Check for any errors
```

---

## Phase 5: Deploy the Helm Chart

### Step 5.1: Install the Chart

```bash
# Install the chart with release name "zylo"
helm install zylo .

# Or install with a custom values file:
# helm install zylo . -f custom-values.yaml
```

### Step 5.2: Verify the Deployment

```bash
# Check all resources in the zylo namespace
kubectl get all -n zylo

# Check pods status
kubectl get pods -n zylo -o wide

# Check services
kubectl get svc -n zylo

# Check persistent volumes and claims
kubectl get pv,pvc -n zylo

# Check the Helm release
helm list
helm status zylo
```

### Step 5.3: Wait for Pods to Be Ready

```bash
# Watch pods until all are Running
kubectl get pods -n zylo -w

# Check specific pod logs if stuck
kubectl logs -n zylo deployment/postgres-db
kubectl logs -n zylo deployment/backend
kubectl logs -n zylo deployment/frontend
```

---

## Phase 6: Access the Application

### Method 1: Direct Access via NodePort (Simplest)

Since we set `frontend.service.type: NodePort` with `nodePort: 30080`:

```
http://<EC2-PUBLIC-IP>:30080
```

> Open your browser and navigate to your EC2 Public IP on port 30080.

### Method 2: Port Forwarding (Local Testing)

```bash
# From your local machine, forward the port
ssh -i zylo-key.pem -L 8080:localhost:30080 ubuntu@<EC2-PUBLIC-IP>

# Then open http://localhost:8080 on your local browser
```

### Method 3: Using Ingress (Production)

If you enabled ingress and have a domain:

```bash
# Update values.yaml to enable ingress
# Then upgrade the release
helm upgrade zylo . -f values-with-ingress.yaml
```

---

## Phase 7: Manage the Deployment

### Upgrade the Release

```bash
# After modifying values.yaml or templates
helm upgrade zylo .

# Or with a specific values file
helm upgrade zylo . -f prod-values.yaml
```

### Rollback to Previous Version

```bash
# View release history
helm history zylo

# Rollback to revision 1
helm rollback zylo 1
```

### Uninstall the Release

```bash
# Remove the deployment (keeps PVC data due to Retain policy)
helm uninstall zylo

# To also clean up namespace and PVCs:
kubectl delete namespace zylo

# Clean up hostPath data
sudo rm -rf /data/postgres
```

---

## Quick Reference: All Commands in One Script

Save this as `full-setup.sh` and run on a fresh EC2 instance:

```bash
#!/bin/bash
set -e

echo "=== Phase 1: System Update ==="
sudo apt-get update && sudo apt-get upgrade -y

echo "=== Phase 2: Install Docker ==="
sudo apt-get install -y docker.io
sudo usermod -aG docker $USER
sudo systemctl enable docker && sudo systemctl start docker
newgrp docker

echo "=== Phase 3: Install kubectl ==="

curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl

# Verify
kubectl version --client

echo "=== Phase 4: Install Helm ==="
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4
chmod 700 get_helm.sh
./get_helm.sh

echo "=== Phase 5: Install MicroK8s ==="
sudo snap install microk8s --classic --channel=1.31/stable
sudo usermod -aG microk8s $USER
mkdir -p ~/.kube && sudo chown -R $USER ~/.kube
newgrp microk8s || true

echo "=== Phase 6: Enable MicroK8s Addons ==="
microk8s enable dns hostpath-storage ingress metrics-server helm3 dashboard registry

echo "=== Phase 7: Configure kubectl ==="
microk8s config > ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
echo "alias k='microk8s kubectl'" >> ~/.bashrc
echo "alias kubectl='microk8s kubectl'" >> ~/.bashrc
echo "alias helm='microk8s helm3'" >> ~/.bashrc

echo "=== Phase 8: Setup Postgres Storage ==="
sudo mkdir -p /data/postgres
sudo chmod 777 /data/postgres
sudo chown -R 999:999 /data/postgres

echo "=== Setup Complete! ==="
echo "Log out and log back in, then create your Helm chart and deploy."
```

---

## Troubleshooting

| Issue                          | Solution                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Pods stuck in `Pending`        | Check `kubectl describe pod <pod>` — likely resource limits or PVC not bound      |
| `ImagePullBackOff`             | Check image names/tags; for private images, configure imagePullSecrets            |
| Database won't start           | Verify `/data/postgres` permissions: `sudo chown -R 999:999 /data/postgres`       |
| Backend can't connect to DB    | Check init container logs: `kubectl logs deployment/backend -c wait-for-postgres` |
| Can't access app on port 30080 | Verify security group allows port 30080; check `kubectl get svc -n zylo`          |
| MicroK8s not starting          | Run `microk8s inspect` or `journalctl -u snap.microk8s.daemon-kubelite -f`        |

---

## Summary Flow

```
AWS Console
    │
    ▼
Launch EC2 (Ubuntu 24.04, t3.medium, ports 22/80/443/30080)
    │
    ▼
SSH into EC2
    │
    ├──► apt update && apt upgrade
    ├──► Install Docker
    ├──► Install kubectl
    ├──► Install Helm
    ├──► Install MicroK8s (snap)
    ├──► Enable addons: dns, storage, ingress, metrics-server, helm3
    ├──► Configure kubectl aliases
    └──► Create /data/postgres directory
    │
    ▼
Create Helm Chart
    │
    ├──► helm create zylo
    ├──► Replace default templates with your manifests
    ├──► Templatize with {{ .Values }} variables
    ├──► Update values.yaml
    └──► helm lint .
    │
    ▼
Deploy
    │
    ├──► helm install zylo .
    ├──► kubectl get pods -n zylo
    └──► Access via http://<EC2-IP>:30080
    │
    ▼
Manage
    │
    ├──► helm upgrade zylo .
    ├──► helm rollback zylo 1
    └──► helm uninstall zylo
```
