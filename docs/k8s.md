# Zylo Application Orchestration on Kubernetes

## Overview

Zylo is a PERN stack application, PostgreSQL, Express, React, and Node.js, running as a three tier deployment: a PostgreSQL database, a Node.js/Express backend API, and a React frontend served through Nginx. I originally ran this stack with Docker Compose on a single host, but I moved the orchestration to Kubernetes so that the application could scale horizontally, recover from pod failures automatically, and be exposed through a proper ingress layer instead of relying on host port bindings. This document walks through the full orchestration design for the `zylo` namespace, explains why each manifest exists, and shows the actual configuration I used to bring the application up on the cluster.

I am writing this as a reference for how I reasoned through the deployment, not just as a list of commands. Every section below pairs the manifest with the operational reasoning behind it, including the two production issues I hit while rolling it out and how I diagnosed and fixed them.

## Namespace Isolation

I isolated the entire application inside a dedicated `zylo` namespace rather than deploying into `default`. This keeps the database, backend, frontend, secrets, and ingress rules scoped together, makes it trivial to tear down or inspect the whole application with a single `-n zylo` flag, and avoids naming collisions with anything else running on the same cluster.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: zylo
```

I applied this first, before anything else, since every other resource in the stack references `namespace: zylo` and will fail to create if the namespace does not already exist.

```bash
kubectl apply -f namespace.yml
kubectl get namespace
```

## Persistent Storage for PostgreSQL

PostgreSQL needs storage that survives pod restarts, so I backed it with a PersistentVolume and PersistentVolumeClaim pair instead of an `emptyDir`, which would wipe the database every time the pod was rescheduled.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: postgres-pv
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  storageClassName: standard
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /data/postgres
```

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: zylo
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard
  resources:
    requests:
      storage: 1Gi
```

I set `persistentVolumeReclaimPolicy: Retain` deliberately, since the default `Delete` policy would destroy the underlying data the moment the claim is removed, and I want the database files to survive even if I delete and recreate the PVC during troubleshooting. The `storageClassName` on the PVC has to match the PV exactly, or Kubernetes will not bind them together.

```bash
kubectl apply -f pv.yml
kubectl get pv

kubectl apply -f db-pvc.yml
kubectl get pvc -n zylo
```

## Secrets and Configuration

I separated the database credentials from the database name because they have different sensitivity levels and different lifecycles. Credentials go into a Secret, and the non-sensitive database name goes into a ConfigMap.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
  namespace: zylo
type: Opaque
stringData:
  POSTGRES_USER: zylo_user
  POSTGRES_PASSWORD: zylo_pass
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-config
  namespace: zylo
data:
  POSTGRES_DB: zylo_db
```

Both objects get consumed the same way, through `envFrom`, so the Postgres container and the backend container pick up `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` as environment variables without me having to hardcode them anywhere in the deployment manifests.

```bash
kubectl apply -f db-secret.yml
kubectl get secret postgres-secret -n zylo -o yaml

kubectl apply -f configmap.yml
kubectl get configmap -n zylo
```

## PostgreSQL Deployment

The database runs as a single replica Deployment with a `Recreate` strategy. I capped it at one replica because the pod is backed by a `hostPath` volume, which ties the data to a specific node and cannot be safely shared across multiple pods. The `Recreate` strategy matters for the same reason: it tears down the existing pod before starting a new one, which prevents two Postgres processes from fighting over the same PVC during a rollout, something the default `RollingUpdate` strategy would allow to happen briefly.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-db
  namespace: zylo
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
          image: postgres:16.14-alpine
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
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: pgdata
          persistentVolumeClaim:
            claimName: postgres-pvc
        - name: tmp
          emptyDir: {}
        - name: run
          emptyDir: {}
```

I used `pg_isready` for both probes because it is the correct, database aware way to check whether Postgres is actually accepting connections, rather than just checking whether the process is alive. The readiness probe controls whether the pod receives traffic through its Service, and the liveness probe controls whether Kubernetes restarts the container if it becomes unresponsive. I gave the readiness probe a shorter `initialDelaySeconds` than the liveness probe so that Kubernetes starts routing traffic as soon as the database is actually ready, without prematurely restarting a container that is still initializing.

The database is fronted by a `ClusterIP` Service, which I chose specifically because it is internal only. There is no reason for Postgres to ever be reachable from outside the cluster.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-db
  namespace: zylo
spec:
  type: ClusterIP
  selector:
    app: postgres-db
  ports:
    - port: 5432
      targetPort: 5432
```

```bash
kubectl apply -f db-deployment.yml
kubectl get deploy -n zylo

kubectl apply -f db-service.yml
kubectl get svc -n zylo

kubectl logs -n zylo deploy/postgres-db --tail=30
```

## Backend Deployment

The backend runs with two replicas behind a `ClusterIP` Service. Before the backend container starts, an init container blocks until Postgres is actually accepting connections. This replaces the `depends_on: postgres-db: condition: service_healthy` pattern I relied on in Docker Compose, since Kubernetes has no native equivalent of a compose level health dependency between separate Deployments.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: zylo
spec:
  replicas: 2
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
          image: postgres:16.14-alpine
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
          image: kailashbadu/zylo-backend:latest
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
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: zylo-backend
  namespace: zylo
spec:
  type: ClusterIP
  selector:
    app: backend
  ports:
    - port: 5000
      targetPort: 5000
```

I set `DB_HOST` to `postgres-db`, matching the Postgres Service name exactly, so that DNS resolution inside the cluster routes backend traffic to the database Service rather than to a pod IP that would change on every restart. I also hardened the backend container with `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and `runAsNonRoot: true`, which are the Kubernetes equivalents of the `security_opt: no-new-privileges:true` and `read_only: true` settings I used in Compose.

```bash
kubectl apply -f backend-deployment.yml
kubectl get deploy -n zylo
kubectl get pods -n zylo
```

### Issue: CreateContainerConfigError on the backend pods

After applying the backend manifest, both replicas came up in a `CreateContainerConfigError` state instead of running.

```
backend-78c76b78bb-mvwz2       0/1     CreateContainerConfigError   0          100s
backend-78c76b78bb-twh2z       0/1     CreateContainerConfigError   0          100s
```

This status means Kubernetes could not construct the container from the pod spec, which is usually caused by a missing Secret or ConfigMap, a missing key inside one of them, an invalid environment variable reference, or an invalid volume mount. I described the pod to get the exact reason.

```bash
kubectl describe pod backend-78c76b78bb-mvwz2 -n zylo
```

The event showed the real cause: `container has runAsNonRoot and image has non-numeric user (appuser), cannot verify user is non-root`. I had set `runAsNonRoot: true` in the security context, but my Dockerfile created the application user with a symbolic name rather than a numeric UID, and Kubernetes cannot verify a non-root identity from a name alone. I fixed this at the image level by creating the user with an explicit UID and GID and switching to the numeric form in the `USER` instruction.

```dockerfile
RUN addgroup -g 10001 -S appgroup && \
    adduser -S -D -u 10001 -G appgroup appuser

RUN chown -R 10001:10001 /app

USER 10001:10001
```

After rebuilding and pushing the image to Docker Hub, I restarted the deployment so it would pull the corrected image.

```bash
kubectl rollout restart deployment backend -n zylo
kubectl logs -n zylo deployment/backend
kubectl logs backend-75d9dd769d-bp7kv -n zylo
```

## Frontend Deployment

The frontend runs two replicas of an Nginx image that serves the built static assets and proxies API calls to the backend.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: zylo
spec:
  replicas: 2
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
          image: kailashbadu/zylo-frontend:latest
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
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 300m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: zylo
spec:
  type: ClusterIP
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 8080
```

```bash
kubectl apply -f frontend-deployment.yml
kubectl get pods -n zylo
```

### Issue: CrashLoopBackOff on the frontend pods

Both frontend pods came up and immediately entered `CrashLoopBackOff`.

```
frontend-6d67f4687d-bhckg      0/1     CrashLoopBackOff   6 (115s ago)   7m41s
frontend-6d67f4687d-mzzsz      0/1     CrashLoopBackOff   6 (110s ago)   7m41s
```

Describing the pod only surfaced Kubernetes level events, not the application error, so I went straight to the container logs, including the logs from the previous crashed instance since the pod had already restarted by the time I looked.

```bash
kubectl logs frontend-6d67f4687d-bhckg -n zylo
kubectl logs frontend-6d67f4687d-bhckg -n zylo --previous
```

The log showed the actual problem: `nginx: [emerg] host not found in upstream "zylo-backend"`. My Nginx configuration was proxying to `http://zylo-backend`, but at that point in the rollout my backend Service was still named `backend`, so Kubernetes DNS had nothing to resolve. I renamed the backend Service to `zylo-backend` to match what Nginx expected, removed the old Service, and restarted the frontend rollout.

```bash
kubectl delete svc backend -n zylo
kubectl rollout restart deployment frontend -n zylo
kubectl logs deployment/frontend -n zylo
```

## Verifying Internal Connectivity

Before exposing anything externally, I validated that the tiers could reach each other over the internal cluster network using a disposable curl pod.

```bash
kubectl run curl-test \
  --image=curlimages/curl \
  -n zylo \
  --rm -it -- sh
```

From inside that pod, hitting the backend Service by name confirmed the API was reachable and healthy.

```bash
curl http://zylo-backend:5000/api/health
```

```json
{ "status": "ok", "message": "ZYLO API is running" }
```

I also exec'd directly into a frontend pod to confirm it could reach the backend using the same DNS name Nginx relies on internally.

```bash
kubectl exec -it frontend-d8f7d4859-7sq5k -n zylo -- sh
```

## Exposing the Application

### Initial attempt: NodePort and its limitation

My first instinct was to expose the frontend with a NodePort Service, but this failed to work from outside the VPC because the underlying nodes had no public IP address.

```
EXTERNAL-IP   <none>
```

A NodePort only helps once traffic can already reach the node's IP directly. Since these nodes sat entirely inside a private network, hitting `http://<NODE_PUBLIC_IP>:30080` from the internet had nowhere to land. The NodePort was technically working, but only for clients already inside the VPC.

### Moving to a LoadBalancer Service

I changed the frontend Service type to `LoadBalancer`, which on AWS provisions an external Elastic Load Balancer automatically and wires it to the node ports behind the scenes.

```bash
kubectl get svc frontend -n zylo -o wide
```

Within three to four minutes the load balancer was provisioned and the site was reachable from the public internet.

### Final architecture: NGINX Ingress Controller

A LoadBalancer Service is a reasonable way to expose a single Service, but it does not give path based routing, and provisioning a separate AWS load balancer for every Service in the cluster gets expensive and hard to manage as the application grows. I replaced the frontend's LoadBalancer with an NGINX Ingress Controller so that a single external load balancer could route to both the frontend and the backend based on URL path.

I installed the controller from the upstream manifest.

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
kubectl get pods -n ingress-nginx
```

The controller provisions its own AWS LoadBalancer, so I looked up the Service it created and resolved its hostname to a public IP that I could use with a wildcard DNS service.

```bash
kubectl get svc -n ingress-nginx
nslookup <ingress-loadbalancer-hostname>
```

That resolved to `52.66.81.90`, which let me use `nip.io` for a working hostname without owning a real domain.

With the Ingress Controller in place, the frontend Service no longer needs its own external load balancer, so I changed it back to `ClusterIP`. Traffic now flows through a single ingress point instead of one load balancer per Service.

```bash
kubectl apply -f frontend-service.yaml
kubectl get svc -n zylo
```

Then I defined the routing rules themselves. Requests to `/` go to the frontend, and requests to `/api` go to the backend.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: zylo-ingress
  namespace: zylo
spec:
  ingressClassName: nginx
  rules:
    - host: zylo.52.66.81.90.nip.io
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80

          - path: /api
            pathType: Prefix
            backend:
              service:
                name: zylo-backend
                port:
                  number: 5000
```

```bash
kubectl apply -f zylo-ingress.yaml
kubectl get ingress -n zylo
kubectl describe ingress zylo-ingress -n zylo
```

I verified the whole path by hitting `http://zylo.52.66.81.90.nip.io` directly and confirming both the frontend and the `/api` route resolved correctly through the ingress.

The resulting traffic path looks like this:

```
Internet
   |
zylo.52.66.81.90.nip.io
   |
AWS LoadBalancer (NGINX Ingress)
   |
NGINX Ingress Rules
   /              \
frontend Service   backend Service
  (ClusterIP)        (ClusterIP)
   |                  |
frontend pods     backend pods
                       |
                  postgres Service
                       |
                  postgres pod
```

This is a meaningful improvement over the earlier LoadBalancer per Service model, since I now pay for a single external load balancer regardless of how many internal Services the application grows to include, and all routing logic lives declaratively in the Ingress resource rather than being split across infrastructure.

## Deploying to the Management Server

Once the manifests were finalized locally, I synced the entire `k8s` directory to the cluster's management server rather than applying manifests from my local machine directly.

```bash
rsync -avz ./k8s ubuntu@13.201.100.219:~/
```

This keeps a copy of the manifests on the server that has direct `kubectl` access to the cluster, which matches how I want this managed going forward: the management server is the single place from which cluster changes are applied.

## Database Access for Verification

To confirm the schema and data were intact after the migration from Compose, I exec'd into the running Postgres pod and connected with `psql` directly.

```bash
kubectl exec -it postgres-db-7db8f7dc4c-gg2jp -n zylo -- psql -U zylo_user -d zylo_db
```

## ConfigMap versus Secret

I want to be precise about why I split configuration between a ConfigMap and a Secret instead of putting everything in one place, since the distinction matters both operationally and conceptually.

A ConfigMap holds non-sensitive configuration data, such as the database name in this deployment. Its contents are stored as plain text inside etcd, are visible in full if someone runs `kubectl get configmap -o yaml`, and are meant for values that would not cause harm if they leaked, things like feature flags, file names, or environment labels.

A Secret holds sensitive data, such as the database username and password here. Kubernetes stores Secret values as base64 encoded strings rather than raw plain text, which is worth being precise about: base64 is an encoding, not encryption, so a Secret is not cryptographically protected by default unless the cluster has encryption at rest enabled for etcd. What a Secret does give me over a ConfigMap is that Kubernetes treats it as a distinct object type with tighter default RBAC expectations, avoids printing its values in plain form in some tooling output, and signals clearly, both to me and to anyone else reading the manifests, that this data needs to be handled carefully and should never be committed to source control in its real form.

In practice, both objects are consumed identically by a pod, through `envFrom` or `valueFrom`, which is why I keep the split based purely on sensitivity rather than on any functional difference: the database name goes in the ConfigMap because there is nothing to protect, and the credentials go in the Secret because there is.

## StorageClass versus PersistentVolume versus PersistentVolumeClaim

These three objects work together to give a pod durable storage, but each one plays a distinct role, and I found it useful to separate them clearly rather than treating them as interchangeable storage concepts.

A StorageClass defines a category of storage and, more importantly, a provisioner that knows how to create storage of that type on demand. On a cloud provider, a StorageClass typically points at something like an EBS volume type, and when a PVC references it, Kubernetes dynamically provisions a matching PersistentVolume automatically, with no manual step required. In this deployment I referenced a StorageClass named `standard`, but I paired it with a manually created PersistentVolume using `hostPath` rather than relying on dynamic provisioning, since I wanted the Postgres data pinned to a specific path on a specific node during development.

A PersistentVolume is the actual piece of storage in the cluster: a real disk, network volume, or in this case a directory on the host, along with its capacity, access mode, and reclaim policy. It exists independently of any pod and is a cluster level resource, not something scoped to a namespace.

A PersistentVolumeClaim is a request for storage made by a namespace scoped workload. It does not contain storage itself; it asks Kubernetes for a PersistentVolume that satisfies its requirements, in my case one gigabyte of storage with `ReadWriteOnce` access and the `standard` StorageClass. Kubernetes binds the claim to a matching volume, and from that point on the pod mounts the PVC, not the PV directly.

The relationship, in the direction storage actually gets consumed, looks like this: the StorageClass describes how storage can be created, the PersistentVolume is the storage that actually exists, and the PersistentVolumeClaim is the pod's request that gets matched against an available PersistentVolume. I keep this distinction in mind whenever I am debugging a pod stuck in `Pending`, since the first thing to check is always whether the PVC ever found a PV to bind to, which `kubectl get pvc -n zylo` shows immediately through its `STATUS` column.
