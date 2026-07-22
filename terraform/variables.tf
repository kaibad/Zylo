variable "aws_region" {
  description = "AWS region to deploy resources in"
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
    description= "Deployment environment (e.g., dev, staging, prod)"
    type = string
    default = "dev"
}

variable "cluster_name" {
    description = "Name of the eks cluster"
    type = string
    default = "zylo-eks"
}

variable "cluster_version"{
    description = "Kubernetes version for the EKS cluster"
    type = string
    default = "1.36"
}

# vpc

variable "vpc_cidr" {
    description = "CIDR block for the VPC"
    type = string
    default = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use (must be at least 2 for EKS)"
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets (one per AZ) — worker nodes live here"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ) — load balancers live here"
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]
}

# --- Node Group ---

variable "node_instance_type" {
  description = "EC2 instance type for EKS worker nodes"
  type        = string
  default     = "t3.medium"
}

variable "node_desired_size" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 2
}

variable "node_min_size" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 4
}

# --- Application ---

variable "docker_image_backend" {
  description = "Full Docker image reference for the Tetris app"
  type        = string
  default     = "kailashbadu/zylo-frontend"
}

variable "docker_image_frontend" {
  description = "Full Docker image reference for the Tetris app"
  type        = string
  default     = "kailashbadu/zylo-backend"
}

variable "app_replicas" {
  description = "Number of Tetris pod replicas"
  type        = number
  default     = 2
}
