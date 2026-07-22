# Zylo — EKS Infrastructure Documentation

This document describes the Terraform infrastructure-as-code used to provision the Zylo project's AWS environment: a VPC and an Amazon EKS cluster, along with the supporting IAM roles needed to run workloads and an Ingress-capable Load Balancer inside it.

**Stack**: AWS VPC → Amazon EKS → AWS Load Balancer Controller (IRSA) → AWS EBS CSI Driver (IRSA)

**Files covered:**

| File                  | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `versions.tf`         | Terraform & provider version constraints             |
| `provider.tf`         | AWS provider configuration                           |
| `variables.tf`        | All configurable inputs                              |
| `vpc.tf`              | Networking — VPC, subnets, routing, NAT              |
| `eks.tf`              | EKS cluster, node group, IAM roles, IRSA add-ons     |
| `aws-lbc-policy.json` | IAM permissions for the AWS Load Balancer Controller |
| `outputs.tf`          | Values exposed after `apply`                         |

---

## 1. `versions.tf` — Terraform & Provider Versions

```hcl
terraform {
  required_version = ">=1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
```

**What it does:** Pins the Terraform CLI to `>=1.5.0` and locks the two providers this project depends on.

**Why each provider is needed:**

- **`hashicorp/aws` (`~> 5.0`)** — creates every AWS resource in this project: VPC, subnets, EKS cluster, IAM roles, etc. Pinned to major version 5 so a future `aws` provider v6 doesn't silently change resource behavior underneath you.
- **`hashicorp/tls` (`~> 4.0`)** — used exactly once, in `eks.tf`, to fetch the EKS cluster's OIDC TLS certificate thumbprint. This is required to register the cluster as an OIDC identity provider in IAM (needed for IRSA — see §5.5).

**Backend block (commented out):** A commented `backend "s3"` block is present, meant to store Terraform state remotely (with DynamoDB locking) instead of locally. It's disabled for now — meaning state is currently kept on whichever machine runs `terraform apply`, which is fine for solo/dev use but risky for team use or CI/CD (no locking, no shared source of truth). Uncomment and configure this once the bucket/table exist.

---

## 2. `provider.tf` — AWS Provider Configuration

```hcl
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "zylo-devsecops"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
```

**What it does:** Configures _how_ Terraform talks to AWS.

- **`region = var.aws_region`** — every resource is created in whatever region `aws_region` resolves to (default `ap-south-1`, see §3). Keeping this as a variable rather than hardcoding it means the same code can be reused for a different region just by overriding one variable.
- **`default_tags`** — automatically stamps **every** resource this provider creates with `Project`, `Environment`, and `ManagedBy` tags, without needing to repeat them on every single resource block. This matters for cost allocation (you can filter your AWS bill by `Project = zylo-devsecops`) and for knowing at a glance that a resource is Terraform-managed (so nobody edits it by hand in the console).

Credentials themselves aren't configured here — the provider falls back to the standard AWS credential chain (environment variables, `~/.aws/credentials`, or an assumed role), which is the correct approach since it keeps secrets out of the code.

---

## 3. `variables.tf` — Input Variables

Every configurable value in the project lives here, each with a `description`, `type`, and sensible `default` so the stack is deployable out of the box while still being overridable per environment.

### Core / provider

| Variable      | Default      | Reasoning                                                                                                             |
| ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `aws_region`  | `ap-south-1` | Region for all resources; centralizing it avoids hardcoding a region string in a dozen places.                        |
| `environment` | `dev`        | Used purely for tagging (`provider.tf`) so dev/staging/prod resources are distinguishable in the AWS console/billing. |

### Cluster identity

| Variable          | Default    | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cluster_name`    | `zylo-eks` | Used as a naming prefix everywhere (IAM roles, security groups, subnets) so all related resources are recognizable as belonging to this cluster at a glance.                                                                                                                                                                                                                                                        |
| `cluster_version` | `1.36`     | The Kubernetes minor version EKS runs. Pinned explicitly rather than left to "whatever's latest" so upgrades are a deliberate, reviewed Terraform change rather than something that happens silently. **Note:** because AWS stopped publishing AL2 AMIs after Kubernetes 1.32, any version ≥1.33 here requires `ami_type = "AL2023_x86_64_STANDARD"` (or Bottlerocket) on the node group — already set in `eks.tf`. |

### Networking

| Variable               | Default                              | Reasoning                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vpc_cidr`             | `10.0.0.0/16`                        | A /16 gives ~65,000 IPs — comfortably large for a cluster that will grow pods/nodes over time, while still being a private (RFC1918) range.                                                                                                                           |
| `availability_zones`   | `["ap-south-1a", "ap-south-1b"]`     | EKS **requires at least 2 AZs** for control-plane and subnet redundancy. Two is the minimum viable HA setup — a third could be added for extra resilience at extra NAT Gateway cost.                                                                                  |
| `private_subnet_cidrs` | `["10.0.1.0/24", "10.0.2.0/24"]`     | One /24 (254 usable IPs) per AZ for worker nodes/pods. Kept separate from public ranges so the two tiers can have distinct route tables and security postures.                                                                                                        |
| `public_subnet_cidrs`  | `["10.0.101.0/24", "10.0.102.0/24"]` | One /24 per AZ for anything that needs a direct internet-facing presence (the ALB provisioned later by the Load Balancer Controller). The `.101`/`.102` numbering is a convention to visually separate "public" ranges from "private" ranges (`.1`/`.2`) at a glance. |

### Node group sizing

| Variable                          | Default     | Reasoning                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_instance_type`              | `t3.medium` | A burstable, cost-efficient instance type suitable for dev/small workloads. Not compute/memory-intensive, which matches an early-stage project.                                                                                                                                                   |
| `node_desired_size`               | `2`         | Matches the 2-AZ layout — one node can live in each AZ for baseline HA.                                                                                                                                                                                                                           |
| `node_min_size` / `node_max_size` | `1` / `4`   | Defines the autoscaling floor and ceiling: the cluster can shrink to a single node to save cost, or scale to 4 under load, without a Terraform change (actual scaling is handled by the Kubernetes/cluster autoscaler, not Terraform — see the `ignore_changes` lifecycle rule in `eks.tf` §5.4). |

### Application (forward-looking)

| Variable                                         | Default        | Reasoning                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker_image_backend` / `docker_image_frontend` | `kailashbadu/` | Placeholder repository prefixes for the app's container images. Not yet consumed by any resource in this Terraform project — they're staged here for when Kubernetes manifests (Deployments) are added, either via `kubernetes_manifest` resources or a separate Helm/kubectl step. **These need the actual image name/tag appended before use** (e.g. `kailashbadu/shophive-backend:latest`). |
| `app_replicas`                                   | `2`            | Same purpose — reserved for the future Kubernetes Deployment resource, matching the 2-node baseline for one pod per node.                                                                                                                                                                                                                                                                      |

---

## 4. `vpc.tf` — Networking Layer

This file builds a classic **public/private, multi-AZ VPC** — the standard shape recommended for EKS.

### 4.1 VPC

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  ...
}
```

`enable_dns_support` and `enable_dns_hostnames` are both set to `true` because **EKS requires DNS resolution inside the VPC** — nodes need to resolve the EKS API server endpoint and internal service discovery (CoreDNS) depends on it. Without both flags, cluster networking breaks.

### 4.2 Internet Gateway

```hcl
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}
```

Attached directly to the VPC — this is what gives the **public** subnets (and only those, via their route table) a path to/from the internet.

### 4.3 Public Subnets

```hcl
resource "aws_subnet" "public" {
  count = length(var.availability_zones)
  ...
  map_public_ip_on_launch = true
  tags = {
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                    = "1"
  }
}
```

- **`count = length(var.availability_zones)`** — dynamically creates one subnet per AZ rather than hardcoding two `resource` blocks; adding a third AZ is then just a one-line variable change.
- **`map_public_ip_on_launch = true`** — anything launched here (in practice, nothing is launched directly in these subnets except NAT Gateways) gets a public IP automatically.
- **The two tags are load-bearing, not cosmetic.** The AWS Load Balancer Controller and the Kubernetes in-tree cloud provider scan subnets for these exact tags to decide where to place **internet-facing** load balancers. Without `kubernetes.io/role/elb = 1`, the LBC has no way of knowing these are the "public" subnets, and ALB provisioning will fail or pick the wrong subnets.

### 4.4 Private Subnets

```hcl
resource "aws_subnet" "private" {
  ...
  tags = {
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/internal-elb"           = "1"
  }
}
```

Same pattern, but tagged `role/internal-elb` instead — telling the LBC "use these subnets for **internal**, non-internet-facing load balancers." This is also where the **EKS worker nodes** live (see `eks.tf` §5.4) — nodes never get a public IP and are never directly reachable from the internet, which is the entire point of the public/private split: only the load balancer is exposed; application compute is not.

### 4.5 NAT Gateways + Elastic IPs

```hcl
resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  count         = length(var.availability_zones)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
}
```

- **One NAT Gateway per AZ** (not one shared NAT) — this is a deliberate HA choice. If a single shared NAT Gateway's AZ went down, _every_ private subnet in every other AZ would lose outbound internet access too. Per-AZ NAT means an AZ outage only affects that AZ's nodes. The tradeoff is cost: NAT Gateways are billed per-hour, so 2 AZs = 2 NAT Gateways running continuously.
- **Why nodes need this at all**: worker nodes in private subnets still need outbound internet to pull container images (unless using ECR w/ VPC endpoints), talk to the EKS API, and reach AWS APIs (STS, S3, etc.) for IRSA and other integrations. NAT Gateway provides that outbound-only path without exposing the nodes themselves inbound.

### 4.6 Route Tables

```hcl
resource "aws_route_table" "public" {
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  count = length(var.availability_zones)
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
}
```

- **One public route table**, shared by both public subnets — all outbound traffic (`0.0.0.0/0`) goes straight to the Internet Gateway.
- **One private route table _per AZ_** — each private subnet's `0.0.0.0/0` traffic routes through _its own AZ's_ NAT Gateway, not a shared one. This preserves the AZ-isolation property from §4.5: an AZ's private traffic never has to cross AZ boundaries to reach the internet, which also avoids unnecessary cross-AZ data transfer charges.

Associations (`aws_route_table_association`) simply wire each subnet to its corresponding route table — public subnets → the shared public RT; each private subnet → its own AZ's private RT.

---

## 5. `eks.tf` — EKS Cluster, Node Group & IAM

This is the core compute layer. It's organized in the order resources actually depend on each other: cluster IAM role → node IAM role → security group → cluster → node group → OIDC provider → IRSA roles for add-ons.

### 5.1 EKS Cluster IAM Role

```hcl
resource "aws_iam_role" "eks_cluster" {
  assume_role_policy = jsonencode({
    Statement = [{
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}
```

**Why:** The EKS _control plane itself_ (not your workloads) is an AWS-managed service that needs permission to manage ENIs, security groups, and other resources on your behalf inside your VPC. The trust policy (`Principal = eks.amazonaws.com`) says "only the EKS service can assume this role," and `AmazonEKSClusterPolicy` is the AWS-managed policy granting exactly the permissions EKS documents as required — using the managed policy instead of a hand-written one avoids under/over-scoping this trust boundary.

### 5.2 Node IAM Role

```hcl
resource "aws_iam_role" "eks_nodes" {
  assume_role_policy = jsonencode({
    Statement = [{ Principal = { Service = "ec2.amazonaws.com" } }]
  })
}
```

Three managed policies are attached:
| Policy | Why the node needs it |
|---|---|
| `AmazonEKSWorkerNodePolicy` | Lets the kubelet on each node register with, and communicate with, the EKS control plane. Without it, a node literally cannot join the cluster. |
| `AmazonEKS_CNI_Policy` | Used by the **VPC CNI plugin** to attach/detach ENIs and assign VPC IPs to pods — this is how Kubernetes pods get real, routable VPC IP addresses on AWS instead of an overlay network. |
| `AmazonEC2ContainerRegistryReadOnly` | Lets nodes pull container images from ECR without embedding registry credentials in the cluster — the node's instance role handles auth transparently. |

This is the **minimum viable** trio for a functioning EKS node group; nothing here is optional.

### 5.3 Cluster Security Group

```hcl
resource "aws_security_group" "eks_cluster" {
  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

Attached to the cluster's `vpc_config.security_group_ids`, meaning it's applied to the ENIs the EKS control plane creates in your VPC. Currently it only defines unrestricted **egress**. EKS also auto-creates its own default cluster security group that independently handles core node↔control-plane traffic, so the cluster functions without this one doing much — but as written, this SG doesn't add any inbound allowance of its own. If you want to explicitly use this SG for node↔node or node↔control-plane traffic (recommended for clarity and to have a single, explicit place to reason about cluster-internal networking), add a self-referencing ingress rule:

```hcl
ingress {
  from_port = 0
  to_port   = 0
  protocol  = "-1"
  self      = true
}
```

(This is not yet applied in the current file — flagged here as a known follow-up.)

### 5.4 EKS Cluster & Node Group

```hcl
resource "aws_eks_cluster" "main" {
  vpc_config {
    subnet_ids              = concat(aws_subnet.private[*].id, aws_subnet.public[*].id)
    security_group_ids      = [aws_security_group.eks_cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = true
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
}
```

- **Both private and public subnets are passed** — this is required so the LBC can find _both_ subnet tiers (internal vs. internet-facing) via the tags set in `vpc.tf`, even though the control plane itself only really needs the private ones for node communication.
- **`endpoint_private_access = true` + `endpoint_public_access = true`** — the API server is reachable both from within the VPC (private) and from the internet (public, e.g. your laptop running `kubectl`). Public access is convenient for a small team/dev environment; for production hardening this is often narrowed via `public_access_cidrs` or turned off entirely once a bastion/VPN is in place.
- **`enabled_cluster_log_types`** — turns on control-plane logging to CloudWatch for `api` (API server requests), `audit` (who did what), and `authenticator` (IAM↔RBAC mapping issues) — the three log types most useful for debugging access and security issues. (`controllerManager` and `scheduler` logs are omitted, presumably to control CloudWatch cost, since they're rarely needed for day-to-day debugging.)

```hcl
resource "aws_eks_node_group" "main" {
  subnet_ids     = aws_subnet.private[*].id
  instance_types = [var.node_instance_type]
  ami_type       = "AL2023_x86_64_STANDARD"

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  update_config { max_unavailable = 1 }

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}
```

- **`subnet_ids = private only`** — worker nodes never sit in public subnets; this is the enforcement point for the "nodes are never internet-facing" design decision made in `vpc.tf`.
- **`ami_type = "AL2023_x86_64_STANDARD"`** — explicitly required because AWS stopped publishing new Amazon Linux 2 (AL2) AMIs after Kubernetes 1.32; since `cluster_version` defaults to `1.36`, the old AL2 default would fail node group creation outright with an "AMI Type AL2_x86_64 is only supported for kubernetes versions 1.32 or earlier" error. AL2023 is AWS's supported successor (newer kernel, IMDSv2-only by default, better security posture).
- **`update_config.max_unavailable = 1`** — during a rolling node update (e.g. AMI patch), only 1 node is taken down at a time, so the app always has `desired_size - 1` capacity available — avoiding a full-capacity outage during updates.
- **`lifecycle.ignore_changes = [scaling_config[0].desired_size]`** — once Cluster Autoscaler (or Karpenter) starts managing node count live in response to load, it changes `desired_size` outside of Terraform. Without this `ignore_changes`, every subsequent `terraform apply` would try to "correct" the node count back to the static default, fighting the autoscaler. This line makes Terraform own the _bounds_ (`min`/`max`) while ceding live scaling decisions to Kubernetes.
- **`depends_on`** on all three node IAM policy attachments — ensures the IAM permissions exist _before_ nodes attempt to join, since a race here would cause nodes to come up unable to register with the cluster.

### 5.5 OIDC Provider (IRSA foundation)

```hcl
data "tls_certificate" "eks_oidc" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
```

**What this is:** Every EKS cluster exposes its own OIDC issuer URL. Registering that issuer as an IAM OIDC Identity Provider is what enables **IRSA (IAM Roles for Service Accounts)** — the mechanism that lets a specific Kubernetes ServiceAccount (not the whole node) assume a specific, narrowly-scoped IAM role, instead of every pod on a node inheriting the node's IAM permissions. This is the standard, least-privilege way to give individual controllers (like the Load Balancer Controller or EBS CSI driver) exactly the AWS permissions they need and nothing more.

The `tls_certificate` data source exists purely to fetch the SHA1 thumbprint of the OIDC issuer's TLS certificate, which IAM requires when registering the identity provider (this is why the `tls` provider is in `versions.tf` at all).

### 5.6 AWS Load Balancer Controller — IRSA Role

```hcl
resource "aws_iam_role" "aws_lbc" {
  assume_role_policy = jsonencode({
    Statement = [{
      Principal = { Federated = aws_iam_openid_connect_provider.eks.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "...:sub" = "system:serviceaccount:kube-system:aws-load-balancer-controller"
          "...:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_policy" "aws_lbc" {
  policy = file("${path.module}/aws-lbc-policy.json")
}

resource "aws_iam_role_policy_attachment" "aws_lbc" {}
```

- **The `Condition` block is the crux of IRSA security**: it doesn't just trust "anything from this OIDC provider" — it restricts the trust to requests where the `sub` claim matches _exactly_ `system:serviceaccount:kube-system:aws-load-balancer-controller`. In other words, only pods running under that specific Kubernetes ServiceAccount can assume this role — a compromised pod running as any _other_ ServiceAccount cannot use it. The `replace(..., "https://", "")` strips the scheme from the OIDC URL because IAM's condition key format expects the bare hostname/path, not the full URL.
- **`aws_iam_policy.aws_lbc`** loads its permission document from the external `aws-lbc-policy.json` file (see §6) rather than inlining hundreds of lines of JSON directly in the `.tf` file — keeps the Terraform readable and the policy document independently diffable/versionable, and matches the exact policy AWS publishes for this controller (so it's easy to diff against upstream updates).
- **What this role is actually for:** once you deploy the AWS Load Balancer Controller into `kube-system` with this role attached to its ServiceAccount, it can create/manage ALBs and NLBs directly from Kubernetes `Ingress`/`Service` objects — this is what turns a Kubernetes Ingress resource into a real internet-facing Application Load Balancer sitting in your public subnets.

### 5.7 AWS EBS CSI Driver — IRSA Role + Addon

```hcl
resource "aws_iam_role" "ebs_csi" { ... same IRSA pattern, scoped to
  "system:serviceaccount:kube-system:ebs-csi-controller-sa" ... }

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "aws-ebs-csi-driver"
  service_account_role_arn = aws_iam_role.ebs_csi.arn
  depends_on               = [aws_eks_node_group.main]
}
```

**Why this exists:** Kubernetes pods are ephemeral by default — anything written to a container's own filesystem is lost on restart/reschedule. Any stateful workload (most notably: **a database running as a container inside the cluster**, which is this project's current plan) needs a `PersistentVolumeClaim` backed by real, durable storage that survives the pod being rescheduled to a different node. On AWS, that durable backing store is EBS, and the **EBS CSI driver** is the component that lets Kubernetes actually provision/attach/detach EBS volumes in response to PVCs.

- The **IAM role** follows the exact same IRSA pattern as the LBC role (§5.6) — scoped via `Condition` to only the `ebs-csi-controller-sa` ServiceAccount, and granted AWS's own managed `AmazonEBSCSIDriverPolicy` (covers `CreateVolume`, `AttachVolume`, `DeleteSnapshot`, etc.).
- The **`aws_eks_addon`** resource is what actually _installs_ the driver into the cluster (AWS manages the addon's lifecycle/versioning) — the IAM role alone does nothing without this; `service_account_role_arn` is what tells the addon to annotate its ServiceAccount with the IRSA role automatically, instead of that being a manual `kubectl annotate` step.
- **`depends_on = [aws_eks_node_group.main]`** — the addon needs running nodes to actually schedule its controller pods onto, so it's ordered after the node group exists.

---

## 6. `aws-lbc-policy.json` — Load Balancer Controller IAM Policy

This is the official AWS-published IAM policy document for the `aws-load-balancer-controller`, used verbatim (not hand-written) so it stays aligned with what AWS documents as the controller's required permission set. Rather than re-explain every statement line-by-line, the key permission groups are:

| Group                                                                                              | Purpose                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iam:CreateServiceLinkedRole` (scoped to `elasticloadbalancing.amazonaws.com`)                     | Lets AWS auto-create the service-linked role ELB needs on first use in the account.                                                                                                                                                                             |
| `ec2:Describe*` / `elasticloadbalancing:Describe*`                                                 | Read-only discovery calls the controller uses to figure out existing VPC/subnet/SG/ALB state before making changes.                                                                                                                                             |
| `ec2:*SecurityGroup*` (scoped with `elbv2.k8s.aws/cluster` tag conditions)                         | Lets the controller create/manage security groups **it owns** (tagged to this cluster) without being able to touch security groups belonging to other clusters or resources — this tag-based conditioning is the main blast-radius control in the whole policy. |
| `elasticloadbalancing:CreateLoadBalancer` / `CreateTargetGroup` (tag-conditioned)                  | Core ALB/NLB + target group provisioning, again gated by the `elbv2.k8s.aws/cluster` tag so it only manages resources it created.                                                                                                                               |
| `elasticloadbalancing:CreateListener/Rule`, `RegisterTargets`, `ModifyListener`, `SetWebAcl`, etc. | Day-2 operations: routing rules, target registration/deregistration as pods scale, and WAF association.                                                                                                                                                         |

**Why tag-conditioning matters here:** almost every mutating permission in this policy is scoped with a `Null`/`StringEquals` condition on the `elbv2.k8s.aws/cluster` tag. This means the controller's IAM permissions — even though broad-looking on paper (e.g. `ec2:DeleteSecurityGroup`) — can only act on resources _it itself created and tagged_, not arbitrary security groups or load balancers elsewhere in the account. This is what makes it safe to grant a fairly powerful-sounding policy to a single automated controller.

---

## 7. `outputs.tf` — Exposed Values

```hcl
output "cluster_name"        { value = aws_eks_cluster.main.name }
output "cluster_endpoint"    { value = aws_eks_cluster.main.endpoint }
output "configure_kubectl"   { value = "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.main.name}" }
output "vpc_id"              { value = aws_vpc.main.id }
output "private_subnet_ids"  { value = aws_subnet.private[*].id }
output "public_subnet_ids"   { value = aws_subnet.public[*].id }
output "node_group_name"     { value = aws_eks_node_group.main.node_group_name }
```

Each output exists for a concrete, practical reason after `terraform apply`:

- **`cluster_name` / `cluster_endpoint`** — needed if you're wiring this cluster into other tooling (CI/CD, monitoring) that needs to address the cluster directly.
- **`configure_kubectl`** — a ready-to-copy-paste CLI command so you don't have to remember the exact `aws eks update-kubeconfig` syntax/flags every time — directly usable output, not just a raw value.
- **`vpc_id`, `private_subnet_ids`, `public_subnet_ids`** — needed whenever you add _more_ Terraform resources later that must reference this VPC/subnets (e.g. an RDS instance, additional security groups, VPC endpoints) without hardcoding IDs.
- **`node_group_name`** — useful for scripting against the node group (e.g. `aws eks describe-nodegroup`) without having to look the name up manually in the console.

---

## Summary — How It All Fits Together

1. **`versions.tf` / `provider.tf`** set up _how_ Terraform talks to AWS.
2. **`variables.tf`** defines every knob the rest of the project turns.
3. **`vpc.tf`** builds the network: public subnets (for load balancers) and private subnets (for compute), each multi-AZ, connected via IGW/NAT with AZ-isolated routing.
4. **`eks.tf`** provisions the EKS control plane and worker nodes inside that network, then layers on IRSA so two cluster add-ons — the **Load Balancer Controller** (for Ingress → ALB) and the **EBS CSI driver** (for persistent storage, e.g. the database container) — each get their own narrowly-scoped IAM permissions instead of sharing the node's broad IAM role.
5. **`aws-lbc-policy.json`** is the exact permission set the Load Balancer Controller needs, kept as a standalone, tag-scoped policy document.
6. **`outputs.tf`** surfaces the IDs/values you need to actually _use_ the cluster once it exists — connect `kubectl`, or build more infrastructure on top of it.

### Known follow-ups (not yet applied, discussed but deferred)

- Add a self-referencing `ingress` rule to `aws_security_group.eks_cluster` (§5.3) for explicit cluster-internal traffic control.
- The database, for now, will run **as a container inside EKS** rather than as RDS — meaning it needs a `PersistentVolumeClaim` (enabled by §5.7) and ideally a `StatefulSet` (not a plain `Deployment`) plus a Kubernetes `NetworkPolicy` to restrict which pods can reach it. These are Kubernetes-manifest-level changes, not Terraform changes, and are not yet part of this repo.
- Terraform remote state (`backend "s3"`, commented in `versions.tf`) is not yet enabled.
