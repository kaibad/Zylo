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
