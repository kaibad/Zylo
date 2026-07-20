# Terraform Documentation

## Overview

**What**: This is a Terraform configuration that provisions a full networking layer (VPC) and an Amazon EKS cluster running in Auto Mode for the Zylo project.

**Why**: I needed a Kubernetes cluster for Zylo that I could stand up and tear down repeatably, without manually clicking through the AWS console, and without having to manage EC2 worker nodes myself.

**How**: I split the configuration into five files, each with a single responsibility:

- `provider.tf` declares Terraform's required version and configures the AWS provider
- `variables.tf` declares the input variables the configuration accepts
- `terraform.tfvars` supplies the actual values for those variables for this environment
- `main.tf` defines the VPC and EKS resources (via modules)
- `outputs.tf` exposes values I need after the apply completes

## Prerequisites

**What**: Tools and access I needed before running this configuration.

**Why**: Terraform needs a compatible CLI version and valid AWS credentials to authenticate and create resources on my behalf; without these, `terraform init` or `apply` fails before it does any work.

**How**: I made sure I had the following in place:

- Terraform version `>= 1.5.0` installed
- An AWS account with credentials configured (via `aws configure`, environment variables, or an assumed IAM role)
- IAM permissions sufficient to create VPCs, EKS clusters, IAM roles, and related networking resources
- AWS CLI installed, since I needed it later to configure `kubectl`

## Step 1: Provider Configuration (`provider.tf`)

**What**: This file tells Terraform which version of Terraform and which version of the AWS provider to use, and configures the AWS provider itself (region and default tags).

**Why**: Terraform doesn't know how to talk to AWS out of the box it needs a provider plugin. Pinning versions here matters because an unpinned provider could pull in a newer major version later with breaking changes, silently changing how my resources behave between runs.

**How**:

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure for remote state (recommended for teams)
  # backend "s3" {
  #   bucket         = "zylo-terraform-state"
  #   key            = "eks/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "zylo-tf-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "Zylo"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}
```

Breaking down each piece:

- **`required_version = ">= 1.5.0"`** What: a floor on the Terraform CLI version. Why: I used syntax and provider features that need at least this version. How: Terraform refuses to run if the installed CLI is older than this.
- **`required_providers` block** What: declares that this configuration needs the `hashicorp/aws` provider, constrained to `~> 5.0` (any `5.x` release, but not `6.0`). Why: this keeps the provider stable across `terraform init` runs on different machines or CI, so everyone gets a compatible version. How: Terraform downloads and locks this version during `terraform init`, recording it in `.terraform.lock.hcl`.
- **The commented-out `backend "s3"` block** What: this is where I would configure remote state storage in an S3 bucket with a DynamoDB table for state locking. Why: by default Terraform stores state (`terraform.tfstate`) as a local file, which doesn't work once more than one person or one CI pipeline needs to run `apply` against the same infrastructure local state creates conflicts and risks the state file getting lost. How: I left it commented out for now because I'm working solo and locally; before I bring anyone else onto this project, I'll create the bucket and table, uncomment this block, and run `terraform init` again to migrate state.
- **`provider "aws" { region = var.aws_region }`** What: tells the AWS provider which region to operate in. Why: every AWS API call the provider makes needs a region; I pulled this from a variable instead of hardcoding it so I can change region per environment. How: Terraform reads `var.aws_region`, which resolves to whatever I set in `terraform.tfvars`.
- **`default_tags`** What: a set of tags (`Project`, `Environment`, `ManagedBy`) automatically applied to every resource this provider creates that supports tagging. Why: without this, I would need to manually add the same three tags to every single resource block, and it's easy to forget one that makes cost tracking and ownership identification in the AWS console unreliable. How: the AWS provider merges these tags into each resource's tags at apply time, so I only had to define them once.

## Step 2: Input Variables (`variables.tf`)

**What**: This file declares the five variables the rest of the configuration references their type, description, and default value.

**Why**: Instead of hardcoding values like the region or cluster name directly into `main.tf`, I parameterized them. This means I can reuse the exact same `main.tf` and `provider.tf` for a different environment or project just by changing variable values, instead of editing the resource logic itself.

**How**:

```hcl
variable "aws_region" {
  description = "AWS region to deploy the EKS cluster"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
  default     = "zylo-eks"
}

variable "cluster_version" {
  description = "Kubernetes version for EKS"
  type        = string
  default     = "1.36"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}
```

| Variable          | What it controls                                            | Why it exists                                                                                                                  | Default       |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `aws_region`      | Which AWS region every resource is created in               | Lets me redeploy the same stack in a different region without touching resource code                                           | `ap-south-1`  |
| `environment`     | A label (`dev`, `staging`, `prod`) applied as a tag         | Lets me distinguish resources belonging to different environments in the AWS console and in cost reports                       | `dev`         |
| `cluster_name`    | The name of the EKS cluster and the prefix for the VPC name | Gives every related resource a consistent, identifiable name                                                                   | `zylo-eks`    |
| `cluster_version` | Which Kubernetes minor version EKS runs                     | Kubernetes and EKS version support changes over time, so I need explicit control over upgrades rather than an implicit default | `1.36`        |
| `vpc_cidr`        | The IP address range for the VPC                            | Determines how much address space is available for subnets, and must not overlap with any VPC I peer with later                | `10.0.0.0/16` |

I gave every variable a default so the configuration runs out of the box with `terraform apply` and no extra flags, but I still override the values that matter per environment in `terraform.tfvars`.

## Step 3: Environment Values (`terraform.tfvars`)

**What**: This file supplies the concrete values Terraform uses for the variables declared in `variables.tf`.

**Why**: Terraform automatically loads a file named exactly `terraform.tfvars` without me needing to pass `-var-file` on the command line. Separating values from variable declarations means I can keep one `variables.tf` and swap in a different `.tfvars` file (for example `staging.tfvars`) to deploy a different environment from the same codebase.

**How**:

```hcl
aws_region      = "ap-south-1"
environment     = "dev"
cluster_name    = "zylo-eks"
cluster_version = "1.36"
vpc_cidr        = "10.0.0.0/16"
```

This is the file I edit day-to-day for example, changing `environment` to `"staging"` or picking a different `vpc_cidr` so it doesn't overlap with another VPC I might peer or connect this one to.

## Step 4: VPC Module (`main.tf`)

### 4a. Discovering Availability Zones

**What**: A data source that queries AWS for the list of availability zones (AZs) available in the target region, and a local value that keeps the first three.

**Why**: AZ names and counts differ by region and by AWS account (some AZs require opt-in and aren't usable by default). If I hardcoded AZ names like `ap-south-1a`, `ap-south-1b`, the configuration would break the moment I changed regions. Querying AWS directly keeps the configuration portable.

**How**:

```hcl
data "aws_availability_zones" "available" {
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 3)
}
```

- The `filter` on `opt-in-status` excludes AZs that need special account opt-in, which keeps the list to AZs I can actually use.
- `slice(..., 0, 3)` takes the first three names from that list, since I want the cluster spread across three AZs for availability, no more and no less.

### 4b. VPC and Subnets

**What**: A call to the community `terraform-aws-modules/vpc/aws` module that creates a VPC, one public and one private subnet per AZ, route tables, an internet gateway, and NAT gateway(s).

**Why**: Rather than writing every VPC, subnet, route table, and gateway resource by hand which is a lot of repetitive, error-prone HCL I used a well-maintained, widely-used community module that encodes AWS networking best practices. It also means I get things like route table associations handled correctly without writing them myself.

**How**:

```hcl
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [for k, v in local.azs : cidrsubnet(var.vpc_cidr, 4, k)]
  public_subnets  = [for k, v in local.azs : cidrsubnet(var.vpc_cidr, 8, k + 48)]

  enable_nat_gateway = true
  single_nat_gateway = true # Cost-saving for dev; use one per AZ for prod

  # Tags required for EKS Auto Mode to discover subnets
  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
  }
}
```

Breaking this down:

- **`name` / `cidr`** What: the VPC's name and IP address range. Why: `"${var.cluster_name}-vpc"` keeps the VPC name tied to the cluster it serves, so it's identifiable in the console; `cidr` comes from my `vpc_cidr` variable (`10.0.0.0/16`), giving roughly 65,536 IP addresses to split across subnets.
- **`azs`** What: which availability zones to spread subnets across. Why/How: pulled directly from the `local.azs` list I built in step 4a, so this stays in sync automatically if I change the AZ count.
- **`private_subnets` / `public_subnets`** What: the actual subnet CIDR blocks, generated with the `cidrsubnet()` function instead of typed out manually. Why: `cidrsubnet(var.vpc_cidr, 4, k)` carves a `/20` subnet out of the `/16` VPC CIDR for each AZ index `k`, and `cidrsubnet(var.vpc_cidr, 8, k + 48)` carves smaller `/24` subnets for public use, offset so they don't collide with the private ranges. Doing it this way means if I ever change `vpc_cidr`, all the subnets recalculate automatically instead of me needing to redo the math by hand.
- **`enable_nat_gateway = true`** What: creates a NAT gateway so resources in the private subnets can reach the internet outbound (for pulling container images, hitting package registries, etc.) without being reachable from the internet inbound. Why: EKS worker nodes and pods in private subnets still need outbound internet access for things like pulling images from ECR or public registries.
- **`single_nat_gateway = true`** What: creates exactly one NAT gateway for the whole VPC instead of one per AZ. Why: a NAT gateway costs money per hour it runs, so a single one keeps dev costs down. How this trades off: if that one NAT gateway's AZ goes down, private subnets in other AZs temporarily lose outbound internet access acceptable for dev, but something I plan to change to one-per-AZ before promoting to production.
- **`public_subnet_tags` / `private_subnet_tags`** What: AWS-specific tags (`kubernetes.io/role/elb` and `kubernetes.io/role/internal-elb`) applied to the subnets. Why: EKS (and the AWS Load Balancer Controller that Auto Mode uses under the hood) scans subnets for these exact tags to decide where it's allowed to place internet-facing versus internal load balancers. Without these tags, EKS wouldn't know which subnets are safe to use for `Service` type `LoadBalancer` or `Ingress` resources, and load balancer provisioning would fail.

## Step 5: EKS Cluster in Auto Mode (`main.tf`)

### What is EKS Auto Mode

**What**: EKS Auto Mode is an operating mode for Amazon EKS, launched by AWS, where AWS itself manages the Kubernetes data plane the EC2 worker nodes, their OS patching, scaling, and core cluster add-ons like `kube-proxy`, CoreDNS, and the AWS Load Balancer Controller. In "standard" EKS, I would instead create and manage my own node groups (either self-managed EC2 Auto Scaling groups or EKS Managed Node Groups) and separately install add-ons myself.

**Why I chose it**: I didn't want to own the operational burden of patching AMIs, sizing node groups, tuning cluster autoscaler, and installing/upgrading core add-ons by hand. Auto Mode shifts that responsibility to AWS: nodes are provisioned automatically based on pending pod requirements and removed when no longer needed. For a project at Zylo's current stage, this trades a bit of fine-grained control for significantly less operational overhead.

**How it works in this configuration**: I enabled it through the `terraform-aws-modules/eks/aws` module's `cluster_compute_config` block, and set `authentication_mode = "API"`, which Auto Mode requires.

```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = var.cluster_version

  # Auto Mode  EKS manages node groups, kube-proxy, CoreDNS, etc.
  cluster_compute_config = {
    enabled    = true
    node_pools = ["general-purpose", "system"]
  }

  # Networking
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Security: enable private endpoint, public for initial kubectl access
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  # Auth mode required for Auto Mode
  authentication_mode = "API"

  # Security: envelope encryption for secrets at rest
  cluster_encryption_config = {
    resources = ["secrets"]
  }

  # Security: enable logging
  cluster_enabled_log_types = [
    "api",
    "audit",
    "authenticator",
    "controllerManager",
    "scheduler"
  ]

  # Allow current caller (your IAM user/role) to manage the cluster
  enable_cluster_creator_admin_permissions = true
}
```

Going through each setting individually:

- **`cluster_name` / `cluster_version`** What: the cluster's name and which Kubernetes minor version it runs. Why: both come from variables so I control them centrally from `terraform.tfvars` rather than editing the module block directly. How: `cluster_version = "1.36"` tells EKS which control plane version to provision; I'll need to bump this deliberately as versions approach their end-of-support date.

- **`cluster_compute_config.enabled = true`** What: the actual switch that turns on Auto Mode. Why: without this, the module would provision a bare control plane with no compute, and I'd have to define separate `eks_managed_node_groups` or a `self_managed_node_group` block myself, plus install `kube-proxy`, CoreDNS, and VPC CNI as managed add-ons manually. How: when set to `true`, EKS takes over provisioning EC2 instances (using AWS-managed AMIs it patches automatically), attaching them to the cluster, and scaling them up or down based on pending pod resource requests I never touch an Auto Scaling Group directly.

- **`node_pools = ["general-purpose", "system"]`** What: which built-in Auto Mode node pools are active. Why: `system` runs cluster-critical components (like CoreDNS) on nodes reserved for that purpose, kept separate from my own application workloads; `general-purpose` is where my actual application pods land. How: Kubernetes scheduler places pods onto nodes from these pools automatically, using taints/tolerations and node selectors that Auto Mode manages internally I don't hand-configure Auto Scaling policies for either pool.

- **`vpc_id` / `subnet_ids`** What: which VPC and subnets the cluster's networking (and the nodes Auto Mode creates) live in. Why: I pointed `subnet_ids` at `module.vpc.private_subnets` specifically, not the public ones, so worker nodes never get a public IP or a route straight to the internet they can only reach it outbound through the NAT gateway I set up in Step 4b. How: Terraform passes these as direct references to the VPC module's outputs, so if the VPC module's subnet list changes, the EKS module picks up the change automatically on the next apply.

- **`cluster_endpoint_public_access = true` and `cluster_endpoint_private_access = true`** What: controls whether the Kubernetes API server endpoint is reachable from the public internet, from inside the VPC, or both. Why: I need to run `kubectl` from my laptop, which sits outside the VPC, so I need public access enabled; I also enabled private access so that anything running inside the VPC (like CI runners on private subnets) can reach the API server without routing out to the internet and back. How this could tighten later: right now the public endpoint has no CIDR restriction, meaning any IP on the internet can attempt to reach it (though it still requires valid IAM/Kubernetes RBAC credentials to do anything) I plan to add a `cluster_endpoint_public_access_cidrs` allowlist once I know which fixed IPs I'll be connecting from.

- **`authentication_mode = "API"`** What: tells EKS to use the newer, EKS Access Entries API for authentication and authorization, instead of the legacy `aws-auth` ConfigMap. Why: Auto Mode specifically requires this mode it will not work with the older `CONFIG_MAP` or `API_AND_CONFIG_MAP` modes. How: with this mode, I grant cluster access by creating EKS access entries (IAM principal to Kubernetes permission mappings) rather than editing a ConfigMap by hand.

- **`cluster_encryption_config = { resources = ["secrets"] }`** What: enables envelope encryption for Kubernetes `Secret` objects stored in EKS's etcd datastore, using a KMS key. Why: by default, Kubernetes secrets are stored base64-encoded in etcd, which is not the same as encrypted anyone with etcd access (or an unencrypted snapshot) could read them. This setting adds an additional layer of encryption at rest specifically for secrets. How: EKS uses a customer-managed or AWS-managed KMS key under the hood to encrypt secret data before it's persisted.

- **`cluster_enabled_log_types`** What: turns on all five available EKS control plane log streams `api`, `audit`, `authenticator`, `controllerManager`, and `scheduler`. Why: these logs are off by default, and without them I'd have no visibility into who called the API server, whether authentication attempts succeeded or failed, or what the scheduler and controller manager are doing which makes debugging or investigating an incident very difficult after the fact. How: EKS streams these to a CloudWatch Logs group associated with the cluster, where I can query and set retention on them.

- **`enable_cluster_creator_admin_permissions = true`** What: automatically grants the IAM identity that runs `terraform apply` full admin access to the cluster via an EKS access entry. Why: with `authentication_mode = "API"`, nobody has Kubernetes permissions by default, not even the person who created the cluster without this flag, I would be locked out of my own cluster immediately after creation and would need a separate step to grant myself access. How: the module creates an access entry associated with the caller's IAM ARN and attaches the `AmazonEKSClusterAdminPolicy` to it.

## Step 6: Outputs (`outputs.tf`)

**What**: Values Terraform prints to the terminal (and stores in state) after a successful `apply`.

**Why**: I need the cluster name, endpoint, and CA certificate to connect `kubectl` to the cluster, and the VPC ID and region for reference when I build other infrastructure (like RDS or additional networking) that needs to live in the same VPC. Rather than looking these up manually in the AWS console every time, Terraform surfaces them directly.

**How**:

```hcl
output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster API endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_certificate_authority" {
  description = "EKS cluster CA certificate (base64)"
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "region" {
  description = "AWS region"
  value       = var.aws_region
}
```

- **`cluster_name`, `vpc_id`, `region`** plain outputs, printed directly after `apply` and viewable any time with `terraform output`.
- **`cluster_endpoint`** the HTTPS URL of the Kubernetes API server, which tools like `kubectl` or CI pipelines need to connect.
- **`cluster_certificate_authority`** What: the base64-encoded CA certificate used to verify the API server's TLS certificate. Why marked `sensitive = true`: while this specific value (a public CA cert) isn't itself a secret capable of granting access, marking it sensitive prevents Terraform from printing it in plain text to the console or in CI logs, which is a good default habit for any value that looks credential-adjacent. How: Terraform still stores the real value in state and returns it via `terraform output -raw cluster_certificate_authority` when I explicitly ask for it.

## Step 7: Running the Configuration

**What**: The standard Terraform command sequence to provision this infrastructure.

**Why**: `init` sets up the working directory and downloads providers/modules, `plan` shows me exactly what will change before anything happens, and `apply` executes it running them in this order is what lets me review changes before they're made instead of finding out after the fact.

**How**:

```bash
terraform init
terraform plan
terraform apply
```

I reviewed the plan output carefully before applying, particularly the VPC CIDR breakdown and the EKS module version, since a module version bump can sometimes change default behavior between releases.

## Step 8: Connecting to the Cluster

**What**: Configuring my local `kubectl` to talk to the newly created cluster.

**Why**: Terraform creates the cluster, but it doesn't touch my local `~/.kube/config` I need a separate step to point `kubectl` at the new cluster and give it credentials.

**How**:

```bash
aws eks update-kubeconfig --region <region> --name <cluster_name>
```

For this environment, that command became:

```bash
aws eks update-kubeconfig --region ap-south-1 --name zylo-eks
```

I then confirmed the connection with:

```bash
kubectl get nodes
```

Since this is Auto Mode, I didn't expect to see worker nodes listed immediately Auto Mode provisions EC2 capacity on demand, only once I actually deploy a workload with pods that need to be scheduled. An empty node list right after creation is expected, not an error.

## Step 9: Next Steps After the Cluster Is Up

**What**: Once the cluster exists and `kubectl` is connected, there are a few things I still need to do before it's actually useful for running Zylo's workloads.

**Why**: Auto Mode gives me a control plane and on-demand compute, but it doesn't deploy any application, doesn't set up ingress/DNS, and doesn't wire up CI/CD those are separate steps.

**How**: The next things on my list, roughly in order:

```bash
# Verify cluster access and current (likely empty) node list
kubectl get nodes

# Check that core system components are healthy
kubectl get pods -n kube-system

# Confirm the built-in Auto Mode node pools/classes are registered
kubectl get nodepools
kubectl get nodeclasses

# Deploy a simple workload to confirm Auto Mode provisions a node on demand
kubectl create deployment hello-zylo --image=nginx
kubectl get nodes -w   # watch a node appear as the pod needs scheduling

# Clean up the test workload once confirmed
kubectl delete deployment hello-zylo
```

From there, my actual next steps for Zylo are:

- Set up an ingress or load balancer path (Auto Mode integrates with the AWS Load Balancer Controller automatically, so I just need to create a `Service` of type `LoadBalancer` or an `Ingress` resource once I have a workload).
- Configure IAM access entries for any teammates who need `kubectl` access, since `enable_cluster_creator_admin_permissions` only covers the identity that ran `apply`.
- Point CI/CD (GitHub Actions, in Zylo's case) at this cluster using OIDC federation, the same pattern I used for ECR pushes on ShopHive, instead of long-lived credentials.
- Migrate to the S3 backend before anyone else touches this state.

## Step 10: Tearing the Cluster Down

**What**: Removing everything this configuration created the EKS cluster, its Auto Mode compute, and the VPC.

**Why**: EKS clusters and NAT gateways both cost money by the hour whether or not anything is running on them. I destroy the environment when I'm not actively using it (for example, between work sessions on a dev cluster) to avoid paying for idle infrastructure.

**How**:

```bash
terraform plan -destroy
terraform destroy
```

I always run `terraform plan -destroy` first so I can see exactly what's about to be removed before confirming this matters more here than in a lot of setups, since a VPC teardown will fail partway through if anything outside of Terraform (like a manually created load balancer or ENI) is still attached to it.

A few things I keep in mind before destroying:

- **Order matters, and Terraform handles it**: Terraform automatically destroys the EKS cluster (and its Auto Mode nodes) before the VPC, since the VPC is a dependency. I don't need to run these as separate commands.
- **Auto Mode-created load balancers can block destroy**: if I deployed any `Service` of type `LoadBalancer` or `Ingress` resources, Auto Mode provisions real AWS load balancers and ENIs in my subnets that Terraform doesn't know about, because Kubernetes created them, not Terraform. I delete those with `kubectl delete` first, or `terraform destroy` will stall or fail trying to remove subnets that still have ENIs attached.
- **Targeted destroy, if needed**: if a normal destroy fails partway through, I can narrow it down instead of retrying blindly:

```bash
terraform destroy -target module.eks
terraform destroy -target module.vpc
```

- **Confirming it's actually gone**: after destroy completes, I double check in the AWS console or with the CLI that the cluster and NAT gateway are gone, since NAT gateways in particular are a cost I don't want left running by accident:

```bash
aws eks list-clusters --region ap-south-1
aws ec2 describe-nat-gateways --region ap-south-1 --filter "Name=state,Values=available"
```

## Notes and Follow-ups

- **Remote state**: I still need to uncomment and configure the S3 backend in `provider.tf` before anyone else on the team works against this configuration local state doesn't support concurrent or multi-person use safely.
- **NAT gateway redundancy**: `single_nat_gateway = true` is fine for dev, but I'll change this to one NAT gateway per AZ before promoting to staging or production, so an AZ outage doesn't take down outbound connectivity for the whole VPC.
- **Public endpoint access**: I left `cluster_endpoint_public_access = true` with no CIDR restriction. I plan to lock this down to specific IP ranges with `cluster_endpoint_public_access_cidrs` once initial setup and testing are done.
- **Kubernetes version**: `cluster_version` is currently pinned to `1.36` I'll need to review the EKS version support and deprecation schedule before this version reaches end of standard support.
